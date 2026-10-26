// @vitest-environment jsdom
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component } from 'obsidian';
import { answerServerRequest, LspManager } from '../src/lsp/LspManager';
import type { LocationModal } from '../src/ui/locationModals';
import { ContentPane } from '../src/ui/pane/ContentPane';
import type { CodeRenderer } from '../src/ui/pane/renderers';
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

describe('ContentPane code navigation', () => {
	function pane(root: string, lsp: LspManager): ContentPane {
		const owner = new Component();
		owner.load();
		roots.push(owner);
		return owner.addChild(new ContentPane(document.body.createDiv(), {
			fontSize: 13,
			app: {} as never,
			lsp,
			getRoot: () => root,
			getFolder: () => root,
		}));
	}

	/** Navigation waits up to a second for a newly started server to settle. */
	const wait = { timeout: 5000 };
	const cursor = (p: ContentPane) => (p as unknown as { current: CodeRenderer }).current.cursor();

	it('jumps to a definition in another file and comes back', async () => {
		const root = project();
		const p = pane(root, manager(node()));
		await p.showFile(path.join(root, 'a.ts'), 'a.ts');
		await vi.waitFor(() => expect(document.querySelector('.so-lsp-status.is-ready')).not.toBeNull(), wait);
		expect(p.hasCodeIntel()).toBe(true);
		expect(p.canGoBack()).toBe(false);

		p.goTo('definition');
		// currentPath() changes when loading starts; the label once it is rendered.
		await vi.waitFor(() => expect(document.querySelector('.so-path-label')?.textContent).toBe('target.ts'), wait);
		expect(cursor(p)).toEqual({ line: 2, character: 4 });
		expect(p.canGoBack()).toBe(true);
		expect(document.querySelector('.so-nav-back')?.hasAttribute('disabled')).toBe(false);

		p.goBack();
		await vi.waitFor(() => expect(document.querySelector('.so-path-label')?.textContent).toBe('a.ts'), wait);
		expect(cursor(p)).toEqual({ line: 0, character: 0 });
		expect(p.canGoForward()).toBe(true);
	});

	it('lists references with file:line titles and line previews', async () => {
		const root = project();
		const p = pane(root, manager(node()));
		await p.showFile(path.join(root, 'a.ts'), 'a.ts');
		await vi.waitFor(() => expect(p.hasCodeIntel()).toBe(true), wait);

		p.findReferences();
		await vi.waitFor(() => expect(Modal.opened).toHaveLength(1), wait);
		const modal = Modal.opened[0] as LocationModal;
		expect(modal.getItems().map((i) => [i.title, i.detail])).toEqual([
			['target.ts:3', 'export function thing() {}'],
			['a.ts:1', 'import { thing } from "./target";'],
		]);
	});

	it('lists the symbols of the shown file', async () => {
		const root = project();
		const p = pane(root, manager(node()));
		await p.showFile(path.join(root, 'a.ts'), 'a.ts');
		await vi.waitFor(() => expect(p.hasCodeIntel()).toBe(true), wait);

		p.goToSymbolInFile();
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
		const p = pane(root, manager(node()));
		await p.showFile(path.join(root, 'notes.md'), 'notes.md');
		expect(document.querySelector('.so-lsp-status')?.textContent).toBe('');
		expect(p.hasCodeIntel()).toBe(false);
		expect(existsSync(path.join(root, 'notes.md'))).toBe(true);
	});
});
