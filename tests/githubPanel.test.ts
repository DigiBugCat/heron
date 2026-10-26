// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { Text } from '@codemirror/state';
import type { PullRequest, PullSummary, ReviewThread } from '../src/github/types';
import { groupPulls, PullRequestList } from '../src/ui/github/PullRequestList';
import { PullRequestOverview } from '../src/ui/github/PullRequestOverview';
import { settingsHosts, tokenSourceText } from '../src/ui/github/settings';
import { threadGutter, threadsByLine } from '../src/ui/github/threadGutter';
import { threadLocation, threadsByFile } from '../src/ui/github/threads';
import { DiffRenderer } from '../src/ui/pane/renderers';

const NOW = 1_800_000_000;

function pull(number: number, extra: Partial<PullRequest> = {}): PullRequest {
	return {
		number,
		title: `Change ${number}`,
		state: 'open',
		draft: false,
		author: 'alice',
		body: '',
		url: `https://github.com/o/r/pull/${number}`,
		headRef: `feature-${number}`,
		headSha: 'h',
		headRepo: 'o/r',
		baseRef: 'main',
		baseSha: 'b',
		baseRepo: 'o/r',
		createdAt: NOW - 86400 * 3,
		updatedAt: NOW - 7200,
		requestedReviewers: [],
		...extra,
	};
}

function summary(p: PullRequest, extra: Partial<PullSummary> = {}): PullSummary {
	return { pull: p, checks: 'none', unresolvedThreads: 0, reviewRequested: false, ...extra };
}

function thread(id: string, extra: Partial<ReviewThread> = {}): ReviewThread {
	return {
		id,
		path: 'src/a.ts',
		line: 3,
		startLine: null,
		side: 'RIGHT',
		resolved: false,
		outdated: false,
		comments: [{ author: 'bob', body: 'Please **rename** this', createdAt: NOW - 600, url: 'https://github.com/c/1' }],
		totalComments: 1,
		...extra,
	};
}

const app = {} as App;
const mounted: { unload: () => void }[] = [];
afterEach(() => {
	while (mounted.length) mounted.pop()?.unload();
	document.body.empty();
});

function mountList(onOpen = vi.fn()) {
	const list = new PullRequestList(document.body, { onOpen, now: () => NOW });
	list.load();
	mounted.push(list);
	return { list, onOpen };
}

describe('pull request groups', () => {
	it('puts review requests first, then yours, then the rest', () => {
		const groups = groupPulls('Me', [
			summary(pull(1)),
			summary(pull(2, { author: 'me' }), { reviewRequested: true }),
			summary(pull(3), { reviewRequested: true }),
		]);
		expect(groups.map((g) => [g.id, g.items.map((s) => s.pull.number)])).toEqual([
			['requested', [3]],
			['yours', [2]],
			['others', [1]],
		]);
	});
});

describe('pull requests panel list', () => {
	it('shows each pull request with number, author, draft, checks, threads and age', () => {
		const { list } = mountList();
		list.show({
			kind: 'pulls',
			viewer: 'me',
			truncated: false,
			summaries: [
				summary(pull(7, { draft: true }), { checks: 'failure', unresolvedThreads: 2, reviewRequested: true }),
				summary(pull(8, { author: 'me' }), { checks: 'success' }),
				summary(pull(9), { checks: 'pending' }),
			],
		});
		const groups = [...list.el.querySelectorAll('.heron-prs-group')].map((g) => g.textContent);
		expect(groups).toEqual(['Review requested1', 'Yours1', 'Others1']);
		const row = list.el.querySelector<HTMLElement>('[data-number="7"]');
		expect(row?.querySelector('.heron-pr-title')?.textContent).toBe('Change 7');
		expect(row?.querySelector('.heron-pr-number')?.textContent).toBe('#7');
		expect(row?.querySelector('.heron-pr-author')?.textContent).toBe('alice');
		expect(row?.querySelector('.heron-pr-draft')?.textContent).toBe('Draft');
		expect(row?.querySelector('.heron-pr-age')?.textContent).toBe('2h');
		expect(row?.querySelector('.heron-pr-check')?.getAttribute('aria-label')).toBe('Checks failed');
		expect(row?.querySelector('.heron-pr-threads')?.textContent).toBe('2');
		expect(row?.querySelector('.heron-pr-threads')?.getAttribute('aria-label')).toBe('2 unresolved threads');
		expect(list.el.querySelector('[data-number="8"] .heron-pr-check')?.getAttribute('aria-label')).toBe('Checks passed');
		expect(list.el.querySelector('[data-number="8"] .heron-pr-threads')).toBeNull();
		expect(list.el.querySelector('[data-number="8"] .heron-pr-draft')).toBeNull();
	});

	it('opens a pull request on select, in a new tab with Mod', () => {
		const { list, onOpen } = mountList();
		list.show({ kind: 'pulls', viewer: 'me', truncated: false, summaries: [summary(pull(4))] });
		const row = list.el.querySelector<HTMLElement>('[data-number="4"]');
		row?.click();
		row?.dispatchEvent(new MouseEvent('click', { metaKey: true }));
		expect(onOpen.mock.calls.map(([p, newTab]): [number, unknown] => [(p as PullRequest).number, newTab])).toEqual([[4, false], [4, true]]);
	});

	it('collapses a group', () => {
		const { list } = mountList();
		list.show({ kind: 'pulls', viewer: 'me', truncated: true, summaries: [summary(pull(1)), summary(pull(2))] });
		expect(list.el.querySelectorAll('.heron-pr')).toHaveLength(2);
		expect(list.el.textContent).toContain('Showing the 2 most recently updated.');
		list.el.querySelector<HTMLElement>('[data-group="others"]')?.click();
		expect(list.el.querySelectorAll('.heron-pr')).toHaveLength(0);
		expect(list.el.querySelector('[data-group="others"]')?.getAttribute('aria-expanded')).toBe('false');
	});

	it('shows loading, empty, and error messages with a retry button', () => {
		const { list } = mountList();
		list.show({ kind: 'loading' });
		expect(list.el.textContent).toBe('Loading pull requests…');
		list.show({ kind: 'pulls', viewer: 'me', truncated: false, summaries: [] });
		expect(list.el.textContent).toBe('No open pull requests.');
		const retry = vi.fn();
		list.show({ kind: 'message', text: 'Rate limit reached', detail: 'Try again after 10:00.', retry });
		expect(list.el.querySelector('.heron-prs-message-text')?.textContent).toBe('Rate limit reached');
		list.el.querySelector('button')?.click();
		expect(retry).toHaveBeenCalledOnce();
	});
});

describe('pull request overview', () => {
	it('renders header, description, checks, files and threads by file', () => {
		const onOpenFile = vi.fn();
		const overview = new PullRequestOverview(document.body, { app, onOpenFile, now: () => NOW });
		overview.load();
		mounted.push(overview);
		overview.render({
			pull: pull(5, { body: 'Adds **things**', headRepo: 'fork/r', headRef: 'topic' }),
			files: { ok: true, value: { truncated: false, items: [
				{ path: 'src/a.ts', previousPath: null, status: 'modified', additions: 4, deletions: 1 },
				{ path: 'README.md', previousPath: null, status: 'added', additions: 9, deletions: 0 },
			] } },
			checks: { ok: true, value: [
				{ name: 'build', state: 'success', description: 'success', url: null },
				{ name: 'lint', state: 'failure', description: 'failure', url: 'https://ci/lint' },
			] },
			threads: { ok: true, value: [
				thread('open-one'),
				thread('done', { resolved: true, line: 1 }),
				thread('other', { path: 'README.md', side: 'LEFT', line: 2 }),
			] },
		});
		const el = overview.el;
		expect(el.querySelector('.heron-pr-heading')?.textContent).toBe('Change 5 #5');
		expect(el.querySelector('.heron-pr-state')?.textContent).toBe('Open');
		expect(el.querySelector('.heron-pr-branches')?.textContent).toBe('main ← fork/r:topic');
		expect(el.querySelector('.heron-pr-body')?.textContent).toBe('Adds **things**');
		// Failing checks first.
		expect([...el.querySelectorAll('.heron-check-name')].map((c) => c.textContent)).toEqual(['lint', 'build']);
		expect(el.querySelector('a.heron-check-name')?.getAttribute('href')).toBe('https://ci/lint');

		const fileRow = el.querySelector<HTMLElement>('[data-path="src/a.ts"]');
		expect(fileRow?.querySelector('.heron-pr-file-stats')?.textContent).toBe('+4−1');
		expect(fileRow?.querySelector('.heron-pr-threads')?.textContent).toBe('1');
		fileRow?.click();
		expect(onOpenFile).toHaveBeenLastCalledWith('src/a.ts', false);

		const details = [...el.querySelectorAll<HTMLDetailsElement>('details.heron-thread')];
		expect(details.map((d) => [d.dataset.thread, d.open])).toEqual([['other', true], ['open-one', true], ['done', false]]);
		expect([...el.querySelectorAll('.heron-thread-file-name')].map((n) => n.textContent)).toEqual(['README.md', 'src/a.ts']);
		expect(el.querySelector('[data-thread="open-one"] .heron-comment-author')?.textContent).toBe('bob');
		expect(el.querySelector('[data-thread="open-one"] .heron-comment-time')?.textContent).toBe('10 minutes ago');
		el.querySelector<HTMLElement>('[data-thread="open-one"] .heron-thread-where')?.click();
		expect(onOpenFile).toHaveBeenLastCalledWith('src/a.ts', false, 3);
	});

	it('shows why a section could not load', () => {
		const overview = new PullRequestOverview(document.body, { app, onOpenFile: vi.fn() });
		overview.load();
		mounted.push(overview);
		overview.render({
			pull: pull(6, { state: 'merged' }),
			files: { ok: false, error: 'Files failed' },
			checks: { ok: false, error: 'Checks failed' },
			threads: { ok: true, value: [] },
		});
		expect(overview.el.querySelector('.heron-pr-state')?.textContent).toBe('Merged');
		expect(overview.el.textContent).toContain('Files failed');
		expect(overview.el.textContent).toContain('Checks failed');
		expect(overview.el.textContent).toContain('No review threads.');
		expect(overview.el.textContent).toContain('No description.');
	});
});

describe('review threads in diffs', () => {
	it('describes and groups thread locations', () => {
		expect(threadLocation(thread('a', { startLine: 2, line: 5 }))).toBe('lines 2–5');
		expect(threadLocation(thread('a', { side: 'LEFT' }))).toBe('line 3 (old)');
		expect(threadLocation(thread('a', { line: null }))).toBe('file');
		expect(threadsByFile([thread('b', { path: 'z.ts' }), thread('a')]).map(([f]) => f)).toEqual(['src/a.ts', 'z.ts']);
	});

	it('maps threads to document lines, clamped to the document', () => {
		const doc = Text.of(['a', 'b', 'c']);
		const byLine = threadsByLine(doc, [thread('x', { line: 2 }), thread('y', { line: 99 }), thread('z', { line: null })]);
		expect([...byLine.keys()]).toEqual([2, 3]);
	});

	it('marks thread lines in the diff gutter of the side they belong to', () => {
		const onSelect = vi.fn();
		const renderer = new DiffRenderer(document.body, 13, 'a\nb\nc\n', 'a\nB\nc\nd\n', 'x.ts', 'split', false, {
			modified: threadGutter([thread('t1', { line: 2 }), thread('t2', { line: 4, resolved: true })], onSelect),
		});
		renderer.load();
		mounted.push(renderer);
		// The gutter's width spacer is a hidden marker too.
		const markers = [...document.body.querySelectorAll<HTMLElement>('.heron-thread-marker')]
			.filter((m) => m.parentElement?.style.visibility !== 'hidden');
		expect(markers).toHaveLength(2);
		expect(markers.filter((m) => m.classList.contains('is-resolved'))).toHaveLength(1);
		expect(renderer.editorFor('original')).not.toBeNull();
		expect(document.body.querySelectorAll('.cm-editor')[0]?.querySelector('.heron-thread-marker')).toBeNull();
		expect(document.body.querySelectorAll('.heron-thread-line')).toHaveLength(1);
	});
});

describe('GitHub settings text', () => {
	it('lists github.com first, then detected hosts once each', () => {
		expect(settingsHosts(['ghe.b.com', 'github.com', 'ghe.a.com', 'ghe.b.com'])).toEqual(['github.com', 'ghe.a.com', 'ghe.b.com']);
	});

	it('says where the token comes from without showing it', () => {
		expect(tokenSourceText('github.com', 'settings')).toBe('Using the token pasted here.');
		expect(tokenSourceText('github.com', 'gh')).toBe('Using your GitHub CLI login (gh).');
		expect(tokenSourceText('ghe.corp', 'none')).toContain('gh auth login --hostname ghe.corp');
	});
});
