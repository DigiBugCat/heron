import { decodeContent, LoadedContent, MAX_VIEW_BYTES } from '../utils/content';
import {
	nextPageUrl, parseCheckRun, parseCommitStatuses, parsePull, parsePullFile,
	parseSearchNumbers, parseSummaryRepository, parseThread,
} from './parse';
import { endpointsFor, GitHubRepoRef, HostEndpoints, isGitHubCom } from './remote';
import type { CheckItem, PullFile, PullRequest, PullSummary, ReviewThread } from './types';

/**
 * A read-only GitHub API client for one host and token. It only sends GET
 * requests and GraphQL queries — never mutations — through an injected
 * transport (Obsidian's `requestUrl` in the app, a fake in tests).
 */

export interface HttpRequest {
	url: string;
	method: 'GET' | 'POST';
	headers: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	/** Header names in any case; the client lower-cases them. */
	headers: Record<string, string>;
	text: string;
	arrayBuffer: ArrayBuffer;
}

/** Sends one request; resolves for every HTTP status and rejects only when the host can't be reached. */
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export type GitHubErrorKind = 'auth' | 'forbidden' | 'not-found' | 'rate-limit' | 'network' | 'graphql' | 'http';

export class GitHubError extends Error {
	constructor(
		readonly kind: GitHubErrorKind,
		message: string,
		readonly status = 0,
		/** For rate limits: when requests are allowed again, in seconds since the epoch. */
		readonly resetAt: number | null = null,
	) {
		super(message);
	}
}

/** Most pull requests the list loads (the most recently updated). */
export const MAX_LIST_PULLS = 100;
/** GitHub returns at most 3,000 files for a pull request. */
export const MAX_PULL_FILES = 3000;
const MAX_CHECKS = 300;
/** Review threads loaded per pull request. */
export const MAX_THREADS = 500;
/** Pages of any one listing, as a guard against a server that never stops paginating. */
const MAX_PAGES = 30;
/** Responses kept for conditional requests. */
const MAX_ETAG_ENTRIES = 200;
/** Pull requests per summary query. */
const SUMMARY_CHUNK = 50;

export interface RateLimit {
	limit: number;
	remaining: number;
	/** Seconds since the epoch. */
	reset: number;
}

export interface ClientOptions {
	host: string;
	token: string;
	transport: Transport;
	/** Current time in ms, for tests. */
	now?: () => number;
}

interface Page<T> { items: T[]; truncated: boolean }

/** Escapes each segment of a repository path for a URL. */
function encodePath(p: string): string {
	return p.split('/').map(encodeURIComponent).join('/');
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
	return out;
}

function errorMessageOf(text: string): string {
	try {
		const body = JSON.parse(text) as { message?: unknown };
		if (typeof body.message === 'string') return body.message;
	} catch { /* not JSON */ }
	return text.slice(0, 200);
}

function clockTime(secondsSinceEpoch: number): string {
	return new Date(secondsSinceEpoch * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export class GitHubClient {
	readonly host: string;
	readonly endpoints: HostEndpoints;
	/** The latest rate limit headers seen, if any. */
	rateLimit: RateLimit | null = null;
	private token: string;
	private transport: Transport;
	private now: () => number;
	private etags = new Map<string, { etag: string; text: string }>();
	private viewerLogin: Promise<string> | null = null;
	/** Merge bases never change for a pair of commits. */
	private mergeBases = new Map<string, string>();

	constructor(opts: ClientOptions) {
		this.host = opts.host;
		this.endpoints = endpointsFor(opts.host);
		this.token = opts.token;
		this.transport = opts.transport;
		this.now = opts.now ?? (() => Date.now());
	}

	// ── Low level ─────────────────────────────────────────────────

	private headers(accept: string): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: accept,
			Authorization: `Bearer ${this.token}`,
		};
		// GitHub Enterprise Server before 3.9 doesn't know API versions.
		if (isGitHubCom(this.host)) headers['X-GitHub-Api-Version'] = '2022-11-28';
		return headers;
	}

	private async send(request: HttpRequest, what: string): Promise<HttpResponse & { headers: Record<string, string> }> {
		let res: HttpResponse;
		try {
			res = await this.transport(request);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			throw new GitHubError('network', `Could not reach ${this.host}: ${reason}`);
		}
		const headers = lowerKeys(res.headers);
		this.noteRateLimit(headers);
		if (res.status >= 400) throw this.errorFor(res.status, headers, res.text, what);
		return { ...res, headers };
	}

	private noteRateLimit(headers: Record<string, string>) {
		const remaining = Number(headers['x-ratelimit-remaining']);
		const limit = Number(headers['x-ratelimit-limit']);
		const reset = Number(headers['x-ratelimit-reset']);
		if (headers['x-ratelimit-remaining'] !== undefined && Number.isFinite(remaining)) {
			this.rateLimit = { remaining, limit: Number.isFinite(limit) ? limit : 0, reset: Number.isFinite(reset) ? reset : 0 };
		}
	}

	private errorFor(status: number, headers: Record<string, string>, text: string, what: string): GitHubError {
		const message = errorMessageOf(text);
		const retryAfter = Number(headers['retry-after']);
		const isRateLimit = (status === 403 || status === 429)
			&& (headers['x-ratelimit-remaining'] === '0' || Number.isFinite(retryAfter) || /rate limit/i.test(message));
		if (isRateLimit) {
			const reset = Number.isFinite(retryAfter)
				? Math.ceil(this.now() / 1000 + retryAfter)
				: Number(headers['x-ratelimit-reset']) || Math.ceil(this.now() / 1000 + 60);
			return new GitHubError('rate-limit', `GitHub's rate limit for ${this.host} is used up. Try again after ${clockTime(reset)}.`, status, reset);
		}
		if (status === 401) {
			return new GitHubError('auth', `GitHub rejected the token for ${this.host}. Paste a new token in Settings → Heron → GitHub, or run "gh auth login --hostname ${this.host}".`, status);
		}
		if (status === 404) {
			return new GitHubError('not-found', `${what} was not found on ${this.host}. If the repository is private, check that the token can read it.`, status);
		}
		if (status === 403) {
			return new GitHubError('forbidden', `${this.host} refused access to ${what}: ${message}. The token may need the "repo" scope or SSO authorization.`, status);
		}
		return new GitHubError('http', `${this.host} returned ${status} for ${what}: ${message}`, status);
	}

	/** A GET with conditional request caching: unchanged resources come back as 304 and cost no rate limit. */
	private async get(url: string, what: string, accept = 'application/vnd.github+json', cache = true): Promise<{ text: string; headers: Record<string, string> }> {
		const key = `${accept} ${url}`;
		const cached = cache ? this.etags.get(key) : undefined;
		const headers = this.headers(accept);
		if (cached) headers['If-None-Match'] = cached.etag;
		const res = await this.send({ url, method: 'GET', headers }, what);
		if (res.status === 304) {
			if (!cached) throw new GitHubError('http', `${this.host} returned 304 for ${what} without a cached copy`, 304);
			// Refresh its position so the cache drops the least recently used entry.
			this.etags.delete(key);
			this.etags.set(key, cached);
			return { text: cached.text, headers: res.headers };
		}
		const etag = res.headers.etag;
		if (etag && cache) {
			this.etags.delete(key);
			this.etags.set(key, { etag, text: res.text });
			while (this.etags.size > MAX_ETAG_ENTRIES) {
				const oldest = this.etags.keys().next().value;
				if (oldest === undefined) break;
				this.etags.delete(oldest);
			}
		}
		return { text: res.text, headers: res.headers };
	}

	private url(apiPath: string, query: Record<string, string | number> = {}): string {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(query)) params.set(k, String(v));
		const qs = params.toString();
		return `${this.endpoints.rest}${apiPath}${qs ? `?${qs}` : ''}`;
	}

	/** GET a JSON resource. */
	async rest(apiPath: string, query: Record<string, string | number> = {}, what = apiPath): Promise<unknown> {
		const { text } = await this.get(this.url(apiPath, query), what);
		return JSON.parse(text) as unknown;
	}

	/**
	 * GET every page of a listing (following `Link: rel="next"`) up to
	 * `maxItems`. `pick` extracts the items from wrapped responses such as
	 * `{ check_runs: [...] }`.
	 */
	async restPages(
		apiPath: string,
		query: Record<string, string | number>,
		maxItems: number,
		pick: (body: unknown) => unknown[] = (body) => (Array.isArray(body) ? body : []),
		what = apiPath,
	): Promise<Page<unknown>> {
		const items: unknown[] = [];
		let url: string | null = this.url(apiPath, { per_page: 100, ...query });
		for (let page = 0; url && page < MAX_PAGES; page++) {
			const res: { text: string; headers: Record<string, string> } = await this.get(url, what);
			items.push(...pick(JSON.parse(res.text) as unknown));
			if (items.length >= maxItems) return { items: items.slice(0, maxItems), truncated: true };
			url = nextPageUrl(res.headers.link);
			// Never send the token anywhere but this host's API.
			if (url && !url.startsWith(`${this.endpoints.rest}/`)) url = null;
		}
		return { items, truncated: !!url };
	}

	/** Runs a GraphQL query. Mutations are refused: Heron only reads from GitHub. */
	async graphql(query: string, variables: Record<string, unknown>, what = 'GraphQL query'): Promise<Record<string, unknown>> {
		if (!/^\s*query\b/.test(query)) throw new Error('Only GraphQL queries are allowed');
		const res = await this.send({
			url: this.endpoints.graphql,
			method: 'POST',
			headers: { ...this.headers('application/json'), 'Content-Type': 'application/json' },
			body: JSON.stringify({ query, variables }),
		}, what);
		const body = JSON.parse(res.text) as { data?: Record<string, unknown> | null; errors?: { type?: string; message?: string }[] };
		const errors = body.errors ?? [];
		if (errors.length && !body.data) {
			const first = errors[0] ?? {};
			if (first.type === 'RATE_LIMITED') {
				const reset = this.rateLimit?.reset || Math.ceil(this.now() / 1000 + 60);
				throw new GitHubError('rate-limit', `GitHub's rate limit for ${this.host} is used up. Try again after ${clockTime(reset)}.`, res.status, reset);
			}
			if (first.type === 'NOT_FOUND') throw new GitHubError('not-found', `${what}: ${first.message ?? 'not found'}`, res.status);
			throw new GitHubError('graphql', `${what} failed on ${this.host}: ${errors.map((e) => e.message).join('; ')}`, res.status);
		}
		return body.data ?? {};
	}

	// ── Pull requests ─────────────────────────────────────────────

	/** The login of the token's user, asked once per client. */
	viewer(): Promise<string> {
		this.viewerLogin ??= this.rest('/user', {}, 'Your account').then((u) => {
			const login = (u as { login?: unknown }).login;
			if (typeof login !== 'string') throw new GitHubError('http', `${this.host} returned no user for this token`);
			return login;
		});
		this.viewerLogin.catch(() => { this.viewerLogin = null; });
		return this.viewerLogin;
	}

	private repoPath(ref: GitHubRepoRef): string {
		return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
	}

	/** Open pull requests, most recently updated first. */
	async openPulls(ref: GitHubRepoRef, max = MAX_LIST_PULLS): Promise<Page<PullRequest>> {
		const page = await this.restPages(`${this.repoPath(ref)}/pulls`, { state: 'open', sort: 'updated', direction: 'desc' }, max,
			undefined, `${ref.owner}/${ref.name}`);
		return { items: page.items.map(parsePull), truncated: page.truncated };
	}

	async pull(ref: GitHubRepoRef, number: number): Promise<PullRequest> {
		return parsePull(await this.rest(`${this.repoPath(ref)}/pulls/${number}`, {}, `Pull request #${number}`));
	}

	async pullFiles(ref: GitHubRepoRef, number: number): Promise<Page<PullFile>> {
		const page = await this.restPages(`${this.repoPath(ref)}/pulls/${number}/files`, {}, MAX_PULL_FILES,
			undefined, `Files of pull request #${number}`);
		return { items: page.items.map(parsePullFile), truncated: page.truncated };
	}

	/**
	 * The merge base of `base` and `head` — what GitHub diffs a pull request
	 * against — from the compare API.
	 */
	async mergeBase(ref: GitHubRepoRef, base: string, head: string): Promise<string> {
		const key = `${ref.owner}/${ref.name} ${base}...${head}`;
		const known = this.mergeBases.get(key);
		if (known) return known;
		const url = this.url(`${this.repoPath(ref)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, { per_page: 1 });
		// Compare responses carry whole patches; don't keep them for conditional requests.
		const { text } = await this.get(url, 'Merge base', undefined, false);
		const sha = (JSON.parse(text) as { merge_base_commit?: { sha?: unknown } }).merge_base_commit?.sha;
		if (typeof sha !== 'string') throw new GitHubError('http', `${this.host} returned no merge base`);
		if (this.mergeBases.size > MAX_ETAG_ENTRIES) this.mergeBases.clear();
		this.mergeBases.set(key, sha);
		return sha;
	}

	/** Check runs and commit statuses of `sha`. */
	async checks(ref: GitHubRepoRef, sha: string): Promise<CheckItem[]> {
		const commit = `${this.repoPath(ref)}/commits/${encodeURIComponent(sha)}`;
		const [runs, statuses] = await Promise.all([
			this.restPages(`${commit}/check-runs`, {}, MAX_CHECKS,
				(body) => ((body as { check_runs?: unknown[] }).check_runs ?? []), 'Check runs'),
			this.rest(`${commit}/status`, {}, 'Commit status'),
		]);
		return [...runs.items.map(parseCheckRun), ...parseCommitStatuses(statuses)];
	}

	/**
	 * A file's content at `sha`, through the contents API's raw media type.
	 * Missing files (e.g. the base side of an added file) come back as `missing`.
	 */
	async fileAt(ref: GitHubRepoRef, filePath: string, sha: string): Promise<LoadedContent> {
		const url = this.url(`${this.repoPath(ref)}/contents/${encodePath(filePath)}`, { ref: sha });
		let res;
		try {
			res = await this.send({ url, method: 'GET', headers: this.headers('application/vnd.github.raw+json') }, filePath);
		} catch (err) {
			if (err instanceof GitHubError && err.kind === 'not-found') return { kind: 'missing' };
			throw err;
		}
		const size = res.arrayBuffer.byteLength;
		if (size > MAX_VIEW_BYTES) return { kind: 'too-large', size };
		return decodeContent(Buffer.from(res.arrayBuffer));
	}

	/** Every review thread of a pull request, with its comments. */
	async reviewThreads(ref: GitHubRepoRef, number: number): Promise<ReviewThread[]> {
		const threads: ReviewThread[] = [];
		let after: string | null = null;
		for (let page = 0; page < MAX_PAGES && threads.length < MAX_THREADS; page++) {
			const data = await this.graphql(THREADS_QUERY, { owner: ref.owner, name: ref.name, number, after }, `Review threads of #${number}`);
			const repository = data.repository as { pullRequest?: { reviewThreads?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } } | null } | null;
			const conn = repository?.pullRequest?.reviewThreads;
			if (!conn) throw new GitHubError('not-found', `Pull request #${number} was not found on ${this.host}`);
			threads.push(...(conn.nodes ?? []).map(parseThread));
			if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
			after = conn.pageInfo.endCursor;
		}
		return threads.slice(0, MAX_THREADS);
	}

	/**
	 * Open pull requests with what the list shows for each: combined check
	 * state, unresolved thread count and whether your review is requested.
	 * One REST listing plus one GraphQL query per 50 pull requests, instead of
	 * several REST calls for every pull request.
	 */
	async pullSummaries(ref: GitHubRepoRef): Promise<{ viewer: string; summaries: PullSummary[]; truncated: boolean }> {
		const [viewer, list] = await Promise.all([this.viewer(), this.openPulls(ref)]);
		const pulls = list.items;
		const checks = new Map<number, PullSummary['checks']>();
		const unresolved = new Map<number, number>();
		let requested = new Set<number>();
		for (let i = 0; i < pulls.length; i += SUMMARY_CHUNK) {
			const chunk = pulls.slice(i, i + SUMMARY_CHUNK).map((p) => p.number);
			const data = await this.graphql(summaryQuery(chunk, i === 0), {
				owner: ref.owner,
				name: ref.name,
				...(i === 0 ? { search: `repo:${ref.owner}/${ref.name} is:pr is:open review-requested:@me` } : {}),
			}, 'Pull request details');
			const extras = parseSummaryRepository(data.repository);
			for (const [n, s] of extras.checks) checks.set(n, s);
			for (const [n, c] of extras.unresolved) unresolved.set(n, c);
			if (i === 0) requested = parseSearchNumbers(data.search);
		}
		const summaries = pulls.map((pull) => ({
			pull,
			checks: checks.get(pull.number) ?? 'none',
			unresolvedThreads: unresolved.get(pull.number) ?? 0,
			reviewRequested: requested.has(pull.number) || pull.requestedReviewers.includes(viewer),
		}));
		return { viewer, summaries, truncated: list.truncated };
	}

	/**
	 * The pull request whose head branch is `branch`: an open one from this
	 * repository first, then an open one from a fork, then the most recently
	 * updated closed or merged one.
	 */
	async pullForBranch(ref: GitHubRepoRef, branch: string): Promise<PullRequest | null> {
		const base = `${this.repoPath(ref)}/pulls`;
		const head = `${ref.owner}:${branch}`;
		const open = await this.rest(base, { state: 'open', head, per_page: 5 }, `${ref.owner}/${ref.name}`);
		const first: unknown = Array.isArray(open) ? open[0] : undefined;
		if (first) return parsePull(first);
		const fromFork = (await this.openPulls(ref)).items.find((p) => p.headRef === branch);
		if (fromFork) return fromFork;
		const all = await this.rest(base, { state: 'all', head, sort: 'updated', direction: 'desc', per_page: 1 }, `${ref.owner}/${ref.name}`);
		const last: unknown = Array.isArray(all) ? all[0] : undefined;
		return last ? parsePull(last) : null;
	}
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine startLine originalStartLine diffSide
          comments(first: 50) { totalCount nodes { author { login } body createdAt url } }
        }
      }
    }
  }
}`;

/** The list's GraphQL query for `numbers`; the first chunk also searches for your review requests. */
export function summaryQuery(numbers: number[], withSearch: boolean): string {
	const fields = numbers.map((n) => `pr${n}: pullRequest(number: ${Math.floor(n)}) {
      number
      reviewThreads(first: 100) { nodes { isResolved } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }`).join('\n    ');
	const vars = withSearch ? '$owner: String!, $name: String!, $search: String!' : '$owner: String!, $name: String!';
	const search = withSearch ? '\n  search(query: $search, type: ISSUE, first: 100) { nodes { ... on PullRequest { number } } }' : '';
	return `query(${vars}) {
  repository(owner: $owner, name: $name) {
    ${fields || '__typename'}
  }${search}
}`;
}
