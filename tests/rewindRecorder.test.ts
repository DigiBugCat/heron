import { renameSync, rmSync } from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRepo } from '../src/git/GitRepo';
import { hashText, HistoryStore } from '../src/services/rewind/HistoryStore';
import { isExcludedPath, Recorder } from '../src/services/rewind/Recorder';
import type { FileRecord } from '../src/services/rewind/records';
import { git, remove, tempDir, write } from './helpers';

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) remove(cleanup.pop() ?? ''); });

/** A vault with a repository at Code/app, and a recorder for it. */
async function setup(files: Record<string, string> = {}, opts: { maxBytes?: number } = {}) {
	const vault = tempDir('heron-vault-');
	const history = tempDir('heron-history-');
	cleanup.push(vault, history);
	const root = path.join(vault, 'Code', 'app');
	write(vault, 'Code/app/.gitkeep', '');
	git(root, 'init', '-q');
	for (const [rel, content] of Object.entries(files)) write(root, rel, content);
	if (Object.keys(files).length) {
		git(root, 'add', '-A');
		git(root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
	}
	const opened = await GitRepo.open(root);
	if (opened.kind !== 'repo') throw new Error('no repo');
	const store = await HistoryStore.open(history);
	let now = 1_000_000;
	const recorder = new Recorder(store, {
		basePath: vault,
		repoFor: (p) => (p.startsWith('Code/app/') ? { rel: 'Code/app', repo: opened.repo } : null),
		now: () => now,
		maxBytes: opts.maxBytes,
	});
	const changes = () => store.fileRecords().filter((r) => r.kind !== 'baseline');
	return {
		vault, store, recorder, changes,
		put: (rel: string, content: string | Buffer) => write(vault, `Code/app/${rel}`, content),
		tick: (ms: number) => { now += ms; },
	};
}

const P = (rel: string) => `Code/app/${rel}`;

function summary(r: FileRecord) {
	return { kind: r.kind, path: r.path, oldPath: r.oldPath, before: r.before, after: r.after, source: r.source };
}

describe('recording changes', () => {
	it('diffs the first change to a file against the git index', async () => {
		const s = await setup({ 'src/mail.ts': 'v1\n' });
		s.put('src/mail.ts', 'v2\n');
		s.recorder.notify('modify', P('src/mail.ts'));
		expect(await s.recorder.flush()).toBe(1);
		const [rec] = s.changes();
		expect(rec && summary(rec)).toEqual({ kind: 'modify', path: P('src/mail.ts'), oldPath: undefined, before: hashText('v1\n'), after: hashText('v2\n'), source: undefined });
		expect(await s.store.readText(rec?.before ?? '')).toBe('v1\n');
		expect(s.store.lastKnown(P('src/mail.ts'))).toBe(hashText('v2\n'));
	});

	it('records creates, deletes and renames', async () => {
		const s = await setup({ 'a.ts': 'a\n' });
		s.put('new.ts', 'new\n');
		s.recorder.notify('create', P('new.ts'));
		await s.recorder.flush();
		rmSync(path.join(s.vault, P('new.ts')));
		s.recorder.notify('delete', P('new.ts'));
		await s.recorder.flush();
		renameSync(path.join(s.vault, P('a.ts')), path.join(s.vault, P('b.ts')));
		s.recorder.notify('rename', P('b.ts'), P('a.ts'));
		await s.recorder.flush();
		expect(s.changes().map((r) => [r.kind, r.path, r.oldPath ?? null])).toEqual([
			['create', P('new.ts'), null],
			['delete', P('new.ts'), null],
			['rename', P('b.ts'), P('a.ts')],
		]);
		expect(s.store.lastKnown(P('a.ts'))).toBeNull();
		expect(s.store.lastKnown(P('b.ts'))).toBe(hashText('a\n'));
	});

	it('collapses a burst of events, like an editor’s delete-then-create save, into one change', async () => {
		const s = await setup({ 'a.ts': 'one\n' });
		s.put('a.ts', 'two\n');
		s.recorder.notify('delete', P('a.ts'));
		s.recorder.notify('create', P('a.ts'));
		s.recorder.notify('modify', P('a.ts'));
		await s.recorder.flush();
		expect(s.changes().map((r) => r.kind)).toEqual(['modify']);
		// Touching a file without changing it records nothing.
		s.recorder.notify('modify', P('a.ts'));
		expect(await s.recorder.flush()).toBe(0);
	});

	it('skips git-ignored, node_modules, binary and oversized files, and files outside repositories', async () => {
		const s = await setup({ '.gitignore': 'dist/\n', 'ok.ts': 'x' }, { maxBytes: 100 });
		s.put('dist/out.js', 'built');
		s.put('node_modules/dep/index.js', 'dep');
		s.put('logo.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
		s.put('big.ts', 'x'.repeat(200));
		write(s.vault, 'Notes/n.md', 'note');
		for (const p of ['dist/out.js', 'node_modules/dep/index.js', 'logo.png', 'big.ts']) s.recorder.notify('create', P(p));
		s.recorder.notify('create', 'Notes/n.md');
		s.put('ok.ts', 'y');
		s.recorder.notify('modify', P('ok.ts'));
		await s.recorder.flush();
		expect(s.changes().map((r) => r.path)).toEqual([P('ok.ts')]);
		expect(isExcludedPath('Code/app/node_modules/x.js')).toBe(true);
		expect(isExcludedPath('Code/app/src/x.js')).toBe(false);
	});

	it('marks Heron’s own writes, with their label and group, until they expire', async () => {
		const s = await setup({ 'a.ts': 'one\n' });
		s.recorder.expect(P('a.ts'), 'two\n', { label: 'Restored a.ts', group: 'restore:1' });
		s.put('a.ts', 'two\n');
		s.recorder.notify('modify', P('a.ts'));
		await s.recorder.flush();
		// A different content than expected is someone else's change.
		s.recorder.expect(P('a.ts'), 'three\n');
		s.put('a.ts', 'something else\n');
		s.recorder.notify('modify', P('a.ts'));
		await s.recorder.flush();
		// An expectation that has expired no longer counts.
		s.recorder.expect(P('a.ts'), 'four\n');
		s.tick(60_000);
		s.put('a.ts', 'four\n');
		s.recorder.notify('modify', P('a.ts'));
		await s.recorder.flush();
		expect(s.changes().map((r) => [r.source ?? 'unknown', r.label ?? '', r.group ?? ''])).toEqual([
			['heron', 'Restored a.ts', 'restore:1'],
			['unknown', '', ''],
			['unknown', '', ''],
		]);
	});

	it('takes a baseline of files it has not seen, once', async () => {
		const s = await setup({ 'a.ts': 'committed\n' });
		s.put('a.ts', 'uncommitted\n');
		expect(await s.recorder.baseline([P('a.ts'), 'Notes/n.md'])).toBe(1);
		expect(await s.recorder.baseline([P('a.ts')])).toBe(0);
		s.put('a.ts', 'edited\n');
		s.recorder.notify('modify', P('a.ts'));
		await s.recorder.flush();
		// The change is diffed against the baseline, not the git index.
		expect(s.changes().map((r) => [r.before, r.after])).toEqual([[hashText('uncommitted\n'), hashText('edited\n')]]);
	});

	it('keeps a file created at a renamed file’s old path', async () => {
		const s = await setup({ 'a.ts': 'old\n' });
		renameSync(path.join(s.vault, P('a.ts')), path.join(s.vault, P('b.ts')));
		s.recorder.notify('rename', P('b.ts'), P('a.ts'));
		s.put('a.ts', 'replacement\n');
		s.recorder.notify('create', P('a.ts'));
		await s.recorder.flush();
		expect(s.changes().map((r) => [r.kind, r.path])).toEqual([['rename', P('b.ts')], ['modify', P('a.ts')]]);
		expect(s.store.lastKnown(P('a.ts'))).toBe(hashText('replacement\n'));
		expect(s.store.lastKnown(P('b.ts'))).toBe(hashText('old\n'));
	});

	it('treats a new untracked file as created', async () => {
		const s = await setup({ 'a.ts': 'a' });
		s.put('fresh.ts', 'hello');
		s.recorder.notify('modify', P('fresh.ts'));
		await s.recorder.flush();
		expect(s.changes().map((r) => [r.kind, r.before])).toEqual([['create', null]]);
	});
});
