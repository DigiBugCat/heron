// @vitest-environment jsdom
/**
 * Checks against real language servers: the dev dependencies
 * `typescript-language-server` and `basedpyright`, or the folder in
 * HERON_LSP_PATH. Skipped when neither is available.
 */
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component } from 'obsidian';
import { LspManager } from '../src/lsp/LspManager';
import { mergePaths } from '../src/lsp/shellEnv';
import type { LocationModal } from '../src/ui/locationModals';
import { ContentPane } from '../src/ui/pane/ContentPane';
import { CodeSurface } from '../src/ui/vault/CodeSurface';
import { currentCompletions, startCompletion } from '@codemirror/autocomplete';
import type { CodeRenderer } from '../src/ui/pane/renderers';
import { remove, tempDir, write } from './helpers';
import { Modal } from './obsidian-shim';

const REPO = path.resolve(__dirname, '..');
const LOCAL_BIN = path.join(REPO, 'node_modules', '.bin');
const extraPath = process.env.HERON_LSP_PATH
	?? (existsSync(path.join(LOCAL_BIN, 'typescript-language-server')) && existsSync(path.join(LOCAL_BIN, 'basedpyright-langserver')) ? LOCAL_BIN : undefined);

const cleanup: string[] = [];
const disposers: (() => void)[] = [];
afterEach(() => {
	for (const d of disposers.splice(0)) d();
	document.body.innerHTML = '';
	Modal.opened = [];
	while (cleanup.length) remove(cleanup.pop() ?? '');
});

function setup(root: string): { pane: ContentPane; code: () => CodeRenderer } {
	const lsp = new LspManager({
		enabled: () => true,
		commands: () => ({}),
		path: () => Promise.resolve(mergePaths(extraPath ?? '', process.env.PATH ?? '')),
	});
	const owner = new Component();
	owner.load();
	const pane = owner.addChild(new ContentPane(document.body.createDiv(), {
		fontSize: 13, app: {} as never, lsp, getRoot: () => root, getFolder: () => root,
	}));
	disposers.push(() => { lsp.stopAll(); owner.unload(); });
	return { pane, code: () => (pane as unknown as { current: CodeRenderer }).current };
}

/** Zero-based position of `needle` on the first line that contains `lineMarker`. */
function find(file: string, lineMarker: string, needle: string) {
	const lines = readFileSync(file, 'utf-8').split('\n');
	const line = lines.findIndex((l) => l.includes(lineMarker));
	return { line, character: (lines[line] ?? '').indexOf(needle) };
}

const label = () => document.querySelector('.so-path-label')?.textContent;

describe.skipIf(!extraPath)('real language servers', () => {
	it('typescript-language-server: definition across files, references and back', async () => {
		const file = path.join(REPO, 'src/ui/pane/ContentPane.ts');
		const { pane, code } = setup(REPO);
		await pane.showFile(file, 'src/ui/pane/ContentPane.ts');
		await vi.waitFor(() => expect(pane.hasCodeIntel()).toBe(true), { timeout: 30000 });

		// Asked right away: the first answer must wait until tsserver has loaded the project.
		code().moveCursor(find(file, 'new CodeIntel(', 'CodeIntel'));
		pane.goTo('definition');
		await vi.waitFor(() => expect(label()).toBe('src/ui/pane/codeIntel.ts'), { timeout: 30000 });
		expect(code().cursor()).toEqual(find(path.join(REPO, 'src/ui/pane/codeIntel.ts'), 'export class CodeIntel', 'CodeIntel'));

		await vi.waitFor(() => expect(pane.hasCodeIntel()).toBe(true), { timeout: 30000 });
		pane.findReferences();
		await vi.waitFor(() => expect(Modal.opened).toHaveLength(1), { timeout: 30000 });
		const titles = (Modal.opened[0] as LocationModal).getItems().map((i) => i.title);
		expect(titles.some((t) => t.startsWith('src/ui/pane/ContentPane.ts:'))).toBe(true);

		pane.goBack();
		await vi.waitFor(() => expect(label()).toBe('src/ui/pane/ContentPane.ts'));
	}, 90000);

	it('basedpyright: definition in another module', async () => {
		const root = tempDir('heron-py-');
		cleanup.push(root);
		write(root, 'helpers.py', '"""Helpers."""\n\n\ndef greet(name: str) -> str:\n    return f"hi {name}"\n');
		write(root, 'main.py', 'from helpers import greet\n\nprint(greet("heron"))\n');
		const { pane, code } = setup(root);
		await pane.showFile(path.join(root, 'main.py'), 'main.py');
		await vi.waitFor(() => expect(pane.hasCodeIntel()).toBe(true), { timeout: 30000 });

		code().moveCursor({ line: 2, character: 7 });
		pane.goTo('definition');
		await vi.waitFor(() => expect(label()).toBe('helpers.py'), { timeout: 30000 });
		expect(code().cursor()).toEqual({ line: 3, character: 4 });
	}, 90000);

	async function editableSurface(root: string, file: string, text: string) {
		const lsp = new LspManager({
			enabled: () => true,
			commands: () => ({}),
			path: () => Promise.resolve(mergePaths(extraPath ?? '', process.env.PATH ?? '')),
		});
		const owner = new Component();
		owner.load();
		disposers.push(() => { lsp.stopAll(); owner.unload(); });
		const surface = owner.addChild(new CodeSurface(document.body.createDiv(), {
			app: {} as never, lsp, fontSize: 13, wordWrap: false,
			open: () => Promise.resolve(null), label: (p) => p, onStatus: () => undefined,
		}));
		write(root, file, text);
		await surface.show(path.join(root, file), text, null);
		surface.setEditable(true);
		await vi.waitFor(() => expect(surface.hasCodeIntel()).toBe(true), { timeout: 30000 });
		return surface;
	}

	async function completionsAfterTyping(surface: CodeSurface, typed: string): Promise<string[]> {
		const view = surface.code.editor()!;
		const end = view.state.doc.length;
		view.dispatch({ changes: { from: end, insert: typed }, selection: { anchor: end + typed.length }, userEvent: 'input.type' });
		startCompletion(view);
		let labels: string[] = [];
		await vi.waitFor(() => {
			labels = currentCompletions(view.state).map((c) => c.label);
			expect(labels.length).toBeGreaterThan(0);
		}, { timeout: 30000 });
		return labels;
	}

	it('typescript-language-server: completes members of a string', async () => {
		const root = tempDir('heron-ts-');
		cleanup.push(root);
		const surface = await editableSurface(root, 'a.ts', 'const greeting = "hi";\n');
		expect(await completionsAfterTyping(surface, 'greeting.toUpp')).toContain('toUpperCase');
	}, 90000);

	it('basedpyright: completes a module attribute', async () => {
		const root = tempDir('heron-py-');
		cleanup.push(root);
		const surface = await editableSurface(root, 'main.py', 'import os\n');
		expect(await completionsAfterTyping(surface, 'os.pa')).toContain('path');
	}, 90000);
});
