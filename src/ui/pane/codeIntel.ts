import { App, Component, Notice, Platform } from 'obsidian';
import { pathToFileURL } from 'url';
import { hoverTooltips, LSPClient, LSPPlugin, serverCompletion, signatureHelp } from '@codemirror/lsp-client';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { FileLocation, flattenDocumentSymbols, pathOfUri, toFileLocations, workspaceSymbols } from '../../lsp/locations';
import type { LspManager, LspSession, LspStatus } from '../../lsp/LspManager';
import type { ServerAccess } from '../../lsp/requests';
import { readViewableFile } from '../../utils/content';
import { LatestRequest } from '../../utils/latest';
import { LocationItem, LocationModal, WorkspaceSymbolModal } from '../locationModals';
import { NavHistory } from './navHistory';
import type { CodeRenderer } from './renderers';

/** What the code view gives `CodeIntel` to work with. */
export interface CodeIntelHost {
	app: App | null;
	/** The file shown as code and its renderer, if any. */
	current(): { absPath: string; code: CodeRenderer } | null;
	/** Shows `loc` and returns the renderer showing it, or null if it could not be shown. */
	open(loc: FileLocation): Promise<CodeRenderer | null>;
	/** Project root that language servers are started in. */
	root(): string | null;
	/** Short name for a file, relative to the opened folder when inside it. */
	label(absPath: string): string;
	onStatus(status: LspStatus | null): void;
	onHistoryChange(): void;
}

export type JumpKind = 'definition' | 'typeDefinition' | 'implementation' | 'declaration';

const JUMP_LABEL: Record<JumpKind, string> = {
	definition: 'definition',
	typeDefinition: 'type definition',
	implementation: 'implementation',
	declaration: 'declaration',
};

/** Longest wait for a server that reports it is still loading before asking anyway. */
const MAX_IDLE_WAIT_MS = 15000;
/** References beyond this are not shown. */
const MAX_REFERENCES = 1000;
/** Files read for reference previews; references in further files show without a preview. */
const MAX_PREVIEW_FILES = 200;
const MAX_PREVIEW_CHARS = 160;
const MAX_WORKSPACE_SYMBOLS = 200;

interface RequestContext {
	client: LSPClient;
	textDocument: { uri: string };
	position: { line: number; character: number };
	from: FileLocation;
}

/** False only when the server said it lacks `capability` (e.g. `referencesProvider`). */
function supports(client: LSPClient, capability: string): boolean {
	const caps = client.serverCapabilities as Record<string, unknown> | null;
	return !caps || !!caps[capability];
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Language server features for the code view: hover, go to definition and
 * friends, find references, symbol search, and back/forward history. Heron
 * shows one file at a time, so cross-file jumps re-use the same editor.
 */
export class CodeIntel extends Component {
	private attached: { absPath: string; code: CodeRenderer; session: LspSession } | null = null;
	private request = new LatestRequest();
	private history = new NavHistory<FileLocation>(
		(a, b) => a.absPath === b.absPath && a.position.line === b.position.line,
	);

	constructor(private manager: LspManager | null, private host: CodeIntelHost) {
		super();
	}

	onload() {
		const manager = this.manager;
		if (manager) this.register(manager.onChange(() => this.serverChanged()));
	}

	/** Connects the file now shown in `code` to its language server, if one applies. */
	async attach(code: CodeRenderer, absPath: string) {
		const token = this.request.next();
		this.attached = null;
		const root = this.host.root();
		if (!this.manager || !root || !this.manager.choose(absPath)) {
			this.host.onStatus(null);
			return;
		}
		const target = await this.manager.connect(absPath, root);
		if (!this.request.isCurrent(token)) return;
		this.reportStatus();
		const shown = this.host.current();
		if (!target || shown?.code !== code || shown.absPath !== absPath) return;
		target.session.workspace.display = (uri) => this.display(uri);
		code.setLanguageServer([
			target.session.client.plugin(pathToFileURL(absPath).href, target.choice.languageId),
			hoverTooltips({ hoverTime: 350 }),
			// Inert while the editor is read-only: both react to typing.
			serverCompletion(),
			signatureHelp(),
			this.bindings(),
		]);
		this.attached = { absPath, code, session: target.session };
	}

	/** Forgets the attached file, e.g. when a diff replaces the code view. */
	detach() {
		this.request.cancel();
		this.attached = null;
		this.host.onStatus(null);
	}

	canGoBack(): boolean { return this.history.canGoBack(); }

	canGoForward(): boolean { return this.history.canGoForward(); }

	async goBack() {
		const current = this.currentLocation();
		const target = current && this.history.back(current);
		if (!target) return;
		this.host.onHistoryChange();
		await this.navigate(target);
	}

	async goForward() {
		const current = this.currentLocation();
		const target = current && this.history.forward(current);
		if (!target) return;
		this.host.onHistoryChange();
		await this.navigate(target);
	}

	/** True when the shown file has a running language server. */
	isAvailable(): boolean {
		const shown = this.host.current();
		return !!this.attached && shown?.code === this.attached.code && shown.absPath === this.attached.absPath;
	}

	/** Jumps to the definition (or declaration, type, implementation) of the symbol at the cursor. */
	async goTo(kind: JumpKind) {
		const ctx = await this.context();
		if (!ctx) return;
		const label = JUMP_LABEL[kind];
		if (!supports(ctx.client, `${kind}Provider`)) {
			new Notice(`This language server cannot find the ${label}`);
			return;
		}
		let locations: FileLocation[];
		try {
			locations = toFileLocations(await ctx.client.request(`textDocument/${kind}`, {
				textDocument: ctx.textDocument,
				position: ctx.position,
			}));
		} catch (err) {
			new Notice(`Cannot go to ${label}: ${errorText(err)}`);
			return;
		}
		const first = locations[0];
		if (!first) {
			new Notice(`No ${label} found`);
			return;
		}
		// Several results in one file (e.g. a class and its constructor): go to the first.
		if (locations.every((loc) => loc.absPath === first.absPath)) {
			await this.jump(ctx.from, first);
			return;
		}
		this.pick(await this.withPreviews(locations), `Choose a ${label}…`, ctx.from);
	}

	/** Lists every reference to the symbol at the cursor. */
	async findReferences() {
		const ctx = await this.context();
		if (!ctx) return;
		if (!supports(ctx.client, 'referencesProvider')) {
			new Notice('This language server cannot find references');
			return;
		}
		let locations: FileLocation[];
		try {
			locations = toFileLocations(await ctx.client.request('textDocument/references', {
				textDocument: ctx.textDocument,
				position: ctx.position,
				context: { includeDeclaration: true },
			}));
		} catch (err) {
			new Notice(`Cannot find references: ${errorText(err)}`);
			return;
		}
		if (!locations.length) {
			new Notice('No references found');
			return;
		}
		const shown = locations.slice(0, MAX_REFERENCES);
		const suffix = locations.length > shown.length ? ` (first ${shown.length})` : '';
		this.pick(await this.withPreviews(shown), `${locations.length} references${suffix}`, ctx.from);
	}

	/**
	 * The raw `textDocument/documentSymbol` response for the shown file, or
	 * null when there is no server or it failed. Quiet: for panels, not commands.
	 */
	async documentSymbols(): Promise<unknown> {
		const attached = this.attached;
		if (!attached || !this.manager || !this.isAvailable()) return null;
		await this.manager.whenIdle(attached.session, MAX_IDLE_WAIT_MS);
		const view = attached.code.editor();
		const plugin = view && LSPPlugin.get(view);
		if (this.attached !== attached || !plugin || !supports(plugin.client, 'documentSymbolProvider')) return null;
		try {
			plugin.client.sync();
			return await plugin.client.request('textDocument/documentSymbol', { textDocument: { uri: plugin.uri } });
		} catch {
			return null;
		}
	}

	/**
	 * The shown file's language server, synced with the editor, for features
	 * that make their own requests; null without one. Quiet, like `documentSymbols`.
	 */
	async server(): Promise<ServerAccess | null> {
		const attached = this.attached;
		if (!attached || !this.manager || !this.isAvailable()) return null;
		await this.manager.whenIdle(attached.session, MAX_IDLE_WAIT_MS);
		const view = attached.code.editor();
		const plugin = view && LSPPlugin.get(view);
		if (this.attached !== attached || !plugin) return null;
		plugin.client.sync();
		const client = plugin.client;
		return {
			uri: plugin.uri,
			supports: (capability) => supports(client, capability),
			request: (method, params) => client.request(method, params),
		};
	}

	/** Lists the symbols in the shown file. */
	async goToSymbolInFile() {
		const ctx = await this.context();
		const attached = this.attached;
		if (!ctx || !attached) return;
		if (!supports(ctx.client, 'documentSymbolProvider')) {
			new Notice('This language server cannot list symbols');
			return;
		}
		let symbols;
		try {
			symbols = flattenDocumentSymbols(
				await ctx.client.request('textDocument/documentSymbol', { textDocument: ctx.textDocument }),
				attached.absPath,
			);
		} catch (err) {
			new Notice(`Cannot list symbols: ${errorText(err)}`);
			return;
		}
		if (!symbols.length) {
			new Notice('No symbols in this file');
			return;
		}
		const items = symbols.map((s): LocationItem => ({
			...s,
			title: s.name,
			detail: [s.kind, s.container, `line ${s.position.line + 1}`].filter(Boolean).join(' · '),
		}));
		this.pick(items, 'Go to symbol in file…', ctx.from);
	}

	/** Searches symbols across the project. */
	async goToSymbolInProject() {
		const ctx = await this.context();
		const app = this.host.app;
		if (!ctx || !app) return;
		if (!supports(ctx.client, 'workspaceSymbolProvider')) {
			new Notice('This language server cannot search symbols');
			return;
		}
		const search = async (query: string): Promise<LocationItem[]> => {
			try {
				const response = await ctx.client.request('workspace/symbol', { query });
				return workspaceSymbols(response, MAX_WORKSPACE_SYMBOLS).map((s) => ({
					...s,
					title: s.name,
					detail: [s.kind, s.container, `${this.host.label(s.absPath)}:${s.position.line + 1}`].filter(Boolean).join(' · '),
				}));
			} catch {
				return [];
			}
		};
		new WorkspaceSymbolModal(app, search, (item) => { void this.jump(ctx.from, item); }).open();
	}

	/** What a request needs, after waiting for a server that is still loading. */
	private async context(): Promise<RequestContext | null> {
		const attached = this.attached;
		if (attached && this.manager && this.isAvailable()) {
			await this.manager.whenIdle(attached.session, MAX_IDLE_WAIT_MS);
			if (this.attached !== attached) return null;
		}
		const view = attached?.code.editor();
		const plugin = view && LSPPlugin.get(view);
		const cursor = attached?.code.cursor();
		if (!attached || !this.isAvailable() || !view || !plugin || !cursor) {
			new Notice(this.unavailableMessage());
			return null;
		}
		plugin.client.sync();
		return {
			client: plugin.client,
			textDocument: { uri: plugin.uri },
			// Same as plugin.toPosition: zero-based line and UTF-16 column.
			position: cursor,
			from: { absPath: attached.absPath, position: cursor },
		};
	}

	private unavailableMessage(): string {
		const shown = this.host.current();
		const root = this.host.root();
		if (!shown) return 'Open a file to use code navigation';
		const status = this.manager && root ? this.manager.status(shown.absPath, root) : null;
		if (status?.kind === 'starting') return `${status.name} is still starting`;
		if (status?.kind === 'failed') return `${status.name} is not available: ${status.message}`;
		return 'No language server for this file. Check Heron\'s settings.';
	}

	private async jump(from: FileLocation | null, to: FileLocation) {
		if (from) {
			this.history.record(from);
			this.host.onHistoryChange();
		}
		await this.navigate(to);
	}

	private async navigate(to: FileLocation) {
		const shown = this.host.current();
		const code = shown?.absPath === to.absPath ? shown.code : await this.host.open(to);
		if (!code) return;
		if (shown?.code === code && shown.absPath === to.absPath) code.moveCursor(to.position);
		code.editor()?.focus();
	}

	/** Where the cursor is now, for history. */
	private currentLocation(): FileLocation | null {
		const shown = this.host.current();
		const position = shown?.code.cursor();
		return shown && position ? { absPath: shown.absPath, position } : null;
	}

	/** Used by the language server client when it needs to show another file. */
	private async display(uri: string): Promise<EditorView | null> {
		const absPath = pathOfUri(uri);
		if (!absPath) return null;
		const code = await this.host.open({ absPath, position: { line: 0, character: 0 } });
		return code?.editor() ?? null;
	}

	private pick(items: LocationItem[], placeholder: string, from: FileLocation) {
		const app = this.host.app;
		if (!app) return;
		new LocationModal(app, items, placeholder, (item) => { void this.jump(from, item); }).open();
	}

	/** Adds `file:line` titles and the text of each line, reading each file once. */
	private async withPreviews(locations: FileLocation[]): Promise<LocationItem[]> {
		const lines = new Map<string, string[] | null>();
		for (const { absPath } of locations) {
			if (lines.has(absPath) || lines.size >= MAX_PREVIEW_FILES) continue;
			const content = await readViewableFile(absPath);
			lines.set(absPath, content.kind === 'text' ? content.text.split(/\r\n?|\n/) : null);
		}
		return locations.map((loc) => ({
			...loc,
			title: `${this.host.label(loc.absPath)}:${loc.position.line + 1}`,
			detail: (lines.get(loc.absPath)?.[loc.position.line] ?? '').trim().slice(0, MAX_PREVIEW_CHARS),
		}));
	}

	/** F12 / Shift+F12 and Mod+click inside the code view. */
	private bindings(): Extension {
		return [
			keymap.of([
				{ key: 'F12', run: () => { void this.goTo('definition'); return true; } },
				{ key: 'Shift-F12', run: () => { void this.findReferences(); return true; } },
			]),
			EditorView.domEventHandlers({
				mousedown: (event, view) => {
					const modifier = Platform.isMacOS ? event.metaKey : event.ctrlKey;
					if (event.button !== 0 || !modifier) return false;
					const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
					if (pos === null) return false;
					event.preventDefault();
					view.dispatch({ selection: { anchor: pos } });
					void this.goTo('definition');
					return true;
				},
			}),
		];
	}

	private reportStatus() {
		const shown = this.host.current();
		const root = this.host.root();
		this.host.onStatus(shown && root && this.manager ? this.manager.status(shown.absPath, root) : null);
	}

	/** A server started, stopped or failed: update the status and re-attach if ours went away. */
	private serverChanged() {
		const attached = this.attached;
		if (attached && this.manager && !this.manager.isLive(attached.session)) {
			this.attached = null;
			attached.code.setLanguageServer(null);
			const shown = this.host.current();
			if (shown?.code === attached.code && shown.absPath === attached.absPath) void this.attach(attached.code, attached.absPath);
		}
		this.reportStatus();
	}
}
