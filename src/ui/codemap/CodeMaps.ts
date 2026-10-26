import { App, Notice, TextFileView, TFile, TFolder } from 'obsidian';
import * as path from 'path';
import { callMapModel } from '../../codemap/callMap';
import { CodeMapMeta, codeMapMeta, mergeCanvas, parseCanvas, renderMap, stringifyCanvas } from '../../codemap/canvas';
import { MAX_FILE_NODES } from '../../codemap/graph';
import type { MapChange } from '../../codemap/models';
import { buildCallGraph } from '../../lsp/callHierarchy';
import { buildCodeMap, CodeMapListing, listCodeMapFiles, mapChanges } from '../../services/CodeMapSource';
import type { CursorRequest } from '../pane/codeIntel';
import type { ExplorerGit } from '../vault/ExplorerGit';
import { FolderSuggestModal, LargeMapChoice, LargeMapModal, mappableFolders } from './modals';

export interface CodeMapHost {
	app: App;
	/** Vault folder code maps are saved in. */
	folder(): string;
	/** The vault's folder on disk. */
	basePath(): string;
	git(): ExplorerGit | null;
}

/** Characters not allowed in file names on some systems, or that break links. */
const BAD_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g;
const MAX_NAME_TRIES = 50;

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Generates and updates code maps (canvases of a folder's files and their
 * imports) and call graphs, and writes them to the vault.
 */
export class CodeMaps {
	/** Paths of canvases known to be code maps, so commands can offer to update them. */
	private known = new Set<string>();

	constructor(private host: CodeMapHost) {}

	private get app(): App {
		return this.host.app;
	}

	/** True when `file` is (or may be) a code map: Heron made it, or it is in the code maps folder. */
	isCodeMap(file: TFile | null): boolean {
		if (!file || file.extension !== 'canvas') return false;
		return this.known.has(file.path) || file.path.startsWith(`${this.host.folder()}/`);
	}

	/** Remembers whether an opened canvas is a code map. */
	async noticeOpened(file: TFile | null) {
		if (!file || file.extension !== 'canvas' || this.known.has(file.path)) return;
		if (codeMapMeta(parseCanvas(await this.app.vault.read(file)))) this.known.add(file.path);
	}

	/** Lets the user pick a folder of the vault to map (inside `within`, if given). */
	pickFolder(within: TFolder | null = null) {
		const folders = mappableFolders(this.app, within);
		new FolderSuggestModal(this.app, folders, within ? `Choose a folder in ${within.path}…` : 'Choose a folder to map…', (f) => { void this.generate(f); }).open();
	}

	/** Maps the repository holding `file`; with none, lets the user pick one of the vault's repositories. */
	generateForRepository(file: TFile | null) {
		const repos = this.host.git()?.vaultRepos().map((r) => r.rel) ?? [];
		const repo = file ? repos.filter((rel) => file.path.startsWith(`${rel}/`)).sort((a, b) => b.length - a.length)[0] : undefined;
		const folder = repo ? this.app.vault.getAbstractFileByPath(repo) : null;
		if (folder instanceof TFolder) {
			void this.generate(folder);
			return;
		}
		const folders = repos.map((rel) => this.app.vault.getAbstractFileByPath(rel)).filter((f): f is TFolder => f instanceof TFolder);
		if (!folders.length) {
			new Notice('No Git repositories found in the vault. Choose a folder to map instead.');
			this.pickFolder();
			return;
		}
		if (folders.length === 1 && folders[0]) {
			void this.generate(folders[0]);
			return;
		}
		new FolderSuggestModal(this.app, folders, 'Choose a repository to map…', (f) => { void this.generate(f); }).open();
	}

	/**
	 * Maps `folder` to a canvas. Without a `level`, a folder with many
	 * files asks whether to map its folders or a subfolder instead.
	 */
	async generate(folder: TFolder, options: { level?: 'files' | 'folders'; target?: TFile } = {}) {
		const name = this.labelFor(folder);
		let listing: CodeMapListing;
		try {
			listing = await listCodeMapFiles(path.join(this.host.basePath(), folder.path));
		} catch (err) {
			new Notice(`Cannot map ${name}: ${errorText(err)}`);
			return;
		}
		if (!listing.sources.length) {
			new Notice(`No TypeScript, JavaScript, Python, Go or Rust files in ${name}`);
			return;
		}
		if (options.level || listing.sources.length <= MAX_FILE_NODES) {
			await this.write(folder, listing, options.level ?? 'files', options.target);
			return;
		}
		new LargeMapModal(this.app, name, listing.sources.length, MAX_FILE_NODES, (choice: LargeMapChoice) => {
			if (choice === 'subfolder') this.pickFolder(folder);
			else void this.write(folder, listing, choice, options.target);
		}).open();
	}

	/** Regenerates the code map `file`, keeping the cards the user moved. */
	async update(file: TFile) {
		const meta = codeMapMeta(parseCanvas(await this.readLatest(file)));
		if (!meta) {
			new Notice('This canvas is not a code map');
			return;
		}
		if (meta.kind === 'call-graph') {
			new Notice('To redraw a call graph, show it again from the code.');
			return;
		}
		const folder = meta.source ? this.app.vault.getAbstractFileByPath(meta.source) : this.app.vault.getRoot();
		if (!(folder instanceof TFolder)) {
			new Notice(`The mapped folder ${meta.source} no longer exists`);
			return;
		}
		await this.generate(folder, { level: meta.level === 'folders' ? 'folders' : 'files', target: file });
	}

	/** Draws the calls to and from the symbol at the cursor, using the language server. */
	async showCallGraph(cursor: () => Promise<CursorRequest | null>) {
		const ctx = await cursor();
		if (!ctx) return;
		if (!ctx.supports('callHierarchyProvider')) {
			new Notice('This language server cannot show call graphs');
			return;
		}
		const graph = await buildCallGraph((method, params) => ctx.request(method, params), ctx.textDocument, ctx.position);
		const root = graph?.items.find((i) => i.key === graph.root);
		if (!graph || !root) {
			new Notice('No function or method found here');
			return;
		}
		const model = callMapModel(graph, {
			vaultPath: (abs) => this.vaultPath(abs),
			label: (abs) => this.vaultPath(abs) ?? path.basename(abs),
		});
		const source = `${(root.absPath && this.vaultPath(root.absPath)) ?? root.absPath ?? ''}#${root.name}`;
		const meta: CodeMapMeta = { kind: 'call-graph', version: 1, source, level: 'calls' };
		const target = await this.targetFor(meta, `Call graph - ${root.name}`);
		const previous = target.file ? parseCanvas(await this.readLatest(target.file)) : null;
		const text = stringifyCanvas(mergeCanvas(previous, renderMap(model, meta)));
		const file = await this.save(target, text);
		await this.open(file);
		if (graph.truncated) new Notice(`Call graph of ${root.name} shows the nearest ${graph.items.length} symbols`);
	}

	private labelFor(folder: TFolder): string {
		return folder.isRoot() ? this.app.vault.getName() : folder.name;
	}

	private async write(folder: TFolder, listing: CodeMapListing, level: 'files' | 'folders', target?: TFile) {
		const name = this.labelFor(folder);
		const source = folder.isRoot() ? '' : folder.path;
		try {
			const dest = target ? { path: target.path, file: target } : await this.targetFor({ kind: 'code-map', version: 1, source, level }, name);
			const result = await buildCodeMap({
				listing,
				level,
				folderVaultPath: source,
				rootLabel: name,
				changes: await this.changes(listing),
				previous: dest.file ? await this.readLatest(dest.file) : null,
				now: new Date(),
			});
			const file = await this.save(dest, result.text);
			await this.open(file);
			const limited = listing.truncated ? ` (the first ${listing.sources.length})` : '';
			new Notice(`Mapped ${result.files} files${limited} and ${result.imports} imports of ${name}`);
		} catch (err) {
			new Notice(`Cannot map ${name}: ${errorText(err)}`);
		}
	}

	/** Git changes of the listing's repository, from the explorer's tracking when it has it. */
	private async changes(listing: CodeMapListing): Promise<Map<string, MapChange>> {
		const tracked = this.host.git()?.vaultRepos().find((r) => r.snapshot.kind === 'repo' && r.snapshot.repo.root === listing.root);
		if (tracked?.snapshot.kind === 'repo') return mapChanges(tracked.snapshot.status.files);
		if (!listing.repo) return new Map();
		try {
			return mapChanges((await listing.repo.status()).files);
		} catch {
			return new Map();
		}
	}

	/**
	 * Where a map is saved: `<folder>/<name>.canvas`, or with a number added
	 * when that name holds a map of something else.
	 */
	private async targetFor(meta: CodeMapMeta, name: string): Promise<{ path: string; file: TFile | null }> {
		const dir = this.host.folder();
		const base = name.replace(BAD_NAME_CHARS, '-').trim() || 'Code map';
		for (let n = 1; n <= MAX_NAME_TRIES; n++) {
			const candidate = `${dir}/${base}${n > 1 ? ` ${n}` : ''}.canvas`;
			const existing = this.app.vault.getAbstractFileByPath(candidate);
			if (!existing) return { path: candidate, file: null };
			if (!(existing instanceof TFile)) continue;
			const found = codeMapMeta(parseCanvas(await this.app.vault.read(existing)));
			if (found?.kind === meta.kind && found.source === meta.source) return { path: candidate, file: existing };
		}
		throw new Error(`too many maps named ${base}`);
	}

	/** The canvas's text, after saving any edits still pending in an open canvas view. */
	private async readLatest(file: TFile): Promise<string> {
		for (const leaf of this.app.workspace.getLeavesOfType('canvas')) {
			const view = leaf.view;
			if (view instanceof TextFileView && view.file === file) await view.save();
		}
		return this.app.vault.read(file);
	}

	private async save(target: { path: string; file: TFile | null }, text: string): Promise<TFile> {
		let file = target.file;
		if (file) {
			await this.app.vault.modify(file, text);
		} else {
			const dir = path.posix.dirname(target.path);
			if (dir !== '.' && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
			file = await this.app.vault.create(target.path, text);
		}
		this.known.add(file.path);
		return file;
	}

	/** Shows the canvas, in the tab that already shows it if there is one. */
	private async open(file: TFile) {
		const { workspace } = this.app;
		const leaf = workspace.getLeavesOfType('canvas').find((l) => l.view instanceof TextFileView && l.view.file === file);
		if (leaf) await workspace.revealLeaf(leaf);
		else await workspace.getLeaf('tab').openFile(file);
	}

	/** Vault path of a file on disk, or null when it is not a file in the vault. */
	private vaultPath(absPath: string): string | null {
		const base = this.host.basePath();
		if (!base) return null;
		const rel = path.relative(base, absPath);
		if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
		const vaultRel = rel.split(path.sep).join('/');
		return this.app.vault.getAbstractFileByPath(vaultRel) instanceof TFile ? vaultRel : null;
	}
}
