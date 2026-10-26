import { App, Keymap, SuggestModal } from 'obsidian';
import * as path from 'path';
import type { GitRepo } from '../../git/GitRepo';
import { ContentSearch, MAX_SEARCH_MATCHES, RepoHit, SearchQuery } from '../../services/ContentSearch';

/** Wait after the last keystroke before searching, in ms. */
export const SEARCH_DEBOUNCE_MS = 250;

/** A repository to search, with its folder's vault path for display. */
export interface SearchRepo {
	repo: GitRepo;
	vaultPath: string;
}

export type CodeHit = RepoHit<SearchRepo>;

type QueryOption = 'caseSensitive' | 'wholeWord' | 'regex';

const OPTIONS: { key: QueryOption; text: string; label: string }[] = [
	{ key: 'caseSensitive', text: 'Aa', label: 'Match case' },
	{ key: 'wholeWord', text: 'ab', label: 'Match whole word' },
	{ key: 'regex', text: '.*', label: 'Use regular expression' },
];

/** `vault/path/to/file.ts:12` for a hit. */
export function hitTitle(hit: CodeHit): string {
	return `${hit.target.vaultPath}/${hit.rel}:${hit.match.line}`;
}

/** The hit's file on disk. */
export function hitPath(hit: CodeHit): string {
	return path.join(hit.target.repo.folder, hit.rel);
}

/**
 * **Search in code**: full-text search across the vault's repositories
 * with `git grep`, which Obsidian's own search does not cover. Results
 * update as you type; choosing one opens the file at that line.
 */
export class CodeSearchModal extends SuggestModal<CodeHit> {
	private search = new ContentSearch();
	private options: Record<QueryOption, boolean> = { caseSensitive: false, wholeWord: false, regex: false };
	private statusEl: HTMLElement | null = null;
	private abort: AbortController | null = null;
	private timer: number | null = null;
	/** The pending answer shared by every query typed while a search waits or runs. */
	private waiting: { promise: Promise<CodeHit[]>; resolve: (hits: CodeHit[]) => void } | null = null;
	private latestQuery = '';
	private readonly emptyText = 'Type to search the code in this vault';

	/**
	 * `repos` lists the repositories to search, the active file's first;
	 * `initial` fills the input, e.g. with the selected text.
	 */
	constructor(
		app: App,
		private repos: () => SearchRepo[],
		private initial: string,
		private onChoose: (hit: CodeHit, newTab: boolean) => void,
	) {
		super(app);
		this.setPlaceholder('Search in code…');
		this.emptyStateText = this.emptyText;
		this.limit = MAX_SEARCH_MATCHES;
		this.setInstructions([
			{ command: '↑↓', purpose: 'to navigate' },
			{ command: '↵', purpose: 'to open' },
			{ command: 'mod ↵', purpose: 'to open in a new tab' },
		]);
		this.scope.register(['Mod'], 'Enter', (evt) => {
			this.selectActiveSuggestion(evt);
			return false;
		});
	}

	onOpen() {
		void super.onOpen();
		this.modalEl.addClass('heron-code-search');
		const options = this.modalEl.createDiv({ cls: 'heron-code-search-options' });
		for (const { key, text, label } of OPTIONS) {
			const button = options.createEl('button', {
				cls: 'clickable-icon heron-code-search-option',
				text,
				attr: { 'aria-label': label, 'aria-pressed': 'false' },
			});
			button.addEventListener('click', () => {
				this.options[key] = !this.options[key];
				button.toggleClass('is-active', this.options[key]);
				button.setAttr('aria-pressed', String(this.options[key]));
				// Re-runs the search, as typing does.
				this.inputEl.dispatchEvent(new Event('input'));
				this.inputEl.focus();
			});
		}
		this.inputEl.insertAdjacentElement('afterend', options);
		this.statusEl = this.modalEl.createDiv({ cls: 'heron-code-search-status' });
		if (this.initial) {
			this.inputEl.value = this.initial;
			this.inputEl.select();
			this.inputEl.dispatchEvent(new Event('input'));
		}
	}

	onClose() {
		super.onClose();
		this.cancel();
		this.answer([]);
	}

	/** The options in effect, for `query`. */
	queryFor(text: string): SearchQuery {
		return { text, ...this.options };
	}

	/** Toggles a search option, e.g. from a test; the next query uses it. */
	setOption(key: QueryOption, on: boolean) {
		this.options[key] = on;
	}

	/**
	 * Searches after a short pause. Every call made while a search waits or
	 * runs gets the same answer: the results for the latest query, so a slow
	 * earlier search can never replace newer results.
	 */
	getSuggestions(query: string): Promise<CodeHit[]> {
		this.latestQuery = query;
		this.cancel();
		this.waiting ??= (() => {
			let resolve!: (hits: CodeHit[]) => void;
			const promise = new Promise<CodeHit[]>((r) => { resolve = r; });
			return { promise, resolve };
		})();
		const waiting = this.waiting.promise;
		this.timer = window.setTimeout(() => { void this.runLatest(); }, SEARCH_DEBOUNCE_MS);
		return waiting;
	}

	renderSuggestion(hit: CodeHit, el: HTMLElement) {
		el.addClass('heron-location-item', 'heron-code-search-hit');
		el.createDiv({ cls: 'heron-location-title', text: hitTitle(hit) });
		const text = el.createDiv({ cls: 'heron-location-detail heron-code-search-line' });
		const { preview, ranges } = hit.match;
		let pos = 0;
		for (const [from, to] of ranges) {
			if (from < pos) continue;
			if (from > pos) text.appendText(preview.slice(pos, from));
			text.createEl('mark', { cls: 'heron-code-search-match', text: preview.slice(from, to) });
			pos = to;
		}
		if (pos < preview.length) text.appendText(preview.slice(pos));
	}

	onChooseSuggestion(hit: CodeHit, evt: MouseEvent | KeyboardEvent) {
		this.onChoose(hit, Keymap.isModEvent(evt) !== false);
	}

	private cancel() {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.abort?.abort();
		this.abort = null;
	}

	private answer(hits: CodeHit[]) {
		const waiting = this.waiting;
		this.waiting = null;
		waiting?.resolve(hits);
	}

	private setStatus(text: string) {
		this.statusEl?.setText(text);
		this.statusEl?.toggleClass('is-empty', !text);
	}

	private async runLatest() {
		this.timer = null;
		const text = this.latestQuery;
		if (!text) {
			this.emptyStateText = this.emptyText;
			this.setStatus('');
			this.answer([]);
			return;
		}
		const repos = this.repos();
		if (!repos.length) {
			this.emptyStateText = 'No git repositories in this vault';
			this.answer([]);
			return;
		}
		const abort = new AbortController();
		this.abort = abort;
		let hits: CodeHit[] = [];
		try {
			const result = await this.search.runAll(repos, this.queryFor(text), abort.signal);
			hits = result.hits;
			this.emptyStateText = 'No results';
			const files = new Set(hits.map((h) => `${h.target.vaultPath}/${h.rel}`)).size;
			const lines = hits.length === 1 ? '1 result' : `${hits.length.toLocaleString()} results`;
			const inFiles = files === 1 ? '1 file' : `${files.toLocaleString()} files`;
			this.setStatus(!hits.length ? '' : result.truncated
				? `Showing the first ${lines} in ${inFiles}. Refine your search to see more.`
				: `${lines} in ${inFiles}`);
		} catch (err) {
			if (abort.signal.aborted) return; // a newer search answers instead
			const message = err instanceof Error ? err.message : String(err);
			this.emptyStateText = err instanceof SyntaxError ? `Invalid regular expression: ${message}` : `Cannot search: ${message}`;
			this.setStatus('');
		}
		if (abort.signal.aborted) return;
		this.abort = null;
		this.answer(hits);
	}
}
