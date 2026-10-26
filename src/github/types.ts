/** Heron's view of GitHub pull request data, independent of the API's shapes. */

/** Overall result of a commit's checks and statuses. */
export type CheckState = 'success' | 'failure' | 'pending' | 'neutral' | 'none';

export type PullState = 'open' | 'closed' | 'merged';

export interface PullRequest {
	number: number;
	title: string;
	state: PullState;
	draft: boolean;
	author: string;
	/** Markdown description; '' when empty. */
	body: string;
	/** Web page of the pull request. */
	url: string;
	headRef: string;
	headSha: string;
	/** `owner/name` the head branch lives in, or null when that fork was deleted. */
	headRepo: string | null;
	baseRef: string;
	baseSha: string;
	/** `owner/name` of the repository the pull request targets. */
	baseRepo: string | null;
	/** Seconds since the epoch. */
	createdAt: number;
	updatedAt: number;
	/** Logins whose review is requested (teams are not included). */
	requestedReviewers: string[];
	/** Only present on single pull request responses. */
	additions?: number;
	deletions?: number;
	changedFiles?: number;
}

export type FileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

/** A file a pull request changes. */
export interface PullFile {
	path: string;
	/** The path on the base side for renamed and copied files. */
	previousPath: string | null;
	status: FileStatus;
	additions: number;
	deletions: number;
}

/** One check run or commit status. */
export interface CheckItem {
	name: string;
	state: CheckState;
	/** Short explanation, e.g. a check run's conclusion or a status description. */
	description: string;
	url: string | null;
}

export interface ReviewComment {
	author: string;
	/** Markdown. */
	body: string;
	/** Seconds since the epoch. */
	createdAt: number;
	url: string;
}

/** Which side of the diff a review thread is attached to. */
export type DiffSide = 'LEFT' | 'RIGHT';

export interface ReviewThread {
	id: string;
	path: string;
	/** Line on `side` (1-based); for outdated threads, the line it was written on. Null for file-level threads. */
	line: number | null;
	/** First line of a multi-line thread, or null. */
	startLine: number | null;
	side: DiffSide;
	resolved: boolean;
	/** The lines it was written on have changed since. */
	outdated: boolean;
	comments: ReviewComment[];
	/** Number of comments on GitHub; more than `comments.length` when cut off. */
	totalComments: number;
}

/** What the pull request list shows for one pull request. */
export interface PullSummary {
	pull: PullRequest;
	checks: CheckState;
	unresolvedThreads: number;
	/** Your review is requested, directly or through a team. */
	reviewRequested: boolean;
}
