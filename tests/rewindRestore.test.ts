import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRepo } from '../src/git/GitRepo';
import { hashText, HistoryStore } from '../src/services/rewind/HistoryStore';
import { Recorder } from '../src/services/rewind/Recorder';
import {
	applyRestore, isRestoreMoment, lastUndoable, planFileRestore, planUndoMoment, RestoreError, RestoreVault,
} from '../src/services/rewind/restore';
import { buildMoments } from '../src/services/rewind/timeline';
import type { MomentFile } from '../src/services/rewind/moments';
import { git, makeRepo, remove, tempDir, write } from './helpers';

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) remove(cleanup.pop() ?? ''); });

const H = (c: string) => c.repeat(64);

describe('restore plans', () => {
	const modify: MomentFile = { path: 'a.ts', kind: 'modify', before: H('1'), after: H('2') };
	const create: MomentFile = { path: 'new.ts', kind: 'create', before: null, after: H('3') };
	const remove_: MomentFile = { path: 'gone.ts', kind: 'delete', before: H('4'), after: null };
	const rename: MomentFile = { path: 'b.ts', oldPath: 'a.ts', kind: 'rename', before: H('5'), after: H('6') };

	it('restores a file to either side of its moment', () => {
		expect(planFileRestore(modify, 'before')).toEqual([{ kind: 'write', path: 'a.ts', hash: H('1') }]);
		expect(planFileRestore(modify, 'after')).toEqual([{ kind: 'write', path: 'a.ts', hash: H('2') }]);
		expect(planFileRestore(create, 'before')).toEqual([{ kind: 'delete', path: 'new.ts' }]);
		expect(planFileRestore(remove_, 'before')).toEqual([{ kind: 'write', path: 'gone.ts', hash: H('4') }]);
		expect(planFileRestore(remove_, 'after')).toEqual([{ kind: 'delete', path: 'gone.ts' }]);
		expect(planFileRestore(rename, 'before')).toEqual([{ kind: 'move', from: 'b.ts', to: 'a.ts' }, { kind: 'write', path: 'a.ts', hash: H('5') }]);
	});
});

/** A vault folder on disk with a repository at Code/app, a store, a recorder, and a fake vault API. */
async function setup() {
	const vault = tempDir('heron-vault-');
	const history = tempDir('heron-history-');
	cleanup.push(vault, history);
	write(vault, 'Code/app/a.ts', 'v1\n');
	write(vault, 'Code/app/b.ts', 'b1\n');
	const root = path.join(vault, 'Code/app');
	git(root, 'init', '-q');
	const opened = await GitRepo.open(root);
	if (opened.kind !== 'repo') throw new Error('no repo');
	const store = await HistoryStore.open(history);
	let now = 1_000_000;
	const recorder = new Recorder(store, {
		basePath: vault,
		repoFor: (p) => (p.startsWith('Code/app/') ? { rel: 'Code/app', repo: opened.repo } : null),
		now: () => now,
	});
	const abs = (p: string) => path.join(vault, p);
	const fsVault: RestoreVault = {
		exists: (p) => existsSync(abs(p)),
		read: (p) => Promise.resolve(readFileSync(abs(p), 'utf-8')),
		write: (p, text) => {
			mkdirSync(path.dirname(abs(p)), { recursive: true });
			writeFileSync(abs(p), text);
			recorder.notify('modify', p);
			return Promise.resolve();
		},
		remove: (p) => {
			rmSync(abs(p));
			recorder.notify('delete', p);
			return Promise.resolve();
		},
		move: (from, to) => {
			renameSync(abs(from), abs(to));
			recorder.notify('rename', to, from);
			return Promise.resolve();
		},
	};
	/** Simulates an outside edit (by Claude, say) seen through vault events. */
	const edit = async (p: string, text: string | null, pause = 60_000) => {
		now += pause;
		if (text === null) rmSync(abs(p));
		else write(vault, p, text);
		recorder.notify(text === null ? 'delete' : 'modify', p);
		await recorder.flush();
	};
	const read = (p: string) => (existsSync(abs(p)) ? readFileSync(abs(p), 'utf-8') : null);
	await recorder.baseline(['Code/app/a.ts', 'Code/app/b.ts']);
	const moments = () => buildMoments(store.records());
	const restore = async (ops: Parameters<typeof applyRestore>[0], label: string) => {
		now += 60_000;
		const changed = await applyRestore(ops, { vault: fsVault, store, recorder, label, group: `restore:${now}` });
		await recorder.flush();
		return changed;
	};
	return { store, recorder, edit, read, moments, restore };
}

describe('restoring', () => {
	it('undoes a moment across all its files, and records the undo as a moment of its own', async () => {
		const s = await setup();
		// One moment of three files: edits within the quiet gap.
		await s.edit('Code/app/a.ts', 'v2\n');
		await s.edit('Code/app/b.ts', 'b2\n', 1_000);
		await s.edit('Code/app/c.ts', 'c\n', 1_000);
		const [moment] = s.moments();
		expect(moment?.label).toBe('Changed 3 files');

		const changed = await s.restore(planUndoMoment(moment!), `Undid “${moment!.label}”`);
		expect(changed.sort()).toEqual(['Code/app/a.ts', 'Code/app/b.ts', 'Code/app/c.ts']);
		expect([s.read('Code/app/a.ts'), s.read('Code/app/b.ts'), s.read('Code/app/c.ts')]).toEqual(['v1\n', 'b1\n', null]);
		const [undo] = s.moments();
		expect(undo).toMatchObject({ source: 'heron', label: 'Undid “Changed 3 files”' });
		expect(undo?.files).toHaveLength(3);
		expect(isRestoreMoment(undo!)).toBe(true);

		// The undo can itself be undone.
		await s.restore(planUndoMoment(undo!), 'Undid the undo');
		expect([s.read('Code/app/a.ts'), s.read('Code/app/b.ts'), s.read('Code/app/c.ts')]).toEqual(['v2\n', 'b2\n', 'c\n']);
	});

	it('restores deleted files and removes created ones', async () => {
		const s = await setup();
		await s.edit('Code/app/a.ts', null);
		await s.edit('Code/app/new.ts', 'new\n');
		const [created, deleted] = s.moments();
		expect(created?.label).toBe('Created new.ts');
		expect(deleted?.label).toBe('Deleted a.ts');
		await s.restore(planUndoMoment(deleted!), 'restore a');
		await s.restore(planUndoMoment(created!), 'remove new');
		expect(s.read('Code/app/a.ts')).toBe('v1\n');
		expect(s.read('Code/app/new.ts')).toBeNull();
	});

	it('restores a file to a moment', async () => {
		const s = await setup();
		await s.edit('Code/app/a.ts', 'v2\n');
		await s.edit('Code/app/a.ts', 'v3\n');
		const older = s.moments()[1]!;
		await s.restore(planFileRestore(older.files[0]!, 'after'), 'Restored a.ts');
		expect(s.read('Code/app/a.ts')).toBe('v2\n');
		// Restoring to what is already there changes nothing.
		expect(await s.restore(planFileRestore(older.files[0]!, 'after'), 'again')).toEqual([]);
	});

	it('steps back one moment at a time with undo last', async () => {
		const s = await setup();
		await s.edit('Code/app/a.ts', 'v2\n');
		await s.edit('Code/app/a.ts', 'v3\n');
		const step = async () => {
			const current = s.store.lastKnown('Code/app/a.ts') ?? null;
			const found = lastUndoable(s.moments(), 'Code/app/a.ts', current);
			if (!found) return false;
			await s.restore(planFileRestore(found.file, 'before'), 'Undid');
			return true;
		};
		expect(await step()).toBe(true);
		expect(s.read('Code/app/a.ts')).toBe('v2\n');
		expect(await step()).toBe(true);
		expect(s.read('Code/app/a.ts')).toBe('v1\n');
		expect(await step()).toBe(false);
	});

	it('changes nothing when content it needs was pruned', async () => {
		const s = await setup();
		const ops = [
			{ kind: 'write' as const, path: 'Code/app/b.ts', hash: hashText('b-other\n') },
			{ kind: 'write' as const, path: 'Code/app/a.ts', hash: H('9') },
		];
		await expect(s.restore(ops, 'x')).rejects.toBeInstanceOf(RestoreError);
		expect(s.read('Code/app/b.ts')).toBe('b1\n');
	});
});

describe('git for Rewind', () => {
	it('reads the reflog subject and which files are ignored', async () => {
		const root = makeRepo({ '.gitignore': 'dist/\n', 'a.ts': 'a' });
		cleanup.push(root);
		write(root, 'dist/out.js', 'x');
		write(root, 'b.ts', 'b');
		git(root, 'checkout', '-q', '-b', 'feature');
		const opened = await GitRepo.open(root);
		if (opened.kind !== 'repo') throw new Error('no repo');
		expect(await opened.repo.reflogSubject()).toBe('checkout: moving from main to feature');
		expect([...await opened.repo.ignored(['dist/out.js', 'b.ts', 'a.ts', 'missing.ts'])]).toEqual(['dist/out.js']);
	});
});
