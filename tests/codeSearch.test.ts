// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitRepo } from '../src/git/GitRepo';
import { CodeHit, CodeSearchModal, hitPath, hitTitle, SearchRepo } from '../src/ui/vault/CodeSearchModal';
import { makeRepo, remove, write } from './helpers';

const cleanup: string[] = [];
afterEach(() => {
	document.body.innerHTML = '';
	while (cleanup.length) remove(cleanup.pop() ?? '');
});

async function searchRepo(vaultPath: string, files: Record<string, string>): Promise<SearchRepo> {
	const root = makeRepo(files);
	cleanup.push(root);
	const opened = await GitRepo.open(root);
	if (opened.kind !== 'repo') throw new Error('not a repo');
	return { repo: opened.repo, vaultPath };
}

function modal(repos: SearchRepo[], initial = '') {
	const chosen: { hit: CodeHit; newTab: boolean }[] = [];
	const m = new CodeSearchModal({} as never, () => repos, initial, (hit, newTab) => chosen.push({ hit, newTab }));
	document.body.append(m.modalEl);
	return { m, chosen };
}

describe('Search in code', () => {
	it('searches every repository, the first one given first, and shows file:line with the matched text', async () => {
		const app = await searchRepo('Code/app', { 'src/mail.ts': 'export function sendMail() {}\n' });
		const lib = await searchRepo('Code/lib', { 'index.ts': 'import { sendMail } from "app";\nsendMail();\n' });
		const { m } = modal([lib, app]);

		const hits = await m.getSuggestions('sendMail');
		expect(hits.map(hitTitle)).toEqual(['Code/lib/index.ts:1', 'Code/lib/index.ts:2', 'Code/app/src/mail.ts:1']);
		expect(hitPath(hits[2]!)).toBe(`${app.repo.root}/src/mail.ts`);

		const el = document.body.createDiv();
		m.renderSuggestion(hits[0]!, el);
		expect(el.querySelector('.heron-location-title')?.textContent).toBe('Code/lib/index.ts:1');
		expect(el.querySelector('.heron-code-search-line')?.textContent).toBe('import { sendMail } from "app";');
		expect(el.querySelector('mark')?.textContent).toBe('sendMail');
	});

	it('answers every query typed while it waits with the results for the latest one', async () => {
		const repo = await searchRepo('code', { 'a.ts': 'alpha\nalphabet\nbeta\n' });
		const { m } = modal([repo]);
		const first = m.getSuggestions('al');
		const second = m.getSuggestions('alpha');
		const latest = m.getSuggestions('alphab');
		const answers = await Promise.all([first, second, latest]);
		for (const hits of answers) expect(hits.map(hitTitle)).toEqual(['code/a.ts:2']);
	});

	it('applies the match options and explains invalid regular expressions', async () => {
		const repo = await searchRepo('code', { 'a.ts': 'Value\nvalue\nvalues\n' });
		const { m } = modal([repo]);
		m.setOption('caseSensitive', true);
		m.setOption('wholeWord', true);
		expect((await m.getSuggestions('value')).map(hitTitle)).toEqual(['code/a.ts:2']);

		m.setOption('regex', true);
		expect(await m.getSuggestions('(')).toEqual([]);
		expect(m.emptyStateText).toMatch(/^Invalid regular expression: /);
	});

	it('says when the vault has no repositories, and shows nothing for an empty query', async () => {
		const { m } = modal([]);
		expect(await m.getSuggestions('x')).toEqual([]);
		expect(m.emptyStateText).toBe('No git repositories in this vault');
		const repo = await searchRepo('code', { 'a.ts': 'x\n' });
		const other = modal([repo]);
		expect(await other.m.getSuggestions('')).toEqual([]);
		expect(other.m.emptyStateText).toBe('Type to search the code in this vault');
	});

	it('fills the input from the selection, offers match options, and opens a result, in a new tab with Mod', async () => {
		const repo = await searchRepo('code', { 'a.ts': 'const needle = 1;\n' });
		const { m, chosen } = modal([repo], 'needle');
		const typed = vi.fn();
		m.inputEl.addEventListener('input', typed);
		m.onOpen();
		expect(m.inputEl.value).toBe('needle');
		expect(typed).toHaveBeenCalledTimes(1);
		const options = Array.from(m.modalEl.querySelectorAll<HTMLElement>('.heron-code-search-option'));
		expect(options.map((o) => o.getAttribute('aria-label'))).toEqual(['Match case', 'Match whole word', 'Use regular expression']);
		options[0]?.click();
		expect(options[0]?.getAttribute('aria-pressed')).toBe('true');
		expect(m.queryFor('x')).toMatchObject({ caseSensitive: true, wholeWord: false, regex: false });
		expect(typed).toHaveBeenCalledTimes(2);

		const [hit] = await m.getSuggestions('needle');
		m.onChooseSuggestion(hit!, new MouseEvent('click'));
		m.onChooseSuggestion(hit!, new MouseEvent('click', { metaKey: true }));
		expect(chosen.map((c) => [hitTitle(c.hit), c.newTab])).toEqual([['code/a.ts:1', false], ['code/a.ts:1', true]]);
	});

	it('reports how many results it found and when it stopped at the cap', async () => {
		const many = Array.from({ length: 2100 }, (_, i) => `needle ${i}`).join('\n');
		const repo = await searchRepo('code', { 'a.ts': many, 'b.ts': 'needle\n' });
		write(repo.repo.root, 'c.ts', 'needle\n');
		const { m } = modal([repo]);
		m.onOpen();
		const status = () => m.modalEl.querySelector('.heron-code-search-status')?.textContent;
		expect(await m.getSuggestions('needle')).toHaveLength(2000);
		expect(status()).toBe('Showing the first 2,000 results in 1 file. Refine your search to see more.');
		expect(await m.getSuggestions('needle 7')).toHaveLength(111);
		expect(status()).toBe('111 results in 1 file');
	});
});
