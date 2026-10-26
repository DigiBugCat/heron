// @vitest-environment jsdom
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component } from 'obsidian';
import type { Position } from '../src/lsp/locations';
import { answerServerRequest, LspManager } from '../src/lsp/LspManager';
import type { LocationModal } from '../src/ui/locationModals';
import { CodeSurface } from '../src/ui/vault/CodeSurface';
import { remove, tempDir, write } from './helpers';
import { Modal } from './obsidian-shim';

const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-lsp.mjs');
const node = (...args: string[]) => [process.execPath, FAKE_SERVER, ...args].map((a) => `"${a}"`).join(' ');

const cleanup: string[] = [];
const roots: Component[] = [];
const managers: LspManager[] = [];
afterEach(() => {
	for (const m of managers.splice(0)) m.stopAll();
	for (const c of roots.splice(0)) c.unload();
	document.body.innerHTML = '';
	Modal.opened = [];
	while (cleanup.length) remove(cleanup.pop() ?? '');
});

function manager(command: string, failures: string[] = []): LspManager {
	const m = new LspManager({
		enabled: () => true,
		commands: () => ({ typescript: command }),
		onFailure: (_name, message) => failures.push(message),
		path: () => Promise.resolve(process.env.PATH ?? ''),
	});
	managers.push(m);
	return m;
}

function project(): string {
	const root = tempDir('heron-lsp-');
	cleanup.push(root);
	write(root, 'a.ts', 'import { thing } from "./target";\nthing();\n');
	write(root, 'target.ts', '// target\n\nexport function thing() {}\n');
	return root;
}

describe('LspManager', () => {
	it('starts a server, reports it ready and forwards requests', async () => {
		const root = project();
		const m = manager(node());
		const target = await m.connect(path.join(root, 'a.ts'), root);
		expect(target?.session.status).toEqual({ kind: 'ready', name: path.basename(process.execPath) });
		expect(m.status(path.join(root, 'a.ts'), root)?.kind).toBe('ready');
		const def = await target?.session.client.request<unknown, { uri: string }>('textDocument/definition', {
			textDocument: { uri: 'file:///x' }, position: { line: 0, character: 0 },
		});
		expect(def?.uri).toMatch(/target\.ts$/);
	});

	it('reports a server that is not installed, without retrying immediately', async () => {
		const root = project();
		const failures: string[] = [];
		const m = manager('heron-no-such-server --stdio', failures);
		expect(await m.connect(path.join(root, 'a.ts'), root)).toBeNull();
		expect(failures).toEqual(['heron-no-such-server was not found']);
		expect(await m.connect(path.join(root, 'a.ts'), root)).toBeNull();
		expect(failures).toHaveLength(1);
		expect(m.status(path.join(root, 'a.ts'), root)?.kind).toBe('failed');
	});

	it('reports a server that exits during startup, with its stderr', async () => {
		const root = project();
		const failures: string[] = [];
		expect(await manager(node('--crash'), failures).connect(path.join(root, 'a.ts'), root)).toBeNull();
		expect(failures[0]).toMatch(/exited with code 3: fake-lsp: crashing on purpose/);
	});

	it('answers progress requests and reports work in progress until it ends', async () => {
		const root = project();
		const m = manager(node('--progress'));
		const statuses: string[] = [];
		m.onChange(() => statuses.push(JSON.stringify(m.status(path.join(root, 'a.ts'), root))));
		const target = await m.connect(path.join(root, 'a.ts'), root);
		await vi.waitFor(() => expect(m.status(path.join(root, 'a.ts'), root)).toMatchObject({ kind: 'ready', busy: 'Indexing' }));
		await m.whenIdle(target!.session, 5000);
		expect(m.status(path.join(root, 'a.ts'), root)).toEqual({ kind: 'ready', name: path.basename(process.execPath) });
		expect(statuses.some((s) => s.includes('"busy":"Indexing"'))).toBe(true);
	});

	it('answers the server requests it supports and leaves others to the client', () => {
		expect(answerServerRequest('window/workDoneProgress/create', { token: 1 })).toEqual({ result: null });
		expect(answerServerRequest('workspace/configuration', { items: [{}, {}] })).toEqual({ result: [null, null] });
		expect(answerServerRequest('workspace/applyEdit', {})).toBeNull();
	});

	it('stops server processes when asked', async () => {
		const root = project();
		const pidFile = path.join(root, 'pid');
		process.env.FAKE_LSP_PID_FILE = pidFile;
		try {
			const m = manager(node());
			await m.connect(path.join(root, 'a.ts'), root);
			const pid = Number(readFileSync(pidFile, 'utf-8'));
			m.stopAll();
			expect(m.status(path.join(root, 'a.ts'), root)).toBeNull();
			await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
		} finally {
			delete process.env.FAKE_LSP_PID_FILE;
		}
	});
});

describe('code navigation in a code tab', () => {
	/**
	 * A code tab without Obsidian: `open` shows another file in the same
	 * surface, as a tab does, and records where the tab was the way
	 * Obsidian's history keeps a tab's ephemeral state, so `back` returns there.
	 */
	function tab(root: string, lsp: LspManager) {
		const owner = new Component();
		owner.load();
		roots.push(owner);
		const history: { absPath: string; cursor: Position | null }[] = [];
		const show = (absPath: string, cursor: Position | null) => surface.show(absPath, readFileSync(absPath, 'utf-8'), cursor);
		const surface: CodeSurface = owner.addChild(new CodeSurface(document.body.createDiv(), {
			app: {} as never,
			lsp,
			fontSize: 13,
			wordWrap: false,
			open: async (loc) => {
				if (surface.absPath) history.push({ absPath: surface.absPath, cursor: surface.code.cursor() });
				await show(loc.absPath, loc.position);
				return surface;
			},
			label: (absPath) => path.relative(root, absPath),
			onStatus: () => undefined,
		}));
		const back = async () => {
			const previous = history.pop();
			if (previous) await show(previous.absPath, previous.cursor);
		};
		return { surface, show, back, history };
	}

	/** Navigation waits up to a second for a newly started server to settle. */
	const wait = { timeout: 5000 };

	it('jumps to a definition in another file and comes back', async () => {
		const root = project();
		const { surface, show, back, history } = tab(root, manager(node()));
		await show(path.join(root, 'a.ts'), null);
		await vi.waitFor(() => expect(surface.status?.kind).toBe('ready'), wait);
		expect(surface.hasCodeIntel()).toBe(true);
		expect(history).toHaveLength(0);

		surface.goTo('definition');
		await vi.waitFor(() => expect(surface.absPath).toBe(path.join(root, 'target.ts')), wait);
		expect(surface.code.cursor()).toEqual({ line: 2, character: 4 });
		expect(history).toEqual([{ absPath: path.join(root, 'a.ts'), cursor: { line: 0, character: 0 } }]);

		await back();
		expect(surface.absPath).toBe(path.join(root, 'a.ts'));
		expect(surface.code.cursor()).toEqual({ line: 0, character: 0 });
	});

	it('lists references with file:line titles and line previews', async () => {
		const root = project();
		const { surface, show } = tab(root, manager(node()));
		await show(path.join(root, 'a.ts'), null);
		await vi.waitFor(() => expect(surface.hasCodeIntel()).toBe(true), wait);

		surface.findReferences();
		await vi.waitFor(() => expect(Modal.opened).toHaveLength(1), wait);
		const modal = Modal.opened[0] as LocationModal;
		expect(modal.getItems().map((i) => [i.title, i.detail])).toEqual([
			['target.ts:3', 'export function thing() {}'],
			['a.ts:1', 'import { thing } from "./target";'],
		]);
	});

	it('lists the symbols of the shown file', async () => {
		const root = project();
		const { surface, show } = tab(root, manager(node()));
		await show(path.join(root, 'a.ts'), null);
		await vi.waitFor(() => expect(surface.hasCodeIntel()).toBe(true), wait);

		surface.goToSymbolInFile();
		await vi.waitFor(() => expect(Modal.opened).toHaveLength(1), wait);
		const modal = Modal.opened[0] as LocationModal;
		expect(modal.getItems().map((i) => [i.title, i.detail])).toEqual([
			['Outer', 'class · line 1'],
			['inner', 'method · Outer · line 2'],
		]);
	});

	it('shows no status and no navigation for files without a server', async () => {
		const root = project();
		write(root, 'notes.md', '# hi\n');
		const { surface, show } = tab(root, manager(node()));
		await show(path.join(root, 'notes.md'), null);
		expect(surface.status).toBeNull();
		expect(surface.hasCodeIntel()).toBe(false);
		expect(existsSync(path.join(root, 'notes.md'))).toBe(true);
	});
});
