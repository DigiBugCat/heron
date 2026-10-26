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
import type { Position } from '../src/lsp/locations';
import type { LocationModal } from '../src/ui/locationModals';
import { CodeSurface } from '../src/ui/vault/CodeSurface';
import { currentCompletions, startCompletion } from '@codemirror/autocomplete';
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

/**
 * A code tab without Obsidian: `open` shows another file in the same
 * surface, as a tab does, and `back` returns to where the tab was, as
 * Obsidian's history does with the tab's ephemeral state.
 */
function setup(root: string) {
	const lsp = new LspManager({
		enabled: () => true,
		commands: () => ({}),
		path: () => Promise.resolve(mergePaths(extraPath ?? '', process.env.PATH ?? '')),
	});
	const owner = new Component();
	owner.load();
	const history: { absPath: string; cursor: Position | null }[] = [];
	const show = (absPath: string, cursor: Position | null = null) => surface.show(absPath, readFileSync(absPath, 'utf-8'), cursor);
	const surface: CodeSurface = owner.addChild(new CodeSurface(document.body.createDiv(), {
		app: {} as never, lsp, fontSize: 13, wordWrap: false,
		open: async (loc) => {
			if (surface.absPath) history.push({ absPath: surface.absPath, cursor: surface.code.cursor() });
			await show(loc.absPath, loc.position);
			return surface;
		},
		label: (p) => path.relative(root, p),
		onStatus: () => undefined,
	}));
	disposers.push(() => { lsp.stopAll(); owner.unload(); });
	const back = async () => {
		const previous = history.pop();
		if (previous) await show(previous.absPath, previous.cursor);
	};
	return { surface, show, back };
}

/** Zero-based position of `needle` on the first line that contains `lineMarker`. */
function find(file: string, lineMarker: string, needle: string) {
	const lines = readFileSync(file, 'utf-8').split('\n');
	const line = lines.findIndex((l) => l.includes(lineMarker));
	return { line, character: (lines[line] ?? '').indexOf(needle) };
}


describe.skipIf(!extraPath)('real language servers', () => {
	it('typescript-language-server: definition across files, references and back', async () => {
		const file = path.join(REPO, 'src/ui/vault/CodeSurface.ts');
		const { surface, show, back } = setup(REPO);
		await show(file);
		await vi.waitFor(() => expect(surface.hasCodeIntel()).toBe(true), { timeout: 30000 });

		// Asked right away: the first answer must wait until tsserver has loaded the project.
		surface.moveCursor(find(file, 'new CodeIntel(', 'CodeIntel'));
		surface.goTo('definition');
		const target = path.join(REPO, 'src/ui/pane/codeIntel.ts');
		await vi.waitFor(() => expect(surface.absPath).toBe(target), { timeout: 30000 });
		expect(surface.code.cursor()).toEqual(find(target, 'export class CodeIntel', 'CodeIntel'));

		await vi.waitFor(() => expect(surface.hasCodeIntel()).toBe(true), { timeout: 30000 });
		surface.findReferences();
		await vi.waitFor(() => expect(Modal.opened).toHaveLength(1), { timeout: 30000 });
		const titles = (Modal.opened[0] as LocationModal).getItems().map((i) => i.title);
		expect(titles.some((t) => t.startsWith('src/ui/vault/CodeSurface.ts:'))).toBe(true);

		await back();
		expect(surface.absPath).toBe(file);
	}, 90000);

	it('basedpyright: definition in another module', async () => {
		const root = tempDir('heron-py-');
		cleanup.push(root);
		write(root, 'helpers.py', '"""Helpers."""\n\n\ndef greet(name: str) -> str:\n    return f"hi {name}"\n');
		write(root, 'main.py', 'from helpers import greet\n\nprint(greet("heron"))\n');
		const { surface, show } = setup(root);
		await show(path.join(root, 'main.py'));
		await vi.waitFor(() => expect(surface.hasCodeIntel()).toBe(true), { timeout: 30000 });

		surface.moveCursor({ line: 2, character: 7 });
		surface.goTo('definition');
		await vi.waitFor(() => expect(surface.absPath).toBe(path.join(root, 'helpers.py')), { timeout: 30000 });
		expect(surface.code.cursor()).toEqual({ line: 3, character: 4 });
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
