import { describe, expect, it, vi } from 'vitest';
import type { MarginNote } from '../src/notes/noteFormat';
import { CodeNotesStore, NotesVault } from '../src/services/CodeNotesStore';
import { renderDiagramNote } from '../src/notes/diagramNote';

/** A vault in a map, like Obsidian's but synchronous underneath. */
export function memoryVault(files: Map<string, string> = new Map()): NotesVault & { files: Map<string, string> } {
	return {
		files,
		read: (path) => Promise.resolve(files.get(path) ?? null),
		create: (path, text) => {
			if (files.has(path)) return Promise.reject(new Error('File already exists.'));
			files.set(path, text);
			return Promise.resolve();
		},
		process: (path, fn) => {
			const text = files.get(path);
			if (text === undefined) return Promise.reject(new Error('missing'));
			files.set(path, fn(text));
			return Promise.resolve();
		},
		exists: (path) => files.has(path),
	};
}

const TARGET = { vaultPath: 'Code/heron/src/main.ts', repo: 'Code/heron', file: 'src/main.ts' };
const PATH = 'Code notes/heron/src/main.ts.md';

function draft(overrides: Partial<MarginNote> = {}): Omit<MarginNote, 'id'> {
	return {
		colour: 'yellow', author: 'you', tags: [], created: '2026-10-26',
		anchor: { quote: 'load();', prefix: '', suffix: '', line: 3 }, language: 'ts', body: 'Why?', extra: [],
		...overrides,
	};
}

const origin = () => Promise.resolve({ commit: 'abc123', codeLink: '[[Code/heron/src/main.ts|src/main.ts]]' });

describe('CodeNotesStore', () => {
	it('creates the note file with its origin on the first note', async () => {
		const vault = memoryVault();
		const store = new CodeNotesStore(vault, () => 'Code notes');
		const getOrigin = vi.fn(origin);
		const note = await store.add(TARGET, draft(), getOrigin);
		expect(note.id).toMatch(/^[0-9a-z]{6}$/);
		const text = vault.files.get(PATH) ?? '';
		expect(text).toMatch(/^---\nrepo: Code\/heron\nfile: src\/main.ts\ncommit: abc123\n---\n\nMargin notes on \[\[Code\/heron\/src\/main.ts\|src\/main.ts\]\]\.\n\n## Note /);
		const doc = await store.load(TARGET);
		expect(doc?.notes).toEqual([note]);
		await store.add(TARGET, draft({ body: 'second' }), getOrigin);
		expect(getOrigin).toHaveBeenCalledTimes(1);
		expect((await store.load(TARGET))?.notes.map((n) => n.body)).toEqual(['Why?', 'second']);
	});

	it('keeps edits made by hand between changes', async () => {
		const vault = memoryVault();
		const store = new CodeNotesStore(vault, () => 'Code notes');
		const first = await store.add(TARGET, draft(), origin);
		vault.files.set(PATH, (vault.files.get(PATH) ?? '').replace('## Note', 'A paragraph I added by hand.\n\n## Note'));
		await store.add(TARGET, draft({ body: 'second' }), origin);
		const text = vault.files.get(PATH) ?? '';
		expect(text).toContain('A paragraph I added by hand.');
		expect(await store.update(TARGET, first.id, { body: 'Edited.', colour: 'red' })).toBe(true);
		const doc = await store.load(TARGET);
		expect(doc?.find(first.id)).toMatchObject({ body: 'Edited.', colour: 'red' });
		expect(vault.files.get(PATH)).toContain('A paragraph I added by hand.');
		expect(vault.files.get(PATH)).toContain('second');
	});

	it('removes notes and reports ones that are gone', async () => {
		const vault = memoryVault();
		const store = new CodeNotesStore(vault, () => 'Code notes');
		const note = await store.add(TARGET, draft(), origin);
		expect(await store.remove(TARGET, note.id)).toBe(true);
		expect(await store.remove(TARGET, note.id)).toBe(false);
		expect(await store.update(TARGET, note.id, { body: 'x' })).toBe(false);
		expect((await store.load(TARGET))?.notes).toEqual([]);
		expect(await store.remove({ ...TARGET, file: 'other.ts' }, 'x')).toBe(false);
	});

	it('returns null for a file without notes, and follows the folder setting', async () => {
		let folder = 'Code notes';
		const store = new CodeNotesStore(memoryVault(), () => folder);
		expect(await store.load(TARGET)).toBeNull();
		folder = 'Reviews';
		expect(store.pathFor(TARGET)).toBe('Reviews/heron/src/main.ts.md');
	});
});

describe('diagram notes', () => {
	it('hold the diagram and links back to the code', () => {
		const text = renderDiagramNote({
			repo: 'Code/heron', file: 'src/main.ts', commit: 'abc', symbol: 'start', subject: 'start in heron/src/main.ts',
			model: 'claude-haiku-5-5', date: '2026-10-26', mermaid: 'flowchart LR\n  a --> b',
			codeLinks: ['[[Code/heron/src/main.ts|src/main.ts]]', '/elsewhere/lib.d.ts'],
		});
		expect(text).toContain('symbol: start\nkind: diagram\n---');
		expect(text).toContain('# Diagram of start in heron/src/main.ts');
		expect(text).toContain('```mermaid\nflowchart LR\n  a --> b\n```');
		expect(text).toContain('- [[Code/heron/src/main.ts|src/main.ts]]\n- /elsewhere/lib.d.ts');
	});
});
