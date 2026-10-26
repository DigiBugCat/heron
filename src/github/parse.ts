/**
 * Turns GitHub REST and GraphQL responses into Heron's types. Pure
 * functions that tolerate missing fields, so a GitHub Enterprise server
 * that lacks a newer field still works.
 */
import type {
	CheckItem, CheckState, DiffSide, FileStatus, PullFile, PullRequest, PullState, ReviewComment, ReviewThread,
} from './types';

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
	return v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
}

function arr(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

function str(v: unknown, fallback = ''): string {
	return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function numOrNull(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** ISO 8601 time to seconds since the epoch (0 when missing). */
export function seconds(iso: unknown): number {
	const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
	return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

function login(user: unknown): string {
	return str(obj(user).login, 'ghost');
}

/** A pull request from `GET /repos/{owner}/{repo}/pulls` or `/pulls/{number}`. */
export function parsePull(raw: unknown): PullRequest {
	const p = obj(raw);
	const head = obj(p.head);
	const base = obj(p.base);
	const merged = p.merged === true || typeof p.merged_at === 'string';
	const state: PullState = merged ? 'merged' : p.state === 'closed' ? 'closed' : 'open';
	const headRepo = obj(head.repo);
	const baseRepo = obj(base.repo);
	const pull: PullRequest = {
		number: num(p.number),
		title: str(p.title),
		state,
		draft: p.draft === true,
		author: login(p.user),
		body: str(p.body),
		url: str(p.html_url),
		headRef: str(head.ref),
		headSha: str(head.sha),
		headRepo: typeof headRepo.full_name === 'string' ? headRepo.full_name : null,
		baseRef: str(base.ref),
		baseSha: str(base.sha),
		baseRepo: typeof baseRepo.full_name === 'string' ? baseRepo.full_name : null,
		createdAt: seconds(p.created_at),
		updatedAt: seconds(p.updated_at),
		requestedReviewers: arr(p.requested_reviewers).map(login),
	};
	if (typeof p.additions === 'number') pull.additions = p.additions;
	if (typeof p.deletions === 'number') pull.deletions = p.deletions;
	if (typeof p.changed_files === 'number') pull.changedFiles = p.changed_files;
	return pull;
}

const FILE_STATUSES = new Set<FileStatus>(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']);

/** An entry of `GET /repos/{owner}/{repo}/pulls/{number}/files`. */
export function parsePullFile(raw: unknown): PullFile {
	const f = obj(raw);
	const status = str(f.status) as FileStatus;
	return {
		path: str(f.filename),
		previousPath: typeof f.previous_filename === 'string' ? f.previous_filename : null,
		status: FILE_STATUSES.has(status) ? status : 'modified',
		additions: num(f.additions),
		deletions: num(f.deletions),
	};
}

/** A check run from `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`. */
export function parseCheckRun(raw: unknown): CheckItem {
	const c = obj(raw);
	const status = str(c.status);
	const conclusion = str(c.conclusion);
	let state: CheckState;
	if (status !== 'completed') state = 'pending';
	else if (conclusion === 'success') state = 'success';
	else if (['neutral', 'skipped', 'stale'].includes(conclusion)) state = 'neutral';
	else state = 'failure';
	const description = status === 'completed' ? conclusion.replace(/_/g, ' ') : status.replace(/_/g, ' ');
	return {
		name: str(c.name, 'check'),
		state,
		description,
		url: typeof c.html_url === 'string' ? c.html_url : typeof c.details_url === 'string' ? c.details_url : null,
	};
}

/** The `statuses` of `GET /repos/{owner}/{repo}/commits/{ref}/status`. */
export function parseCommitStatuses(raw: unknown): CheckItem[] {
	return arr(obj(raw).statuses).map((s) => {
		const st = obj(s);
		const state = str(st.state);
		return {
			name: str(st.context, 'status'),
			state: state === 'success' ? 'success' : state === 'pending' ? 'pending' : 'failure',
			description: str(st.description),
			url: typeof st.target_url === 'string' && st.target_url ? st.target_url : null,
		};
	});
}

/** One state for a set of checks: any failure wins, then anything still running. */
export function combineChecks(states: CheckState[]): CheckState {
	if (!states.length) return 'none';
	if (states.includes('failure')) return 'failure';
	if (states.includes('pending')) return 'pending';
	if (states.includes('success')) return 'success';
	return states.includes('neutral') ? 'neutral' : 'none';
}

/** A GraphQL `StatusState` (from `statusCheckRollup`) as a check state. */
export function rollupState(state: unknown): CheckState {
	switch (state) {
		case 'SUCCESS': return 'success';
		case 'FAILURE':
		case 'ERROR': return 'failure';
		case 'PENDING':
		case 'EXPECTED': return 'pending';
		default: return 'none';
	}
}

function parseComment(raw: unknown): ReviewComment {
	const c = obj(raw);
	return { author: login(c.author), body: str(c.body), createdAt: seconds(c.createdAt), url: str(c.url) };
}

/** A `PullRequestReviewThread` node from GraphQL. */
export function parseThread(raw: unknown): ReviewThread {
	const t = obj(raw);
	const comments = obj(t.comments);
	const nodes = arr(comments.nodes).map(parseComment);
	const outdated = t.isOutdated === true;
	const line = numOrNull(t.line) ?? numOrNull(t.originalLine);
	const startLine = numOrNull(t.startLine) ?? numOrNull(t.originalStartLine);
	const side: DiffSide = t.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT';
	return {
		id: str(t.id),
		path: str(t.path),
		line,
		startLine: startLine !== null && line !== null && startLine < line ? startLine : null,
		side,
		resolved: t.isResolved === true,
		outdated,
		comments: nodes,
		totalComments: Math.max(num(comments.totalCount, nodes.length), nodes.length),
	};
}

/** Per pull request results of the list summary GraphQL query. */
export interface SummaryExtras {
	checks: Map<number, CheckState>;
	unresolved: Map<number, number>;
}

/**
 * Reads the aliased `pr<n>` fields of the summary query: each pull request's
 * check rollup on its last commit and its count of unresolved threads.
 */
export function parseSummaryRepository(repository: unknown): SummaryExtras {
	const checks = new Map<number, CheckState>();
	const unresolved = new Map<number, number>();
	for (const value of Object.values(obj(repository))) {
		const pr = obj(value);
		if (typeof pr.number !== 'number') continue;
		const lastCommit = obj(arr(obj(pr.commits).nodes)[0]);
		checks.set(pr.number, rollupState(obj(obj(lastCommit.commit).statusCheckRollup).state));
		const threads = arr(obj(pr.reviewThreads).nodes);
		unresolved.set(pr.number, threads.filter((t) => obj(t).isResolved !== true).length);
	}
	return { checks, unresolved };
}

/** Pull request numbers found by a GraphQL `search` of type ISSUE. */
export function parseSearchNumbers(search: unknown): Set<number> {
	const numbers = new Set<number>();
	for (const node of arr(obj(search).nodes)) {
		const n = obj(node).number;
		if (typeof n === 'number') numbers.add(n);
	}
	return numbers;
}

/** The `rel="next"` URL of a `Link` header, or null on the last page. */
export function nextPageUrl(link: string | undefined): string | null {
	if (!link) return null;
	for (const part of link.split(',')) {
		const m = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim());
		if (m && m[2]?.split(/\s+/).includes('next')) return m[1] ?? null;
	}
	return null;
}
