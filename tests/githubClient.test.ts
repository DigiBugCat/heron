import { describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError, HttpRequest, HttpResponse, summaryQuery } from '../src/github/client';
import { combineChecks, nextPageUrl, parseCheckRun, parsePull, parseThread } from '../src/github/parse';

const REPO = { host: 'github.com', owner: 'o', name: 'r' };
const API = 'https://api.github.com';

type Handler = (req: HttpRequest) => Partial<HttpResponse> & { json?: unknown };

/** A transport answering from `routes` (matched by method and URL prefix) and recording requests. */
function fakeTransport(routes: [string, Handler][]) {
	const requests: HttpRequest[] = [];
	const transport = (req: HttpRequest): Promise<HttpResponse> => {
		requests.push(req);
		const key = `${req.method} ${req.url}`;
		const route = routes.find(([prefix]) => key.startsWith(prefix));
		if (!route) return Promise.resolve({ status: 404, headers: {}, text: '{"message":"Not Found"}', arrayBuffer: new ArrayBuffer(0) });
		const res = route[1](req);
		const text = res.text ?? (res.json !== undefined ? JSON.stringify(res.json) : '');
		return Promise.resolve({
			status: res.status ?? 200,
			headers: res.headers ?? {},
			text,
			arrayBuffer: res.arrayBuffer ?? new TextEncoder().encode(text).buffer,
		});
	};
	return { transport, requests };
}

function client(routes: [string, Handler][], host = 'github.com') {
	const fake = fakeTransport(routes);
	return { client: new GitHubClient({ host, token: 'tok', transport: fake.transport, now: () => 1_700_000_000_000 }), requests: fake.requests };
}

const rawPull = (number: number, extra: Record<string, unknown> = {}) => ({
	number,
	title: `PR ${number}`,
	state: 'open',
	draft: false,
	user: { login: 'alice' },
	body: 'Body',
	html_url: `https://github.com/o/r/pull/${number}`,
	head: { ref: `feature-${number}`, sha: `head${number}`, repo: { full_name: 'o/r' } },
	base: { ref: 'main', sha: 'base', repo: { full_name: 'o/r' } },
	created_at: '2026-10-01T00:00:00Z',
	updated_at: '2026-10-02T00:00:00Z',
	requested_reviewers: [],
	...extra,
});

describe('REST requests', () => {
	it('sends the token, accept header and API version to github.com only', async () => {
		const { client: com, requests } = client([[`GET ${API}/user`, () => ({ json: { login: 'me' } })]]);
		await com.viewer();
		expect(requests[0]?.headers).toMatchObject({ Authorization: 'Bearer tok', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });

		const ghe = client([['GET https://ghe.corp/api/v3/user', () => ({ json: { login: 'me' } })]], 'ghe.corp');
		expect(await ghe.client.viewer()).toBe('me');
		expect(ghe.requests[0]?.headers['X-GitHub-Api-Version']).toBeUndefined();
	});

	it('follows Link headers across pages and stops at the cap', async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => rawPull(i + 1));
		const page2 = [rawPull(101), rawPull(102)];
		const { client: c, requests } = client([
			[`GET ${API}/repos/o/r/pulls?per_page=100&state=open&sort=updated&direction=desc&page=2`, () => ({ json: page2 })],
			[`GET ${API}/repos/o/r/pulls`, () => ({ json: page1, headers: { Link: `<${API}/repos/o/r/pulls?per_page=100&state=open&sort=updated&direction=desc&page=2>; rel="next", <${API}/x?page=2>; rel="last"` } })],
		]);
		const all = await c.openPulls(REPO, 500);
		expect(all.items.map((p) => p.number)).toHaveLength(102);
		expect(all.truncated).toBe(false);
		expect(requests).toHaveLength(2);

		const capped = await c.openPulls(REPO, 100);
		expect(capped.items).toHaveLength(100);
		expect(capped.truncated).toBe(true);
	});

	it('never follows a next link to another host', async () => {
		const { client: c, requests } = client([
			[`GET ${API}/repos/o/r/pulls`, () => ({ json: [rawPull(1)], headers: { link: '<https://evil.example/steal?page=2>; rel="next"' } })],
		]);
		const page = await c.openPulls(REPO);
		expect(page.items).toHaveLength(1);
		expect(requests.every((r) => r.url.startsWith(API))).toBe(true);
	});

	it('revalidates with ETags and reuses the cached body on 304', async () => {
		let calls = 0;
		const { client: c, requests } = client([[`GET ${API}/repos/o/r/pulls/5`, (req) => {
			calls++;
			if (req.headers['If-None-Match'] === '"v1"') return { status: 304, headers: { ETag: '"v1"' } };
			return { json: rawPull(5), headers: { ETag: '"v1"' } };
		}]]);
		expect((await c.pull(REPO, 5)).title).toBe('PR 5');
		expect((await c.pull(REPO, 5)).title).toBe('PR 5');
		expect(calls).toBe(2);
		expect(requests[1]?.headers['If-None-Match']).toBe('"v1"');
	});

	it('explains 401, 404, 403 and network failures', async () => {
		const failing = (status: number, headers: Record<string, string> = {}, message = 'nope') =>
			client([[`GET ${API}/user`, () => ({ status, headers, json: { message } })]]).client;
		await expect(failing(401).viewer()).rejects.toMatchObject({ kind: 'auth', status: 401 });
		await expect(failing(401).viewer()).rejects.toThrow(/gh auth login --hostname github.com/);
		await expect(failing(404).viewer()).rejects.toMatchObject({ kind: 'not-found' });
		await expect(failing(403, {}, 'Resource not accessible').viewer()).rejects.toMatchObject({ kind: 'forbidden' });
		await expect(failing(500).viewer()).rejects.toMatchObject({ kind: 'http', status: 500 });

		const offline = new GitHubClient({ host: 'github.com', token: 't', transport: () => Promise.reject(new Error('ENOTFOUND')) });
		await expect(offline.viewer()).rejects.toMatchObject({ kind: 'network' });
	});

	it('reports rate limits with the reset time', async () => {
		const reset = 1_700_000_600;
		const limited = client([[`GET ${API}/user`, () => ({
			status: 403,
			headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Limit': '5000', 'X-RateLimit-Reset': String(reset) },
			json: { message: 'API rate limit exceeded' },
		})]]).client;
		const err = await limited.viewer().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GitHubError);
		expect(err).toMatchObject({ kind: 'rate-limit', resetAt: reset });
		expect(limited.rateLimit).toEqual({ remaining: 0, limit: 5000, reset });

		const secondary = client([[`GET ${API}/user`, () => ({ status: 429, headers: { 'retry-after': '30' }, json: { message: 'slow down' } })]]).client;
		await expect(secondary.viewer()).rejects.toMatchObject({ kind: 'rate-limit', resetAt: 1_700_000_030 });
	});
});

describe('GraphQL', () => {
	it('refuses mutations', async () => {
		const { client: c, requests } = client([]);
		await expect(c.graphql('mutation { addComment }', {})).rejects.toThrow(/Only GraphQL queries/);
		expect(requests).toHaveLength(0);
	});

	it('reads review threads across pages', async () => {
		const thread = (id: string, extra: Record<string, unknown>) => ({
			id,
			isResolved: false,
			isOutdated: false,
			path: 'src/a.ts',
			line: 10,
			originalLine: 9,
			startLine: null,
			originalStartLine: null,
			diffSide: 'RIGHT',
			comments: { totalCount: 1, nodes: [{ author: { login: 'bob' }, body: 'Why?', createdAt: '2026-10-03T00:00:00Z', url: 'https://github.com/c/1' }] },
			...extra,
		});
		const { client: c, requests } = client([[`POST ${API}/graphql`, (req) => {
			const { variables } = JSON.parse(req.body ?? '{}') as { variables: { after: string | null } };
			const page = variables.after === null
				? { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [thread('t1', {})] }
				: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [thread('t2', { isResolved: true, isOutdated: true, line: null, originalLine: 4, diffSide: 'LEFT', author: null })] };
			return { json: { data: { repository: { pullRequest: { reviewThreads: page } } } } };
		}]]);
		const threads = await c.reviewThreads(REPO, 3);
		expect(requests).toHaveLength(2);
		expect(threads).toEqual([
			{ id: 't1', path: 'src/a.ts', line: 10, startLine: null, side: 'RIGHT', resolved: false, outdated: false, totalComments: 1,
				comments: [{ author: 'bob', body: 'Why?', createdAt: Date.parse('2026-10-03T00:00:00Z') / 1000, url: 'https://github.com/c/1' }] },
			expect.objectContaining({ id: 't2', line: 4, side: 'LEFT', resolved: true, outdated: true }),
		]);
	});

	it('turns GraphQL errors into messages', async () => {
		const c = client([[`POST ${API}/graphql`, () => ({ json: { data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] } })]]).client;
		await expect(c.reviewThreads(REPO, 1)).rejects.toMatchObject({ kind: 'not-found' });
		const limited = client([[`POST ${API}/graphql`, () => ({ json: { errors: [{ type: 'RATE_LIMITED', message: 'limit' }] } })]]).client;
		await expect(limited.reviewThreads(REPO, 1)).rejects.toMatchObject({ kind: 'rate-limit' });
	});
});

describe('pull request summaries', () => {
	it('combines the REST list with checks, unresolved threads and review requests', async () => {
		const { client: c, requests } = client([
			[`GET ${API}/user`, () => ({ json: { login: 'me' } })],
			[`GET ${API}/repos/o/r/pulls`, () => ({ json: [rawPull(1), rawPull(2, { requested_reviewers: [{ login: 'me' }] }), rawPull(3, { user: { login: 'me' }, draft: true })] })],
			[`POST ${API}/graphql`, () => ({ json: { data: {
				repository: {
					pr1: { number: 1, reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } },
					pr2: { number: 2, reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } },
					pr3: { number: 3, reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } },
				},
				search: { nodes: [{ number: 1 }] },
			} } })],
		]);
		const { viewer, summaries } = await c.pullSummaries(REPO);
		expect(viewer).toBe('me');
		expect(summaries.map((s) => [s.pull.number, s.checks, s.unresolvedThreads, s.reviewRequested])).toEqual([
			[1, 'failure', 2, true],
			[2, 'none', 0, true],
			[3, 'pending', 0, false],
		]);
		const query = JSON.parse(requests.find((r) => r.method === 'POST')?.body ?? '{}') as { query: string; variables: Record<string, string> };
		expect(query.query).toMatch(/^query/);
		expect(query.variables.search).toBe('repo:o/r is:pr is:open review-requested:@me');
	});

	it('makes no GraphQL request when there are no open pull requests', async () => {
		const { client: c, requests } = client([
			[`GET ${API}/user`, () => ({ json: { login: 'me' } })],
			[`GET ${API}/repos/o/r/pulls`, () => ({ json: [] })],
		]);
		expect((await c.pullSummaries(REPO)).summaries).toEqual([]);
		expect(requests.some((r) => r.method === 'POST')).toBe(false);
	});

	it('builds one aliased field per pull request', () => {
		const q = summaryQuery([4, 9], false);
		expect(q).toContain('pr4: pullRequest(number: 4)');
		expect(q).toContain('pr9: pullRequest(number: 9)');
		expect(q).not.toContain('search(');
	});
});

describe('files, checks and branches', () => {
	it('reads file contents raw, with missing, binary and oversized files', async () => {
		const { client: c, requests } = client([
			[`GET ${API}/repos/o/r/contents/src/a%20b.ts?ref=abc`, () => ({ text: 'const a = 1;\n' })],
			[`GET ${API}/repos/o/r/contents/img.png`, () => ({ arrayBuffer: new Uint8Array([137, 80, 0, 1]).buffer })],
			[`GET ${API}/repos/o/r/contents/big.txt`, () => ({ arrayBuffer: new ArrayBuffer(3 * 1024 * 1024) })],
		]);
		expect(await c.fileAt(REPO, 'src/a b.ts', 'abc')).toEqual({ kind: 'text', text: 'const a = 1;\n' });
		expect(requests[0]?.headers.Accept).toBe('application/vnd.github.raw+json');
		expect(await c.fileAt(REPO, 'gone.ts', 'abc')).toEqual({ kind: 'missing' });
		expect((await c.fileAt(REPO, 'img.png', 'abc')).kind).toBe('binary');
		expect((await c.fileAt(REPO, 'big.txt', 'abc')).kind).toBe('too-large');
	});

	it('lists changed files and combines check runs with commit statuses', async () => {
		const { client: c } = client([
			[`GET ${API}/repos/o/r/pulls/2/files`, () => ({ json: [
				{ filename: 'new.ts', status: 'added', additions: 3, deletions: 0 },
				{ filename: 'b.ts', previous_filename: 'a.ts', status: 'renamed', additions: 1, deletions: 1 },
			] })],
			[`GET ${API}/repos/o/r/commits/sha/check-runs`, () => ({ json: { total_count: 2, check_runs: [
				{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://ci/1' },
				{ name: 'lint', status: 'in_progress', conclusion: null },
			] } })],
			[`GET ${API}/repos/o/r/commits/sha/status`, () => ({ json: { state: 'failure', statuses: [{ context: 'ci/legacy', state: 'error', description: 'Broke', target_url: 'https://ci/2' }] } })],
		]);
		const files = await c.pullFiles(REPO, 2);
		expect(files.items).toEqual([
			{ path: 'new.ts', previousPath: null, status: 'added', additions: 3, deletions: 0 },
			{ path: 'b.ts', previousPath: 'a.ts', status: 'renamed', additions: 1, deletions: 1 },
		]);
		const checks = await c.checks(REPO, 'sha');
		expect(checks.map((ch) => [ch.name, ch.state])).toEqual([['test', 'success'], ['lint', 'pending'], ['ci/legacy', 'failure']]);
		expect(combineChecks(checks.map((ch) => ch.state))).toBe('failure');
	});

	it('finds the pull request for a branch, falling back to forks and closed ones', async () => {
		const own = client([[`GET ${API}/repos/o/r/pulls?state=open&head=o%3Afeat`, () => ({ json: [rawPull(8)] })]]).client;
		expect((await own.pullForBranch(REPO, 'feat'))?.number).toBe(8);

		const fork = client([
			[`GET ${API}/repos/o/r/pulls?state=open&head=`, () => ({ json: [] })],
			[`GET ${API}/repos/o/r/pulls?per_page=100&state=open`, () => ({ json: [rawPull(4, { head: { ref: 'feat', sha: 'x', repo: { full_name: 'fork/r' } } })] })],
		]).client;
		expect((await fork.pullForBranch(REPO, 'feat'))?.number).toBe(4);

		const closed = client([
			[`GET ${API}/repos/o/r/pulls?state=open&head=`, () => ({ json: [] })],
			[`GET ${API}/repos/o/r/pulls?per_page=100&state=open`, () => ({ json: [] })],
			[`GET ${API}/repos/o/r/pulls?state=all`, () => ({ json: [rawPull(2, { state: 'closed', merged_at: '2026-01-01T00:00:00Z' })] })],
		]).client;
		const found = await closed.pullForBranch(REPO, 'feat');
		expect(found?.number).toBe(2);
		expect(found?.state).toBe('merged');
	});
});

describe('parsing', () => {
	it('reads next links', () => {
		expect(nextPageUrl('<https://a/x?page=3>; rel="next", <https://a/x?page=9>; rel="last"')).toBe('https://a/x?page=3');
		expect(nextPageUrl('<https://a/x?page=1>; rel="prev"')).toBeNull();
		expect(nextPageUrl(undefined)).toBeNull();
	});

	it('tolerates missing fields', () => {
		const pull = parsePull({ number: 1 });
		expect(pull).toMatchObject({ number: 1, title: '', author: 'ghost', state: 'open', headRepo: null, requestedReviewers: [] });
		expect(parseThread({})).toMatchObject({ line: null, side: 'RIGHT', comments: [], totalComments: 0 });
		expect(parseCheckRun({ status: 'completed', conclusion: 'timed_out' }).state).toBe('failure');
		expect(parseCheckRun({ status: 'completed', conclusion: 'skipped' }).state).toBe('neutral');
	});

	it('combines check states, failures first', () => {
		expect(combineChecks([])).toBe('none');
		expect(combineChecks(['success', 'pending'])).toBe('pending');
		expect(combineChecks(['pending', 'failure'])).toBe('failure');
		expect(combineChecks(['neutral', 'success'])).toBe('success');
	});
});
