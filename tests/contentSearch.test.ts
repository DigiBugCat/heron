import { afterEach, describe, expect, it } from 'vitest';
import { GitRepo } from '../src/git/GitRepo';
import { compileQuery, ContentSearch, makePreview, matchRanges, MAX_SEARCH_MATCHES, SearchQuery } from '../src/services/ContentSearch';
import { makeRepo, remove, write } from './helpers';

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) remove(cleanup.pop() ?? ''); });

const q = (text: string, opts: Partial<SearchQuery> = {}): SearchQuery =>
	({ text, caseSensitive: false, wholeWord: false, regex: false, ...opts });

describe('query matching', () => {
	it('escapes plain text, honours case and whole-word options', () => {
		expect(matchRanges(compileQuery(q('a.b')), 'axb a.b A.B')).toEqual([[4, 7], [8, 11]]);
		expect(matchRanges(compileQuery(q('a.b', { caseSensitive: true })), 'a.b A.B')).toEqual([[0, 3]]);
		expect(matchRanges(compileQuery(q('cat', { wholeWord: true })), 'cat concat cat_ cat.')).toEqual([[0, 3], [16, 19]]);
	});

	it('supports regular expressions and skips empty matches', () => {
		expect(matchRanges(compileQuery(q('\\d+', { regex: true })), 'a1 b22')).toEqual([[1, 2], [4, 6]]);
		expect(matchRanges(compileQuery(q('x*', { regex: true })), 'abx')).toEqual([[2, 3]]);
		expect(() => compileQuery(q('(', { regex: true }))).toThrow(SyntaxError);
	});

	it('trims indentation and cuts long lines around the first match', () => {
		expect(makePreview(3, '\t\tfoo bar', [[6, 9]])).toEqual({ line: 3, preview: 'foo bar', ranges: [[4, 7]] });
		const long = `${'x'.repeat(300)}needle${'y'.repeat(300)}`;
		const preview = makePreview(1, long, [[300, 306]], 60);
		expect(preview.preview.startsWith('…')).toBe(true);
		expect(preview.preview.endsWith('…')).toBe(true);
		const [range] = preview.ranges;
		expect(preview.preview.slice(range![0], range![1])).toBe('needle');
	});
});

describe('ContentSearch', () => {
	async function open(folder: string): Promise<GitRepo> {
		const opened = await GitRepo.open(folder);
		if (opened.kind !== 'repo') throw new Error('not a repo');
		return opened.repo;
	}

	it('uses git grep, with folder-relative paths and highlighting from the JS expression', async () => {
		const root = makeRepo({ 'src/a.ts': 'const value = 42;\n', 'README.md': 'value\n' });
		cleanup.push(root);
		const repo = await open(`${root}/src`);
		const results = await new ContentSearch().run(repo, q('val\\w+', { regex: true }));
		expect(results.files).toHaveLength(1);
		expect(results.files[0]?.rel).toBe('a.ts');
		expect(results.files[0]?.lines[0]).toMatchObject({ line: 1, preview: 'const value = 42;', ranges: [[6, 11]] });
	});

	it('includes untracked files and honours case', async () => {
		const root = makeRepo({ 'a.txt': 'one needle\nnone\nNeedle two\n' });
		cleanup.push(root);
		write(root, 'new.txt', 'needle\n');
		const repo = await open(root);
		const results = await new ContentSearch().run(repo, q('needle', { caseSensitive: true }));
		expect(results.files.map((f) => [f.rel, f.lines.map((l) => l.line)])).toEqual([['a.txt', [1]], ['new.txt', [1]]]);
		expect(results.matchCount).toBe(2);
	});

	it('rejects invalid regular expressions before running git', async () => {
		const root = makeRepo({ 'a.txt': 'a\n' });
		cleanup.push(root);
		const repo = await open(root);
		await expect(new ContentSearch().run(repo, q('[', { regex: true }))).rejects.toThrow(SyntaxError);
		await expect(new ContentSearch().runAll([{ repo }], q('(', { regex: true }))).rejects.toThrow(SyntaxError);
	});

	it('searches repositories in order and caps the total across them', async () => {
		const many = (n: number) => Array.from({ length: n }, (_, i) => `needle ${i}`).join('\n') + '\n';
		const first = makeRepo({ 'a.txt': many(1500) });
		const second = makeRepo({ 'b.txt': many(1000), 'c.txt': 'needle\n' });
		const empty = makeRepo({ 'd.txt': 'nothing\n' });
		cleanup.push(first, second, empty);
		const targets = [{ repo: await open(empty), name: 'empty' }, { repo: await open(first), name: 'first' }, { repo: await open(second), name: 'second' }];

		const { hits, truncated } = await new ContentSearch().runAll(targets, q('needle'));
		expect(hits).toHaveLength(MAX_SEARCH_MATCHES);
		expect(truncated).toBe(true);
		expect(hits.slice(0, 1500).every((h) => h.target.name === 'first' && h.rel === 'a.txt')).toBe(true);
		expect(hits[1500]).toMatchObject({ target: { name: 'second' }, rel: 'b.txt', match: { line: 1 } });

		const few = await new ContentSearch().runAll(targets.slice(2), q('needle 99'));
		expect(few.truncated).toBe(false);
		expect(few.hits.map((h) => `${h.rel}:${h.match.line}`)).toEqual(['b.txt:100', ...Array.from({ length: 10 }, (_, i) => `b.txt:${991 + i}`)]);
	});

	it('stops when cancelled', async () => {
		const root = makeRepo({ 'a.txt': 'needle\n' });
		cleanup.push(root);
		const repo = await open(root);
		const abort = new AbortController();
		abort.abort();
		await expect(new ContentSearch().runAll([{ repo }], q('needle'), abort.signal)).rejects.toThrow('Search cancelled');
	});
});
