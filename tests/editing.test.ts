// @vitest-environment jsdom
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component } from 'obsidian';
import { currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { diagnosticCount } from '@codemirror/lint';
import { LspManager } from '../src/lsp/LspManager';
import { CodeRenderer } from '../src/ui/pane/renderers';
import { CodeSurface } from '../src/ui/vault/CodeSurface';
import { remove, tempDir, write } from './helpers';

const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-lsp.mjs');

const cleanup: string[] = [];
const disposers: (() => void)[] = [];
afterEach(() => {
	for (const d of disposers.splice(0)) d();
	document.body.innerHTML = '';
	while (cleanup.length) remove(cleanup.pop() ?? '');
});

function renderer(): CodeRenderer {
	const owner = new Component();
	owner.load();
	disposers.push(() => owner.unload());
	return owner.addChild(new CodeRenderer(document.body.createDiv(), 13));
}

describe('editing in the code view', () => {
	it('is read-only until editing is turned on', () => {
		const code = renderer();
		code.setDocument('a\n', 'a.ts', false);
		const view = code.editor()!;
		expect(view.state.facet(EditorState.readOnly)).toBe(true);
		code.setEditable(true);
		expect(view.state.facet(EditorState.readOnly)).toBe(false);
		code.setEditable(false);
		expect(view.state.facet(EditorState.readOnly)).toBe(true);
	});

	it('reports edits, but not loading a document', () => {
		const code = renderer();
		const edits = vi.fn();
		code.onEdit(edits);
		code.setEditable(true);
		code.setDocument('first\n', 'a.ts', false);
		expect(edits).not.toHaveBeenCalled();
		code.editor()!.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
		expect(edits).toHaveBeenCalledTimes(1);
		expect(code.text()).toBe('xfirst\n');
	});

	it('cannot undo into the previously loaded file', () => {
		const code = renderer();
		code.setEditable(true);
		code.setDocument('old file\n', 'a.ts', false);
		code.setDocument('new file\n', 'b.ts', false);
		const view = code.editor()!;
		view.dispatch({ changes: { from: 0, insert: '// ' }, userEvent: 'input.type' });
		undo(view);
		undo(view);
		expect(code.text()).toBe('new file\n');
	});
});

describe('language server while editing', () => {
	async function surface() {
		const root = tempDir('heron-edit-');
		cleanup.push(root);
		write(root, 'a.ts', 'const x = 1;\nthing\n');
		const lsp = new LspManager({
			enabled: () => true,
			commands: () => ({ typescript: [process.execPath, FAKE_SERVER].map((a) => `"${a}"`).join(' ') }),
			path: () => Promise.resolve(process.env.PATH ?? ''),
		});
		const owner = new Component();
		owner.load();
		disposers.push(() => { lsp.stopAll(); owner.unload(); });
		const s = owner.addChild(new CodeSurface(document.body.createDiv(), {
			app: {} as never, lsp, fontSize: 13, wordWrap: false,
			open: () => Promise.resolve(null), label: (p) => p, onStatus: () => undefined,
		}));
		await s.show(path.join(root, 'a.ts'), 'const x = 1;\nthing\n', null);
		s.setEditable(true);
		await vi.waitFor(() => expect(s.hasCodeIntel()).toBe(true), { timeout: 5000 });
		return s;
	}

	it('offers completions from the server', async () => {
		const s = await surface();
		const view = s.code.editor()!;
		view.dispatch({ selection: { anchor: 'const x = 1;\nthing'.length } });
		startCompletion(view);
		await vi.waitFor(() => expect(currentCompletions(view.state).map((c) => c.label)).toEqual(['thingOne', 'thingTwo']), { timeout: 5000 });
	});

	it('shows the server\'s diagnostics', async () => {
		const s = await surface();
		await vi.waitFor(() => expect(diagnosticCount(s.code.editor()!.state)).toBe(1), { timeout: 5000 });
	});

	it('tracks unsaved edits until saved', async () => {
		const s = await surface();
		expect(s.isDirty).toBe(false);
		s.code.editor()!.dispatch({ changes: { from: 0, insert: '// ' }, userEvent: 'input.type' });
		expect(s.isDirty).toBe(true);
		s.markSaved();
		expect(s.isDirty).toBe(false);
	});
});
