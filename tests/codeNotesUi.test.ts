// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { LspManager } from '../src/lsp/LspManager';
import { makeAnchor } from '../src/notes/anchor';
import { MarginNote, NoteDocument } from '../src/notes/noteFormat';
import { CodeNotesStore } from '../src/services/CodeNotesStore';
import { CommentModal, CommentValues } from '../src/ui/notes/CommentModal';
import { ModelRuns } from '../src/ui/notes/ModelRuns';
import { marksAt, noteMarks } from '../src/ui/notes/noteDecorations';
import { NotesController, NotesHost } from '../src/ui/notes/NotesController';
import { NotesPanel } from '../src/ui/notes/NotesPanel';
import { placeLabel, quotePreview, renderNoteCard } from '../src/ui/notes/noteCard';
import { CodeSurface } from '../src/ui/vault/CodeSurface';
import { ModelCancelled } from '../src/model/client';
import { Modal, Notice } from './obsidian-shim';
import { memoryVault } from './memoryVault';

const ABS = '/vault/Code/heron/src/server.ts';
const TARGET = { vaultPath: 'Code/heron/src/server.ts', repo: 'Code/heron', file: 'src/server.ts' };
const NOTE_PATH = 'Code notes/heron/src/server.ts.md';

const CODE = [
	'export class Server {',
	'\tstart(port: number) {',
	'\t\tconst socket = listen(port);',
	'\t\tretryWith(socket, 3);',
	'\t}',
	'',
	'\tstop() {',
	'\t\tthis.socket.close();',
	'\t}',
	'}',
	'',
].join('\n');

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const d of disposers.splice(0)) d();
	document.body.innerHTML = '';
	Notice.messages = [];
});

function note(id: string, quote: string, overrides: Partial<MarginNote> = {}): MarginNote {
	const from = CODE.indexOf(quote);
	return {
		id, colour: 'yellow', author: 'you', tags: [], created: '2026-10-26',
		anchor: from >= 0 ? makeAnchor(CODE, from, from + quote.length) : { quote, prefix: '', suffix: '' },
		language: 'ts', body: `Note ${id}`, extra: [],
		...overrides,
	};
}

/** A code surface showing CODE, its notes controller, and the vault behind them. */
async function setup(notes: MarginNote[] = []) {
	const vault = memoryVault();
	if (notes.length) {
		const doc = NoteDocument.create({ repo: TARGET.repo, file: TARGET.file, commit: 'abc' }, '[[x]]');
		for (const n of notes) doc.add(n);
		vault.files.set(NOTE_PATH, doc.serialize());
	}
	const store = new CodeNotesStore(vault, () => 'Code notes');
	const lsp = new LspManager({ enabled: () => false, commands: () => ({}) });
	const owner = new Component();
	owner.load();
	disposers.push(() => owner.unload());
	const surface = owner.addChild(new CodeSurface(document.body.createDiv(), {
		app: {} as never, lsp, fontSize: 13, wordWrap: false,
		open: () => Promise.resolve(null), label: (p) => p, onStatus: () => undefined,
	}));
	await surface.show(ABS, CODE, null);
	const rendered: string[] = [];
	const host: NotesHost = {
		store,
		target: (absPath) => Promise.resolve(absPath === ABS ? TARGET : null),
		origin: () => Promise.resolve({ commit: 'abc', codeLink: '[[Code/heron/src/server.ts|src/server.ts]]' }),
		renderCard: (_c, entry, el) => {
			rendered.push(entry.note.id);
			el.createDiv({ text: entry.note.body });
			return () => undefined;
		},
	};
	const controller = owner.addChild(new NotesController(surface, host));
	await vi.waitFor(() => expect(controller.target).not.toBeNull());
	const view = surface.code.editor()!;
	return { vault, store, surface, controller, view, rendered, owner };
}

const textOf = (view: EditorView, id: string) => {
	const mark = noteMarks(view.state).find((m) => m.id === id);
	return mark ? view.state.sliceDoc(mark.from, mark.to) : null;
};

describe('notes in the code editor', () => {
	it('highlights each note in its colour, with a gutter badge', async () => {
		const { view, controller } = await setup([note('a', 'retryWith(socket, 3);', { colour: 'green' }), note('b', 'this.socket.close();')]);
		await vi.waitFor(() => expect(controller.notes).toHaveLength(2));
		const marks = [...view.dom.querySelectorAll<HTMLElement>('.heron-note-mark')];
		expect(marks.map((m) => m.dataset.heronNote)).toEqual(['a', 'b']);
		expect(marks[0]?.classList.contains('heron-note-green')).toBe(true);
		expect(marks[0]?.textContent).toBe('retryWith(socket, 3);');
		expect(view.dom.querySelectorAll('.heron-note-gutter .heron-note-badge:not(.heron-note-spacer)')).toHaveLength(2);
	});

	it('re-anchors when the file changes, and orphans notes whose code is gone', async () => {
		const { surface, view, controller } = await setup([note('a', 'retryWith(socket, 3);'), note('b', 'this.socket.close();')]);
		await vi.waitFor(() => expect(controller.notes).toHaveLength(2));
		// An agent rewrites the file: a header is added and stop() is removed.
		const rewritten = `// generated header\n\n${CODE.replace(/\tstop\(\) \{[\s\S]*?\t\}\n/, '')}`;
		await surface.show(ABS, rewritten, null, true);
		await vi.waitFor(() => expect(controller.notes.map((n) => [n.note.id, n.range === null])).toEqual([['a', false], ['b', true]]));
		expect(textOf(view, 'a')).toBe('retryWith(socket, 3);');
		expect(controller.notes[0]?.range?.from).toBe(rewritten.indexOf('retryWith'));
	});

	it('moves highlights along with edits as you type', async () => {
		const { view, controller } = await setup([note('a', 'retryWith(socket, 3);')]);
		await vi.waitFor(() => expect(controller.notes).toHaveLength(1));
		view.dispatch({ changes: { from: 0, insert: '// new line\n' } });
		expect(textOf(view, 'a')).toBe('retryWith(socket, 3);');
	});

	it('reloads when the note file is edited by hand', async () => {
		const { vault, controller } = await setup([note('a', 'retryWith(socket, 3);')]);
		await vi.waitFor(() => expect(controller.notes).toHaveLength(1));
		vault.files.set(NOTE_PATH, (vault.files.get(NOTE_PATH) ?? '').replace('- colour: yellow', '- colour: red'));
		expect(controller.isNoteFile(NOTE_PATH)).toBe(true);
		await controller.reload();
		expect(controller.find('a')?.colour).toBe('red');
	});

	it('adds a note on the selection, trimmed, and selects it', async () => {
		const { view, controller, vault } = await setup();
		const from = CODE.indexOf('\t\tconst socket');
		view.dispatch({ selection: { anchor: from, head: from + '\t\tconst socket = listen(port);\n'.length } });
		const range = controller.selection();
		expect(range && view.state.sliceDoc(range.from, range.to)).toBe('const socket = listen(port);');
		const added = await controller.add(range!, { colour: 'blue', author: 'you', tags: ['question'], body: 'Why here?' });
		expect(added?.anchor.quote).toBe('const socket = listen(port);');
		expect(controller.selected).toBe(added?.id);
		expect(textOf(view, added!.id)).toBe('const socket = listen(port);');
		const saved = vault.files.get(NOTE_PATH) ?? '';
		expect(saved).toContain('commit: abc');
		expect(saved).toContain('- tags: #question');
		expect(saved).toContain('```ts\nconst socket = listen(port);\n```\n\nWhy here?');
	});

	it('has no selection to comment on when only whitespace is selected', async () => {
		const { view, controller } = await setup();
		view.dispatch({ selection: { anchor: CODE.indexOf('\n\n'), head: CODE.indexOf('\n\n') + 2 } });
		expect(controller.selection()).toBeNull();
	});

	it('edits and removes notes', async () => {
		const { controller, vault } = await setup([note('a', 'retryWith(socket, 3);')]);
		await vi.waitFor(() => expect(controller.notes).toHaveLength(1));
		await controller.update('a', { body: 'Changed', colour: 'purple' });
		expect(controller.find('a')).toMatchObject({ body: 'Changed', colour: 'purple' });
		await controller.remove('a');
		expect(controller.notes).toEqual([]);
		expect(vault.files.get(NOTE_PATH)).not.toContain('## Note a');
	});

	it('selects a note from its highlight and reveals a note in the code', async () => {
		const { view, controller } = await setup([note('a', 'retryWith(socket, 3);')]);
		await vi.waitFor(() => expect(controller.notes).toHaveLength(1));
		const pos = CODE.indexOf('retryWith') + 2;
		expect(marksAt(view.state, pos).map((m) => m.id)).toEqual(['a']);
		const changes: string[] = [];
		controller.onChange((c) => changes.push(c));
		expect(controller.reveal('a')).toBe(true);
		expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('retryWith(socket, 3);');
		expect(controller.selected).toBe('a');
		expect(changes).toContain('selection');
	});
});

describe('Code notes panel', () => {
	function panel(controller: NotesController) {
		const host = { app: {} as never, openInNote: vi.fn(), edit: vi.fn(), remove: vi.fn(), focusCode: vi.fn() };
		const el = document.body.createDiv();
		const p = new NotesPanel(el, host);
		p.load();
		disposers.push(() => p.unload());
		p.bind(controller);
		return { el, host, panel: p };
	}

	it('lists cards in file order with orphaned notes last', async () => {
		const { controller } = await setup([
			note('late', 'this.socket.close();'),
			note('gone', 'deleted();', { anchor: { quote: 'deleted();', prefix: '', suffix: '' } }),
			note('early', 'const socket = listen(port);', { author: 'model', tags: ['explain'] }),
		]);
		await vi.waitFor(() => expect(controller.notes).toHaveLength(3));
		const { el } = panel(controller);
		const cards = [...el.querySelectorAll<HTMLElement>('.heron-note-card')];
		expect(cards.map((c) => c.dataset.noteId)).toEqual(['early', 'late', 'gone']);
		expect(el.querySelector('.heron-panel-title')?.textContent).toBe('server.ts');
		expect(cards[0]?.querySelector('.heron-note-author')?.textContent).toBe('Model');
		expect(cards[0]?.querySelector('.heron-note-tag')?.textContent).toBe('#explain');
		expect(cards[0]?.querySelector('.heron-note-place')?.textContent).toBe('Line 3');
		expect(cards[2]?.querySelector('.heron-note-place')?.textContent).toBe('Orphaned');
		expect(cards[2]?.classList.contains('is-orphaned')).toBe(true);
		expect(el.querySelector('.heron-notes-orphaned-title')).not.toBeNull();
		expect(cards[0]?.querySelector('.heron-note-body')?.textContent).toBe('Note early');
	});

	it('jumps to the code when a card is selected, and follows the selected note', async () => {
		const { controller, view } = await setup([note('a', 'retryWith(socket, 3);'), note('b', 'this.socket.close();')]);
		await vi.waitFor(() => expect(controller.notes).toHaveLength(2));
		const { el, host } = panel(controller);
		el.querySelector<HTMLElement>('[data-note-id="b"]')?.click();
		expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('this.socket.close();');
		expect(host.focusCode).toHaveBeenCalledWith(controller);
		expect(el.querySelector('[data-note-id="b"]')?.classList.contains('is-selected')).toBe(true);
		controller.select('a');
		expect(el.querySelector('[data-note-id="a"]')?.classList.contains('is-selected')).toBe(true);
		expect(el.querySelector('[data-note-id="b"]')?.classList.contains('is-selected')).toBe(false);
		el.querySelector<HTMLElement>('[data-note-id="a"] .heron-note-open')?.click();
		expect(host.openInNote).toHaveBeenCalledWith(controller, 'a');
	});

	it('explains how to add notes when there are none', async () => {
		const { controller } = await setup();
		const { el } = panel(controller);
		expect(el.querySelector('.heron-panel-empty')?.textContent).toMatch(/Select code and choose Comment/);
	});
});

describe('note cards', () => {
	it('show where a note is and a short quote', () => {
		const entry = { note: note('a', 'x'), range: { from: 30, to: 40, quality: 'fuzzy' as const } };
		expect(placeLabel(entry, () => 4)).toBe('Line 5 · approximate');
		expect(placeLabel({ ...entry, range: null }, () => 0)).toBe('Orphaned');
		expect(quotePreview('\t\ta();\n\t\tb();\n\t\t\tc();\n\t\td();')).toBe('a();\nb();\n\tc();\n…');
		const owner = new Component();
		const card = renderNoteCard(document.body, note('a', 'retryWith(socket, 3);', { body: '' }), { app: {} as never, owner, sourcePath: '', place: 'Line 4' });
		expect(card.querySelector('.heron-note-body')).toBeNull();
	});
});

describe('CommentModal', () => {
	it('collects a colour, text and tags', () => {
		const submitted: CommentValues[] = [];
		const modal = new CommentModal({} as never, '\t\tconst socket = listen(port);', (v) => submitted.push(v));
		modal.onOpen();
		expect(modal.contentEl.querySelector('.heron-note-quote')?.textContent).toBe('const socket = listen(port);');
		modal.contentEl.querySelector<HTMLElement>('[aria-label="Green"]')?.click();
		const body = modal.contentEl.querySelector('textarea')!;
		body.value = '  Why here?  ';
		body.dispatchEvent(new Event('input'));
		const tags = modal.contentEl.querySelector<HTMLInputElement>('input')!;
		tags.value = '#question, perf';
		tags.dispatchEvent(new Event('input'));
		[...modal.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Save')?.click();
		expect(submitted).toEqual([{ colour: 'green', body: 'Why here?', tags: ['question', 'perf'] }]);
		expect(Modal.closed).toContain(modal);
	});

	it('starts from an existing note when editing', () => {
		const modal = new CommentModal({} as never, 'x', () => undefined, { colour: 'red', body: 'Old', tags: ['a'] }, 'Edit note');
		modal.onOpen();
		expect(modal.titleEl.textContent).toBe('Edit note');
		expect(modal.contentEl.querySelector('textarea')?.value).toBe('Old');
		expect(modal.contentEl.querySelector('[aria-label="Red"]')?.getAttribute('aria-checked')).toBe('true');
	});
});

describe('ModelRuns', () => {
	function runs() {
		const statusEls: HTMLElement[] = [];
		const r = new ModelRuns(() => {
			const el = document.body.createDiv();
			statusEls.push(el);
			return el;
		});
		r.load();
		disposers.push(() => r.unload());
		return { runs: r, statusEls };
	}

	it('shows progress until the action finishes', async () => {
		const { runs: r, statusEls } = runs();
		let report: (m: string) => void = () => undefined;
		let finish: (v: string) => void = () => undefined;
		const pending = r.run('Explaining selection', (_signal, progress) => {
			report = progress;
			return new Promise<string>((resolve) => { finish = resolve; });
		});
		expect(r.active).toBe(1);
		report('Waiting for the model…');
		expect(Notice.shown.at(-1)?.noticeEl.textContent).toContain('Explaining selection: Waiting for the model…');
		expect(statusEls[0]?.textContent).toBe('Explaining selection: Waiting for the model…');
		finish('done');
		await expect(pending).resolves.toBe('done');
		expect(r.active).toBe(0);
		expect(statusEls[0]?.isConnected).toBe(false);
		expect(Notice.shown).toHaveLength(0);
	});

	it('reports failures and cancels from the notice', async () => {
		const { runs: r } = runs();
		await expect(r.run('Drawing this file', () => Promise.reject(new Error('Claude Code failed')))).resolves.toBeNull();
		expect(Notice.messages).toContain('Drawing this file failed: Claude Code failed');
		const pending = r.run('Finding similar code', (signal) => new Promise((_, reject) => {
			signal.addEventListener('abort', () => reject(new ModelCancelled()));
		}));
		Notice.shown.at(-1)?.noticeEl.querySelector<HTMLElement>('.heron-model-cancel')?.click();
		await expect(pending).resolves.toBeNull();
		expect(Notice.messages).toContain('Finding similar code cancelled');
	});

	it('cancels everything when unloaded', async () => {
		const { runs: r } = runs();
		const pending = r.run('Explaining selection', (signal) => new Promise((_, reject) => {
			signal.addEventListener('abort', () => reject(new ModelCancelled()));
		}));
		expect(r.cancelAll()).toBe(1);
		await expect(pending).resolves.toBeNull();
	});
});
