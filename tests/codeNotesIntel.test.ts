// @vitest-environment jsdom
import { mkdirSync, renameSync } from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component } from 'obsidian';
import { LspManager } from '../src/lsp/LspManager';
import { hoverText } from '../src/lsp/requests';
import type { ModelRequest } from '../src/model/client';
import { CodeNotesStore } from '../src/services/CodeNotesStore';
import { explainSelection } from '../src/services/modelActions';
import { actionSource, ModelActionsUi } from '../src/ui/notes/modelActionsUi';
import { ModelRuns } from '../src/ui/notes/ModelRuns';
import { DEFAULT_MODEL_SETTINGS } from '../src/notes/settings';
import type { LocationModal } from '../src/ui/locationModals';
import { Modal, Notice } from './obsidian-shim';
import { NotesController } from '../src/ui/notes/NotesController';
import { codeTarget, toVaultPath } from '../src/ui/notes/vaultNotes';
import { CodeSurface } from '../src/ui/vault/CodeSurface';
import { makeRepo, remove, tempDir } from './helpers';
import { memoryVault } from './memoryVault';

const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-lsp.mjs');

const cleanup: string[] = [];
const disposers: (() => void)[] = [];
afterEach(() => {
	for (const d of disposers.splice(0)) d();
	document.body.innerHTML = '';
	while (cleanup.length) remove(cleanup.pop() ?? '');
});

const A_TS = 'import { thing } from "./target";\nthing();\n';

/** A vault folder holding a repository at `Code/proj`, shown in a surface with the fake language server. */
async function setup() {
	const vault = tempDir('heron-vault-');
	cleanup.push(vault);
	const root = path.join(vault, 'Code', 'proj');
	mkdirSync(path.dirname(root), { recursive: true });
	renameSync(makeRepo({ 'a.ts': A_TS, 'target.ts': '// target\n\nexport function thing() {}\n' }), root);
	const lsp = new LspManager({
		enabled: () => true,
		commands: () => ({ typescript: [process.execPath, FAKE_SERVER].map((a) => `"${a}"`).join(' ') }),
		path: () => Promise.resolve(process.env.PATH ?? ''),
	});
	const owner = new Component();
	owner.load();
	disposers.push(() => { lsp.stopAll(); owner.unload(); });
	const surface = owner.addChild(new CodeSurface(document.body.createDiv(), {
		app: {} as never, lsp, fontSize: 13, wordWrap: false,
		open: () => Promise.resolve(null), label: (p) => p, onStatus: () => undefined,
	}));
	const absPath = path.join(root, 'a.ts');
	await surface.show(absPath, A_TS, null);
	await vi.waitFor(() => expect(surface.hasCodeIntel()).toBe(true), { timeout: 5000 });
	const notes = memoryVault();
	const controller = owner.addChild(new NotesController(surface, {
		store: new CodeNotesStore(notes, () => 'Code notes'),
		target: (p) => codeTarget(vault, p),
		origin: () => Promise.resolve({ commit: '', codeLink: '' }),
		renderCard: () => () => undefined,
	}));
	await vi.waitFor(() => expect(controller.target).not.toBeNull());
	return { vault, root, surface, controller, absPath, notes, owner };
}

describe('model actions against a real repository and language server', () => {
	it('finds the code file\'s repository inside the vault', async () => {
		const { controller } = await setup();
		expect(controller.target).toEqual({ vaultPath: 'Code/proj/a.ts', repo: 'Code/proj', file: 'a.ts' });
		expect(controller.notePath).toBe('Code notes/proj/a.ts.md');
		expect(toVaultPath('/vault', '/elsewhere/x.ts')).toBeNull();
	});

	it('gives raw access to the file\'s language server', async () => {
		const { surface } = await setup();
		const server = await surface.server();
		expect(server?.uri).toMatch(/a\.ts$/);
		expect(server?.supports('hoverProvider')).toBe(true);
		expect(server?.supports('callHierarchyProvider')).toBe(false);
		const hover = await server?.request('textDocument/hover', { textDocument: { uri: server.uri }, position: { line: 1, character: 1 } });
		expect(hoverText(hover)).toBe('**fake hover**');
	});

	it('searches the repository with git grep and reads other files', async () => {
		const { controller, vault, root } = await setup();
		const source = actionSource(controller, vault);
		const hits = await source!.grep('thing', 10);
		expect(hits.map((h) => `${path.basename(h.absPath)}:${h.line}`).sort()).toEqual(['a.ts:0', 'a.ts:1', 'target.ts:2']);
		expect((await source!.readLines(path.join(root, 'target.ts')))?.[2]).toBe('export function thing() {}');
		expect(source!.label(path.join(root, 'target.ts'))).toBe('Code/proj/target.ts');
	});

	it('explains a selection with the server\'s hover and definition', async () => {
		const { controller, vault } = await setup();
		const requests: ModelRequest[] = [];
		const model = { complete: (req: ModelRequest) => { requests.push(req); return Promise.resolve('Calls `thing`.'); } };
		const from = A_TS.indexOf('thing();');
		const body = await explainSelection(actionSource(controller, vault)!, { from, to: from + 8 }, { model });
		expect(body).toBe('Calls `thing`.');
		expect(requests[0]?.prompt).toContain('- `thing`, defined at Code/proj/target.ts:3');
		expect(requests[0]?.prompt).toContain('Hover: **fake hover**');
	});
});

describe('model actions as the user runs them', () => {
	function actions(s: Awaited<ReturnType<typeof setup>>, reply: string, enabled = true) {
		const runs = s.owner.addChild(new ModelRuns(() => document.body.createDiv()));
		const requests: ModelRequest[] = [];
		const host = {
			app: {} as never,
			settings: () => ({ ...DEFAULT_MODEL_SETTINGS, enabled }),
			notesFolder: () => 'Code notes',
			base: () => s.vault,
			runs,
			open: vi.fn(),
			showPanel: vi.fn(),
			makeClient: () => ({ complete: (req: ModelRequest) => { requests.push(req); return Promise.resolve(reply); } }),
		};
		return { ui: new ModelActionsUi(host), host, requests };
	}

	afterEach(() => { Modal.opened = []; Notice.messages = []; });

	it('saves an explanation as a model note tagged #explain', async () => {
		const s = await setup();
		const { ui, host } = actions(s, 'Calls `thing` once.');
		const view = s.surface.code.editor()!;
		const from = A_TS.indexOf('thing();');
		view.dispatch({ selection: { anchor: from, head: from + 8 } });
		await ui.explain(s.controller);
		const note = s.controller.notes[0]?.note;
		expect(note).toMatchObject({ author: 'model', tags: ['explain'], colour: 'blue', body: 'Calls `thing` once.', anchor: { quote: 'thing();' } });
		expect(s.notes.files.get('Code notes/proj/a.ts.md')).toContain('- author: model');
		expect(host.showPanel).toHaveBeenCalled();
	});

	it('asks to turn model actions on first, and needs a selection', async () => {
		const s = await setup();
		const off = actions(s, 'x', false);
		const view = s.surface.code.editor()!;
		await off.ui.explain(s.controller);
		expect(Notice.messages).toContain('Select code to explain');
		view.dispatch({ selection: { anchor: 0, head: 6 } });
		await off.ui.explain(s.controller);
		expect(Notice.messages).toContain('Turn on model actions in the plugin settings first');
		expect(off.requests).toHaveLength(0);
	});

	it('shows similar code in a picker with the reasons the model gave', async () => {
		const s = await setup();
		const { ui, requests } = actions(s, '[{"id": 1, "reason": "Same call."}]');
		const view = s.surface.code.editor()!;
		const from = A_TS.indexOf('thing();');
		view.dispatch({ selection: { anchor: from, head: from + 8 } });
		await ui.findSimilar(s.controller);
		expect(requests[0]?.prompt).toContain('[1] Code/proj/');
		const modal = Modal.opened.at(-1) as unknown as LocationModal;
		expect(modal.getItems()).toHaveLength(1);
		expect(modal.getItems()[0]?.detail).toBe('Same call.');
		expect(modal.getItems()[0]?.title).toMatch(/^Code\/proj\/.*:\d+$/);
	});
});
