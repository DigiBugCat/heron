// @vitest-environment jsdom
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component } from 'obsidian';
import { parseNameStatus } from '../src/git/baseDiff';
import { loadDiffSides } from '../src/git/diffSources';
import { GitRepo } from '../src/git/GitRepo';
import type { ChangeEntry } from '../src/git/status';
import { BaseComparisons, compareWithBase } from '../src/services/BaseComparison';
import { RepoState } from '../src/services/RepoState';
import { sanitizeSettings, setBaseBranch, setBaseCompare, MAX_BASE_BRANCHES } from '../src/settings';
import { ChangesView } from '../src/ui/vault/ChangesView';
import { diffStateFrom, diffTitle, loadDiffState } from '../src/ui/vault/DiffView';
import { git, makeRepo, remove, tempDir, write } from './helpers';
import { Menu, MenuItem } from './obsidian-shim';

const cleanup: string[] = [];
const roots: Component[] = [];
afterEach(() => {
	for (const c of roots.splice(0)) c.unload();
	document.body.innerHTML = '';
	while (cleanup.length) remove(cleanup.pop() ?? '');
});

async function open(folder: string): Promise<GitRepo> {
	const result = await GitRepo.open(folder);
	if (result.kind !== 'repo') throw new Error(`expected a repo, got ${result.kind}`);
	return result.repo;
}

function commit(root: string, message: string) {
	git(root, 'add', '-A');
	git(root, 'commit', '-q', '-m', message);
}

/**
 * `main` with a few files, and a `feature` branch two commits ahead that
 * renames, edits and deletes files, plus staged, unstaged and untracked work.
 */
function featureRepo(): string {
	const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
	const root = makeRepo({ 'keep.txt': 'keep\n', 'edit.txt': 'v1\n', 'gone.txt': 'g\n', 'old.txt': body, 'sub/s.txt': 's\n' });
	cleanup.push(root);
	git(root, 'checkout', '-q', '-b', 'feature');
	write(root, 'edit.txt', 'v2\n');
	commit(root, 'Edit');
	git(root, 'mv', 'old.txt', 'new.txt');
	git(root, 'rm', '-q', 'gone.txt');
	commit(root, 'Rename and delete');
	// main moves on too; that must not show up as changes.
	git(root, 'checkout', '-q', 'main');
	write(root, 'main-only.txt', 'm\n');
	commit(root, 'Main moves on');
	git(root, 'checkout', '-q', 'feature');
	write(root, 'staged.txt', 'st\n');
	git(root, 'add', 'staged.txt');
	write(root, 'sub/s.txt', 's2\n');
	write(root, 'untracked.txt', 'u\n');
	return root;
}

describe('parseNameStatus', () => {
	it('parses statuses, renames and copies', () => {
		expect(parseNameStatus('M\0a.ts\0A\0b.ts\0D\0c.ts\0R087\0old.ts\0new.ts\0C100\0x.ts\0y.ts\0T\0link\0')).toEqual([
			{ path: 'a.ts', kind: 'modified' },
			{ path: 'b.ts', kind: 'added' },
			{ path: 'c.ts', kind: 'deleted' },
			{ path: 'new.ts', origPath: 'old.ts', kind: 'renamed' },
			{ path: 'y.ts', origPath: 'x.ts', kind: 'renamed' },
			{ path: 'link', kind: 'modified' },
		]);
		expect(parseNameStatus('')).toEqual([]);
	});
});

describe('base branch git helpers', () => {
	it('finds a local default branch, lists branches and counts commits since the merge base', async () => {
		const root = featureRepo();
		const repo = await open(root);
		expect(await repo.defaultBase()).toBe('main');
		expect(await repo.branches()).toEqual(['feature', 'main']);
		const base = await repo.mergeBase('main');
		expect(await repo.commitsSince(base)).toBe(2);
		expect(await repo.hasCommit('main')).toBe(true);
		expect(await repo.hasCommit('nope')).toBe(false);
	});

	it('prefers the remote default branch', async () => {
		const origin = makeRepo({ 'a.txt': 'a\n' });
		const dir = tempDir();
		cleanup.push(origin, dir);
		const clone = path.join(dir, 'clone');
		git(dir, 'clone', '-q', origin, clone);
		const repo = await open(clone);
		expect(await repo.defaultBase()).toBe('origin/main');
		expect(await repo.branches()).toEqual(['main', 'origin/main']);
	});
});

describe('compareWithBase', () => {
	it('lists committed, staged, unstaged and untracked changes since the merge base', async () => {
		const root = featureRepo();
		const repo = await open(root);
		const result = await compareWithBase(repo, 'main', await repo.status());
		if (result.kind !== 'ok') throw new Error(result.message);
		expect(result.ahead).toBe(2);
		expect(result.entries.map((e) => [e.file.path, e.kind, e.file.origPath ?? null])).toEqual([
			['edit.txt', 'modified', null],
			['gone.txt', 'deleted', null],
			['new.txt', 'renamed', 'old.txt'],
			['staged.txt', 'added', null],
			['sub/s.txt', 'modified', null],
			['untracked.txt', 'untracked', null],
		]);
		expect(result.entries.every((e) => e.group === 'base' && e.base?.commit === result.commit)).toBe(true);
	});

	it('is limited to the opened subfolder', async () => {
		const root = featureRepo();
		const repo = await open(path.join(root, 'sub'));
		const result = await compareWithBase(repo, 'main', await repo.status());
		if (result.kind !== 'ok') throw new Error(result.message);
		expect(result.entries.map((e) => e.file.path)).toEqual(['sub/s.txt']);
	});

	it('explains a missing base, an unknown branch and unrelated history', async () => {
		const root = featureRepo();
		const repo = await open(root);
		const status = await repo.status();
		expect(await compareWithBase(repo, null, status)).toMatchObject({ kind: 'error', message: expect.stringMatching(/No base branch/) as unknown });
		expect(await compareWithBase(repo, 'nope', status)).toMatchObject({ kind: 'error', message: 'Branch nope not found' });
		git(root, 'checkout', '-q', '--orphan', 'island');
		git(root, 'commit', '-q', '-m', 'island');
		expect(await compareWithBase(repo, 'main', await repo.status())).toMatchObject({ kind: 'error', message: 'No common history with main' });
	});

	it('diffs a file from the merge base to the working tree', async () => {
		const root = featureRepo();
		const repo = await open(root);
		const result = await compareWithBase(repo, 'main', await repo.status());
		if (result.kind !== 'ok') throw new Error(result.message);
		const byPath = new Map(result.entries.map((e) => [e.file.path, e]));
		const edit = await loadDiffSides(repo, byPath.get('edit.txt')!);
		expect(edit).toEqual({ original: { kind: 'text', text: 'v1\n' }, modified: { kind: 'text', text: 'v2\n' } });
		const renamed = await loadDiffSides(repo, byPath.get('new.txt')!);
		expect(renamed.original).toEqual(renamed.modified);
		expect((await loadDiffSides(repo, byPath.get('untracked.txt')!)).original.kind).toBe('missing');
		expect((await loadDiffSides(repo, byPath.get('gone.txt')!)).modified.kind).toBe('missing');
	});
});

describe('base branch settings', () => {
	it('sanitizes stored values and keeps the per-repository map bounded', () => {
		expect(sanitizeSettings({}).baseCompareRepos).toEqual([]);
		expect(sanitizeSettings({ baseCompareRepos: ['/a/.git', '/a/.git', 3, ''] }).baseCompareRepos).toEqual(['/a/.git']);
		expect(sanitizeSettings({ baseBranches: { '/a/.git': 'main', '/b/.git': 3, '': 'x' } }).baseBranches).toEqual({ '/a/.git': 'main' });
		let map: Record<string, string> = {};
		for (let i = 0; i < MAX_BASE_BRANCHES + 5; i++) map = setBaseBranch(map, `/r${i}`, 'main');
		map = setBaseBranch(map, '/r10', 'develop');
		expect(Object.keys(map)).toHaveLength(MAX_BASE_BRANCHES);
		expect(map['/r10']).toBe('develop');
		expect(Object.keys(map).at(-1)).toBe('/r10');
	});

	it('turns base mode on and off per repository, keeping the list bounded', () => {
		let repos: string[] = [];
		for (let i = 0; i < MAX_BASE_BRANCHES + 5; i++) repos = setBaseCompare(repos, `/r${i}`, true);
		expect(repos).toHaveLength(MAX_BASE_BRANCHES);
		repos = setBaseCompare(repos, '/r10', true);
		expect(repos.at(-1)).toBe('/r10');
		expect(repos.filter((r) => r === '/r10')).toHaveLength(1);
		expect(setBaseCompare(repos, '/r10', false)).not.toContain('/r10');
	});
});

describe('base comparisons per repository', () => {
	it('computes once per status, keeps the old list while refreshing, and lets the latest request win', async () => {
		const root = featureRepo();
		const repo = await open(root);
		const status = await repo.status();
		const updates = vi.fn();
		const comparisons = new BaseComparisons(updates);

		comparisons.update('id', repo, status, null);
		expect(comparisons.view('id')).toEqual({ kind: 'loading', ref: null });
		await vi.waitFor(() => expect(comparisons.view('id')?.kind).toBe('ok'));
		const view = comparisons.view('id');
		expect(view).toMatchObject({ kind: 'ok', ref: 'main', ahead: 2 });
		expect(updates).toHaveBeenCalledTimes(1);

		// Same inputs: nothing to do. A refresh keeps showing the last result meanwhile.
		comparisons.update('id', repo, status, null);
		expect(updates).toHaveBeenCalledTimes(1);
		comparisons.update('id', repo, status, null, true);
		expect(comparisons.view('id')).toBe(view);

		// Choosing another branch shows "loading" at once; only the latest choice lands.
		comparisons.update('id', repo, status, 'nope');
		comparisons.update('id', repo, status, 'main');
		expect(comparisons.view('id')).toEqual({ kind: 'loading', ref: 'main' });
		await vi.waitFor(() => expect(comparisons.view('id')?.kind).toBe('ok'));
		await new Promise((r) => setTimeout(r, 50));
		expect(comparisons.view('id')).toMatchObject({ kind: 'ok', ref: 'main' });

		comparisons.drop('id');
		expect(comparisons.view('id')).toBeNull();
	});
});

describe('Changes panel in base mode', () => {
	/** A Changes panel over one repository, with base choices kept in memory. */
	async function panel(root: string) {
		const state = new RepoState();
		await state.open(root);
		state.dispose();
		const snapshot = state.snapshot;
		if (snapshot.kind !== 'repo') throw new Error('not a repo');
		const choices = { on: false, branch: null as string | null };
		const listeners = new Set<() => void>();
		const changed = () => { for (const l of listeners) l(); };
		const opened: { rel: string; entry: ChangeEntry; newTab: boolean }[] = [];
		const app = { workspace: { onLayoutReady: (cb: () => void) => cb(), on: () => ({}), getActiveFile: () => null } };
		const view = new ChangesView({ app } as never, {
			git: () => ({ vaultRepos: () => [{ rel: 'code/app', snapshot }], onChange: () => () => undefined }) as never,
			base: {
				isOn: () => choices.on,
				setOn: (_repo, on) => { choices.on = on; changed(); },
				branch: () => choices.branch,
				setBranch: (_repo, branch) => { choices.branch = branch; changed(); },
				onChange: (l) => { listeners.add(l); return () => listeners.delete(l); },
			},
			openDiff: (rel, entry, newTab) => opened.push({ rel, entry, newTab }),
			openFile: () => undefined,
		});
		view.load();
		await view.onOpen();
		roots.push(view);
		document.body.append(view.containerEl);
		return { el: view.contentEl, choices, opened };
	}

	it('switches a repository to changes against its base branch and back', async () => {
		const root = featureRepo();
		const { el, choices, opened } = await panel(root);
		const toggle = () => el.querySelector<HTMLElement>('.heron-changes-base-toggle');
		expect(toggle()?.getAttribute('aria-pressed')).toBe('false');
		expect(el.querySelectorAll('.heron-changes-group').length).toBeGreaterThan(0);

		toggle()?.click();
		expect(choices.on).toBe(true);
		expect(el.textContent).toContain('Comparing…');
		await vi.waitFor(() => expect(el.querySelector('.heron-changes-base')?.textContent).toBe('Againstmain2 commits'));
		expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
		expect(el.querySelectorAll('.heron-changes-group')).toHaveLength(0);
		const rows = Array.from(el.querySelectorAll('.heron-change'));
		expect(rows.map((r) => r.querySelector('.heron-change-letter')?.textContent + (r.querySelector('.heron-change-name')?.textContent ?? ''))).toEqual([
			'Medit.txt', 'Dgone.txt', 'Rnew.txt', 'Astaged.txt', 'Ms.txt', 'Uuntracked.txt',
		]);
		expect(el.querySelector('.heron-changes-count')?.textContent).toBe('6');

		(rows[0] as HTMLElement).click();
		expect(opened[0]).toMatchObject({ rel: 'code/app', newTab: false, entry: { group: 'base', file: { path: 'edit.txt' }, base: { ref: 'main' } } });

		toggle()?.click();
		expect(choices.on).toBe(false);
		expect(el.querySelector('.heron-changes-base')).toBeNull();
		expect(el.querySelectorAll('.heron-changes-group').length).toBeGreaterThan(0);
	});

	it('picks the base branch from a menu and explains a missing one', async () => {
		const root = featureRepo();
		const { el, choices } = await panel(root);
		el.querySelector<HTMLElement>('.heron-changes-base-toggle')?.click();
		await vi.waitFor(() => expect(el.querySelector('.heron-changes-base-ahead')).not.toBeNull());

		Menu.last = null;
		el.querySelector<HTMLElement>('.heron-changes-base')?.click();
		await vi.waitFor(() => expect(Menu.last).not.toBeNull());
		const items = ((Menu.last as Menu | null)?.items ?? []).filter((i): i is MenuItem => i !== null);
		expect(items.map((i) => [i.title, i.checked])).toEqual([['feature', false], ['main', true]]);
		items[0]?.callback();
		expect(choices.branch).toBe('feature');
		// Against its own branch only the uncommitted work is left.
		await vi.waitFor(() => expect(el.querySelector('.heron-changes-base')?.textContent).toBe('Againstfeature0 commits'));
		expect(el.querySelectorAll('.heron-change')).toHaveLength(3);

		choices.branch = 'nope';
		el.querySelector<HTMLElement>('.heron-changes-base-toggle')?.click();
		el.querySelector<HTMLElement>('.heron-changes-base-toggle')?.click();
		await vi.waitFor(() => expect(el.querySelector('.heron-changes-base-error')?.textContent).toBe('Branch nope not found'));
	});
});

describe('diff tabs of base changes', () => {
	it('reads their state back and titles them', () => {
		expect(diffStateFrom({ root: '/r', file: 'a.ts', group: 'base', baseRef: 'main' })).toEqual({ root: '/r', file: 'a.ts', group: 'base', baseRef: 'main' });
		expect(diffStateFrom({ root: '/r', file: 'a.ts', group: 'base' })).toBeNull();
		expect(diffStateFrom({ root: '/r', file: 'a.ts', group: 'sideways' })).toBeNull();
		expect(diffTitle({ root: '/r', file: 'src/a.ts', group: 'base', baseRef: 'main' })).toBe('a.ts (against main)');
		expect(diffTitle({ root: '/r', file: 'src/a.ts', group: 'staged' })).toBe('a.ts (staged)');
	});

	it('loads the file from the merge base against the working tree', async () => {
		const root = featureRepo();
		const repo = await open(root);
		const loaded = await loadDiffState(repo, { root, file: 'edit.txt', group: 'base', baseRef: 'main' });
		expect(loaded).toEqual({ sides: { original: { kind: 'text', text: 'v1\n' }, modified: { kind: 'text', text: 'v2\n' } } });
		expect(await loadDiffState(repo, { root, file: 'keep.txt', group: 'base', baseRef: 'main' })).toEqual({ message: 'No changes', detail: 'keep.txt matches main' });
		expect(await loadDiffState(repo, { root, file: 'edit.txt', group: 'base', baseRef: 'nope' }))
			.toEqual({ message: 'Cannot compare with the base branch', detail: 'Branch nope not found' });
	});
});
