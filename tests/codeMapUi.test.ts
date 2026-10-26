// @vitest-environment jsdom
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal, Notice, TextFileView, TFile, TFolder } from './obsidian-shim';
import type { App, TFile as RealFile, TFolder as RealFolder } from 'obsidian';
import { codeMapMeta, parseCanvas, stableId } from '../src/codemap/canvas';
import { CodeMaps } from '../src/ui/codemap/CodeMaps';
import { FolderSuggestModal, LargeMapModal, mappableFolders } from '../src/ui/codemap/modals';
import type { CursorRequest } from '../src/ui/pane/codeIntel';
import { git, remove, tempDir, write } from './helpers';

/** Just enough of Obsidian's vault and workspace for code maps. */
class FakeApp {
	texts = new Map<string, string>();
	entries = new Map<string, TFile | TFolder>();
	opened: TFile[] = [];
	canvasViews: TextFileView[] = [];
	vault = {
		getName: () => 'Vault',
		getRoot: () => this.folder('/'),
		getAbstractFileByPath: (p: string) => this.entries.get(p) ?? null,
		getAllFolders: () => [...this.entries.values()].filter((e): e is TFolder => e instanceof TFolder && e.path !== '/'),
		read: async (f: TFile) => this.texts.get(f.path) ?? '',
		modify: async (f: TFile, text: string) => { this.texts.set(f.path, text); },
		create: async (p: string, text: string) => {
			const file = new TFile(p);
			this.entries.set(p, file);
			this.texts.set(p, text);
			return file;
		},
		createFolder: async (p: string) => this.folder(p),
	};
	workspace = {
		getLeavesOfType: (type: string) => (type === 'canvas' ? this.canvasViews.map((view) => ({ view })) : []),
		getLeaf: () => ({ openFile: async (f: TFile) => { this.opened.push(f); } }),
		revealLeaf: async (leaf: { view: TextFileView }) => { if (leaf.view.file) this.opened.push(leaf.view.file); },
	};

	/** The folder at `p`, typed as Obsidian's (the shim stands in at runtime). */
	folder(p: string): RealFolder {
		const existing = this.entries.get(p);
		const folder = existing instanceof TFolder ? existing : new TFolder(p);
		this.entries.set(p, folder);
		return folder as unknown as RealFolder;
	}

	file(p: string): RealFile {
		const file = new TFile(p);
		this.entries.set(p, file);
		return file as unknown as RealFile;
	}
}

let vault = '';
let app: FakeApp;
let maps: CodeMaps;

beforeEach(() => {
	vault = tempDir('heron-vault-');
	write(vault, 'Code/app/src/main.ts', 'import { run } from "./app";\nexport function main() {}\n');
	write(vault, 'Code/app/src/app.ts', 'export function run() {}\n');
	git(path.join(vault, 'Code/app'), 'init', '-q');
	git(path.join(vault, 'Code/app'), 'add', '-A');
	git(path.join(vault, 'Code/app'), 'commit', '-q', '-m', 'init');
	write(vault, 'Code/app/src/new.ts', 'import "./main";\n');
	app = new FakeApp();
	for (const p of ['Code', 'Code/app', 'Code/app/src', 'Code/app/node_modules', 'Code/app/.git', 'Notes']) app.folder(p);
	maps = new CodeMaps({ app: app as unknown as App, folder: () => 'Code maps', basePath: () => vault, git: () => null });
	Modal.opened = [];
	Notice.messages = [];
});

afterEach(() => remove(vault));

const canvasOf = (p: string) => parseCanvas(app.texts.get(p) ?? '');

describe('code maps in the vault', () => {
	it('writes a code map canvas for a folder and opens it', async () => {
		await maps.generate(app.folder('Code/app'));
		expect(app.entries.get('Code maps')).toBeInstanceOf(TFolder);
		const canvas = canvasOf('Code maps/app.canvas');
		expect(codeMapMeta(canvas)).toEqual({ kind: 'code-map', version: 1, source: 'Code/app', level: 'files' });
		const main = canvas?.nodes.find((n) => n.id === stableId('f', 'src/main.ts'));
		expect(main?.text).toContain('[[Code/app/src/main.ts|main.ts]]');
		// Untracked, so new: green.
		expect(canvas?.nodes.find((n) => n.id === stableId('f', 'src/new.ts'))?.color).toBe('4');
		expect(app.opened.map((f) => f.path)).toEqual(['Code maps/app.canvas']);
		expect(Notice.messages).toEqual(['Mapped 3 files and 2 imports of app']);
		expect(maps.isCodeMap(app.entries.get('Code maps/app.canvas') as never)).toBe(true);
	});

	it('updates the open map, saving the canvas view first and keeping moved cards', async () => {
		await maps.generate(app.folder('Code/app'));
		const file = app.entries.get('Code maps/app.canvas');
		if (!(file instanceof TFile)) throw new Error('no canvas');
		const canvas = canvasOf(file.path);
		const moved = { ...canvas, nodes: canvas?.nodes.map((n) => (n.id === stableId('f', 'src/app.ts') ? { ...n, x: 3000, y: 4000 } : n)) };
		app.texts.set(file.path, JSON.stringify(moved));
		const view = new TextFileView();
		view.file = file;
		app.canvasViews.push(view);
		write(vault, 'Code/app/src/later.ts', 'import "./app";\n');

		await maps.update(file as never);
		expect(view.saves).toBeGreaterThan(0);
		const updated = canvasOf(file.path);
		expect(updated?.nodes.find((n) => n.id === stableId('f', 'src/app.ts'))).toMatchObject({ x: 3000, y: 4000 });
		expect(updated?.nodes.some((n) => n.id === stableId('f', 'src/later.ts'))).toBe(true);
		expect(app.texts.has('Code maps/app 2.canvas')).toBe(false);
	});

	it('does not overwrite a map of another folder with the same name', async () => {
		await maps.generate(app.folder('Code/app'));
		write(vault, 'Other/app/x.py', 'import os\n');
		app.folder('Other');
		await maps.generate(app.folder('Other/app'));
		expect(codeMapMeta(canvasOf('Code maps/app.canvas'))?.source).toBe('Code/app');
		expect(codeMapMeta(canvasOf('Code maps/app 2.canvas'))?.source).toBe('Other/app');
	});

	it('reports folders without source files and canvases that are not maps', async () => {
		await maps.generate(app.folder('Notes'));
		expect(Notice.messages).toEqual(['No TypeScript, JavaScript, Python, Go or Rust files in Notes']);
		const plain = await app.vault.create('Board.canvas', '{"nodes":[],"edges":[]}');
		await maps.update(plain as never);
		expect(Notice.messages[1]).toBe('This canvas is not a code map');
	});

	it('asks how to map a large folder', async () => {
		for (let i = 0; i < 160; i++) write(vault, `Big/pkg${i % 8}/m${i}.py`, i ? 'from pkg0 import m0\n' : '');
		await maps.generate(app.folder('Big'));
		expect(Modal.opened).toHaveLength(1);
		const modal = Modal.opened[0] as LargeMapModal;
		expect(modal).toBeInstanceOf(LargeMapModal);
		modal.onOpen();
		expect(modal.contentEl.textContent).toContain('Big has 160 source files');
		const buttons = [...modal.contentEl.querySelectorAll('button')];
		expect(buttons.map((b) => b.textContent)).toEqual(['Map all files', 'Choose a subfolder…', 'Map folders']);
		buttons[2]?.click();
		await vi.waitFor(() => expect(codeMapMeta(canvasOf('Code maps/Big.canvas'))?.level).toBe('folders'));
		expect(canvasOf('Code maps/Big.canvas')?.nodes.filter((n) => n.id.startsWith('heron-d-'))).toHaveLength(8);

		Modal.opened = [];
		app.folder('Big/pkg0');
		await maps.generate(app.folder('Big'));
		(Modal.opened[0] as LargeMapModal).onOpen();
		(Modal.opened[0] as LargeMapModal).contentEl.querySelectorAll('button')[1]?.click();
		const picker = Modal.opened[1] as FolderSuggestModal;
		expect(picker).toBeInstanceOf(FolderSuggestModal);
		expect(picker.getItems().map((f) => f.path)).toEqual(['Big/pkg0']);
	});

	it('offers only folders worth mapping', () => {
		app.folder('Code/app/node_modules/dep');
		expect(mappableFolders(app as unknown as App).map((f) => f.path)).toEqual(['Code', 'Code/app', 'Code/app/src', 'Notes']);
		expect(mappableFolders(app as unknown as App, app.folder('Code')).map((f) => f.path)).toEqual(['Code/app', 'Code/app/src']);
	});

	it('maps the repository of the active file, or asks for a folder when there is none', () => {
		const spy = vi.spyOn(maps, 'generate').mockResolvedValue();
		const withRepos = new CodeMaps({
			app: app as unknown as App,
			folder: () => 'Code maps',
			basePath: () => vault,
			git: () => ({ vaultRepos: () => [{ rel: 'Code/app' }] }) as never,
		});
		const repoSpy = vi.spyOn(withRepos, 'generate').mockResolvedValue();
		withRepos.generateForRepository(app.file('Code/app/src/main.ts'));
		expect(repoSpy).toHaveBeenCalledWith(app.folder('Code/app'));
		maps.generateForRepository(null);
		expect(spy).not.toHaveBeenCalled();
		expect(Notice.messages).toEqual(['No Git repositories found in the vault. Choose a folder to map instead.']);
		expect(Modal.opened[0]).toBeInstanceOf(FolderSuggestModal);
	});

	it('draws a call graph from the language server', async () => {
		app.file('Code/app/src/main.ts');
		app.file('Code/app/src/app.ts');
		const uri = (f: string) => `file://${path.join(vault, 'Code/app/src', f)}`;
		const item = (name: string, f: string, line: number) => ({ name, kind: 12, uri: uri(f), range: { start: { line, character: 0 }, end: { line, character: 1 } }, selectionRange: { start: { line, character: 16 }, end: { line, character: 20 } } });
		const main = item('main', 'main.ts', 1);
		const run = item('run', 'app.ts', 0);
		const cursor: CursorRequest = {
			supports: () => true,
			textDocument: { uri: uri('main.ts') },
			position: { line: 1, character: 17 },
			absPath: path.join(vault, 'Code/app/src/main.ts'),
			request: async (method) => {
				if (method === 'textDocument/prepareCallHierarchy') return [main];
				if (method === 'callHierarchy/outgoingCalls') return [{ to: run, fromRanges: [] }];
				return [];
			},
		};
		await maps.showCallGraph(async () => cursor);
		const canvas = canvasOf('Code maps/Call graph - main.canvas');
		expect(codeMapMeta(canvas)).toEqual({ kind: 'call-graph', version: 1, source: 'Code/app/src/main.ts#main', level: 'calls' });
		expect(canvas?.nodes.filter((n) => n.type === 'text').map((n) => n.text?.split('\n')[1])).toEqual(expect.arrayContaining([
			'function · [[Code/app/src/main.ts|main.ts]] · line 2',
			'function · [[Code/app/src/app.ts|app.ts]] · line 1',
		]));
		expect(canvas?.edges).toHaveLength(1);

		await maps.showCallGraph(async () => ({ ...cursor, supports: () => false }));
		expect(Notice.messages).toContain('This language server cannot show call graphs');
	});
});
