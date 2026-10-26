import { GitError, GitRepo } from '../git/GitRepo';
import { GrepHit, GrepSyntax, isPcreUnsupported } from '../git/grep';

/** Maximum number of matching lines collected per search. */
export const MAX_SEARCH_MATCHES = 2000;
/** Characters of a matching line shown in a result. */
export const PREVIEW_CHARS = 160;
/** Characters of context kept before the first match when a preview is cut. */
const PREVIEW_LEAD = 24;

export interface SearchQuery {
	text: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	regex: boolean;
}

export interface MatchLine {
	/** 1-based line number. */
	line: number;
	/** The line, trimmed to a window around the first match. */
	preview: string;
	/** Match ranges within `preview`, as [from, to) offsets. */
	ranges: [number, number][];
}

export interface FileMatches {
	/** Path relative to the repository's folder, '/'-separated. */
	rel: string;
	lines: MatchLine[];
}

export interface SearchResults {
	files: FileMatches[];
	/** Number of matching lines. */
	matchCount: number;
	/** True when the search stopped at `MAX_SEARCH_MATCHES`. */
	truncated: boolean;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiles a query to a global JS regular expression; throws SyntaxError for an invalid regex. */
export function compileQuery(query: SearchQuery): RegExp {
	let source = query.regex ? query.text : escapeRegExp(query.text);
	if (query.wholeWord) source = `(?<![\\w])(?:${source})(?![\\w])`;
	return new RegExp(source, query.caseSensitive ? 'g' : 'gi');
}

/** All non-empty matches of `re` (which must be global) in `text`. */
export function matchRanges(re: RegExp, text: string): [number, number][] {
	const ranges: [number, number][] = [];
	re.lastIndex = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		if (m[0].length === 0) {
			re.lastIndex++;
			continue;
		}
		ranges.push([m.index, m.index + m[0].length]);
	}
	return ranges;
}

/**
 * Cuts `text` to at most `max` characters around its first match, dropping
 * leading indentation, and shifts `ranges` to match.
 */
export function makePreview(line: number, text: string, ranges: [number, number][], max = PREVIEW_CHARS): MatchLine {
	const indent = text.length - text.trimStart().length;
	const first = ranges[0]?.[0] ?? indent;
	let start = Math.max(indent, Math.min(first - PREVIEW_LEAD, text.length - max));
	if (first < start) start = first;
	start = Math.max(0, start);
	const end = Math.min(text.length, start + max);
	const prefix = start > indent ? '…' : '';
	const suffix = end < text.length ? '…' : '';
	const shift = prefix.length - start;
	return {
		line,
		preview: prefix + text.slice(start, end).trimEnd() + suffix,
		ranges: ranges
			.filter(([from]) => from >= start && from < end)
			.map(([from, to]) => [from + shift, Math.min(to, end) + shift]),
	};
}

/** Groups hits by file, keeping their order. */
function groupHits(hits: { rel: string; match: MatchLine }[], truncated: boolean): SearchResults {
	const byFile = new Map<string, MatchLine[]>();
	for (const { rel, match } of hits) {
		let lines = byFile.get(rel);
		if (!lines) byFile.set(rel, (lines = []));
		lines.push(match);
	}
	return {
		files: [...byFile].map(([rel, lines]) => ({ rel, lines })),
		matchCount: hits.length,
		truncated,
	};
}

/** A match in one of several searched repositories; `T` says which. */
export interface RepoHit<T> {
	target: T;
	/** Path relative to the repository's folder, '/'-separated. */
	rel: string;
	match: MatchLine;
}

/**
 * Searches file contents with `git grep` (fast, honours .gitignore, skips
 * binary files). Match ranges for display are computed with the JS regular
 * expression, so highlighting matches what the user typed.
 */
export class ContentSearch {
	/** Set once git reports it was built without PCRE, so regexes use `-E`. */
	private pcreUnavailable = false;

	/**
	 * Runs `query` in `repo`, stopping after `limit` lines; rejects with
	 * SyntaxError for an invalid regex, or GitError (also when cancelled).
	 */
	async run(repo: GitRepo, query: SearchQuery, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<SearchResults> {
		const re = compileQuery(query);
		const limit = opts.limit ?? MAX_SEARCH_MATCHES;
		let syntax: GrepSyntax = !query.regex ? 'fixed' : this.pcreUnavailable ? 'extended' : 'perl';
		const grep = (s: GrepSyntax) => repo.grep(
			{ pattern: query.text, syntax: s, caseSensitive: query.caseSensitive, wholeWord: query.wholeWord },
			limit,
			opts.signal,
		);
		let result: { hits: GrepHit[]; truncated: boolean };
		try {
			result = await grep(syntax);
		} catch (err) {
			if (syntax !== 'perl' || !(err instanceof GitError) || !isPcreUnsupported(err.message)) throw err;
			this.pcreUnavailable = true;
			syntax = 'extended';
			result = await grep(syntax);
		}
		const hits = result.hits.map((hit) => ({
			rel: repo.toFolderRelative(hit.path),
			match: makePreview(hit.line, hit.text, matchRanges(re, hit.text)),
		}));
		return groupHits(hits, result.truncated);
	}

	/**
	 * Runs `query` in each repository in order, stopping once
	 * `MAX_SEARCH_MATCHES` lines were found across all of them.
	 */
	async runAll<T extends { repo: GitRepo }>(
		targets: readonly T[],
		query: SearchQuery,
		signal?: AbortSignal,
	): Promise<{ hits: RepoHit<T>[]; truncated: boolean }> {
		compileQuery(query);
		const hits: RepoHit<T>[] = [];
		let truncated = false;
		for (const target of targets) {
			const left = MAX_SEARCH_MATCHES - hits.length;
			if (left <= 0) {
				truncated = true;
				break;
			}
			const results = await this.run(target.repo, query, { limit: left, signal });
			for (const file of results.files) {
				for (const match of file.lines) hits.push({ target, rel: file.rel, match });
			}
			truncated ||= results.truncated;
		}
		return { hits, truncated };
	}
}

