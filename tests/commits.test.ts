// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component } from 'obsidian';
import { GitRepo } from '../src/git/GitRepo';
import type { FileCommit } from '../src/git/history';
import { diffStateFrom, diffTitle, loadDiffState } from '../src/ui/vault/DiffView';
import { MAX_COMMITS, renderCommits } from '../src/ui/vault/rewind/CommitList';
import { RewindView, RewindViewOptions } from '../src/ui/vault/rewind/RewindView';
import { git, makeRepo, remove, write } from './helpers';
import { TFile } from './obsidian-shim';

const cleanup: string[] = [];
const roots: Component[] = [];
afterEach(() => {
	for (const c of roots.splice(0)) c.unload();
	document.body.innerHTML = '';
	while (cleanup.length) remove(cleanup.pop() ?? '');
});

/** `a.ts` with two commits by different authors, then renamed to `b.ts`. */
async function repoWithHistory(): Promise<{ root: string; repo: GitRepo }> {
	const root = makeRepo({ 'a.ts': 'const first = 1;\n' });
	cleanup.push(root);
	write(root, 'a.ts', 'const first = 1;\nconst third = 3;\n');
	git(root, 'add', '-A');
	git(root, '-c', 'user.name=Other', '-c', 'user.email=o@x', 'commit', '-q', '--author=Other <o@x>', '-m', 'Add third');
	git(root, 'mv', 'a.ts', 'b.ts');
	git(root, 'commit', '-q', '-m', 'Rename');
	const opened = await GitRepo.open(root);
	if (opened.kind !== 'repo') throw new Error('not a repo');
	return { root, repo: opened.repo };
}

/** The Rewind panel following `activePath`, with git history from `fileCommits`. */
async function panel(activePath: string | null, fileCommits: RewindViewOptions['fileCommits']) {
	const gitListeners = new Set<() => void>();
	const openCommit = vi.fn();
	const app = {
		workspace: {
			onLayoutReady: (cb: () => void) => cb(),
			on: () => ({}),
			getActiveFile: () => (activePath ? new TFile(activePath) : null),
			requestSaveLayout: () => undefined,
		},
	};
	const view = new RewindView({ app } as never, {
		enabled: () => false,
		moments: () => [],
		repoOf: (p) => (p.startsWith('code/') ? 'code' : null),
		onChange: () => () => undefined,
		openDiff: () => undefined,
		viewAsOf: () => undefined,
		restoreFile: () => undefined,
		undoMoment: () => undefined,
		fileCommits,
		openCommit,
		onGitChange: (l) => { gitListeners.add(l); return () => gitListeners.delete(l); },
	});
	view.load();
	await view.onOpen();
	roots.push(view);
	document.body.append(view.containerEl);
	return { view, el: view.contentEl, openCommit, gitChanged: () => { for (const l of gitListeners) l(); } };
}

describe('Commits scope of the Rewind panel', () => {
	it('lists the active file\'s commits, following renames, and opens the one selected', async () => {
		const { repo } = await repoWithHistory();
		const history = await repo.fileHistory('b.ts', MAX_COMMITS);
		const fileCommits = vi.fn(() => Promise.resolve(history));
		const { view, el, openCommit } = await panel('code/b.ts', fileCommits);

		const scopes = Array.from(el.querySelectorAll<HTMLElement>('.heron-rewind-scope-button'));
		expect(scopes.map((b) => b.textContent)).toEqual(['This file', 'Repository', 'Commits']);
		// Rewind being off does not hide the file's git history.
		expect(el.textContent).toContain('Rewind is off');
		scopes[2]?.click();
		expect(view.shownScope()).toBe('commits');
		expect(view.getState()).toMatchObject({ scope: 'commits' });
		await vi.waitFor(() => expect(el.querySelectorAll('.heron-rewind-commit')).toHaveLength(3));
		expect(fileCommits).toHaveBeenCalledWith('code/b.ts');
		const rows = Array.from(el.querySelectorAll<HTMLElement>('.heron-rewind-commit'));
		expect(rows.map((r) => r.querySelector('.heron-rewind-commit-subject')?.textContent)).toEqual(['Rename', 'Add third', 'init']);
		expect(rows[1]?.querySelector('.heron-rewind-commit-meta')?.textContent).toMatch(/^[0-9a-f]{7} · Other · now$/);
		expect(rows[0]?.title).toContain('Renamed from a.ts');
		expect(el.querySelector('.heron-rewind-title')?.textContent).toBe('b.ts');

		rows[1]?.click();
		rows[2]?.dispatchEvent(new MouseEvent('click', { metaKey: true, bubbles: true }));
		const calls = openCommit.mock.calls as [string, FileCommit, boolean][];
		expect(calls.map(([p, c, newTab]) => [p, c.subject, newTab])).toEqual([
			['code/b.ts', 'Add third', false],
			['code/b.ts', 'init', true],
		]);
	});

	it('reloads after a repository change, and explains files outside repositories or without commits', async () => {
		let list: FileCommit[] | null = [];
		const fileCommits = vi.fn(() => Promise.resolve(list));
		const { view, el, gitChanged } = await panel('code/new.ts', fileCommits);
		await view.setState({ scope: 'commits' }, {} as never);
		await vi.waitFor(() => expect(el.textContent).toContain('No commits for this file yet.'));
		expect(fileCommits).toHaveBeenCalledTimes(1);

		list = null;
		gitChanged();
		await vi.waitFor(() => expect(el.textContent).toContain('not in one of the vault’s repositories'));
		expect(fileCommits).toHaveBeenCalledTimes(2);
	});

	it('asks for an open file', async () => {
		const { view, el } = await panel(null, () => Promise.resolve([]));
		view.setScope('commits');
		expect(el.textContent).toContain('Open a file in one of the vault’s repositories to see its commits.');
	});

	it('says when the list stops at the cap', () => {
		const owner = new Component();
		owner.load();
		roots.push(owner);
		const el = document.body.createDiv();
		const commit = (i: number): FileCommit => ({ hash: `${i}`.padStart(40, '0'), short: `${i}`, author: 'A', email: 'a@x', time: 0, subject: `c${i}`, status: 'M', path: 'a.ts', origPath: null });
		renderCommits(el, owner, Array.from({ length: MAX_COMMITS }, (_, i) => commit(i)), { openCommit: () => undefined, now: 0 });
		expect(el.querySelectorAll('.heron-rewind-commit')).toHaveLength(MAX_COMMITS);
		expect(el.lastElementChild?.textContent).toBe(`Showing the latest ${MAX_COMMITS} commits.`);
	});
});

describe('diff tabs of commits', () => {
	it('show the change a commit made to the file', async () => {
		const { root, repo } = await repoWithHistory();
		const [rename, addThird, init] = await repo.fileHistory('b.ts', MAX_COMMITS);
		const state = diffStateFrom({ root, file: addThird!.path, commit: addThird });
		expect(state).toEqual({ root, file: 'a.ts', commit: addThird });
		expect(diffTitle(state)).toBe(`a.ts @ ${addThird!.short}`);

		expect(await loadDiffState(repo, state!)).toEqual({ sides: {
			original: { kind: 'text', text: 'const first = 1;\n' },
			modified: { kind: 'text', text: 'const first = 1;\nconst third = 3;\n' },
		} });
		const created = await loadDiffState(repo, { root, file: init!.path, commit: init! });
		expect(created).toMatchObject({ sides: { original: { kind: 'missing' } } });
		const renamed = await loadDiffState(repo, { root, file: rename!.path, commit: rename! });
		expect(renamed).toMatchObject({ sides: { original: { kind: 'text' }, modified: { kind: 'text' } } });
	});
});
