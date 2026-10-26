import type { GitRepo } from '../git/GitRepo';
import type { ChangeEntry, RepoStatus } from '../git/status';
import { LatestRequest } from '../utils/latest';

export type BaseComparison =
	| { kind: 'ok'; ref: string; commit: string; ahead: number; entries: ChangeEntry[] }
	| { kind: 'error'; ref: string | null; message: string };

/** What to show for a repository in base mode: a comparison, or one being computed. */
export type BaseView = BaseComparison | { kind: 'loading'; ref: string | null };

interface Tracked {
	/** Inputs of the comparison shown or being computed. */
	key: string;
	view: BaseView;
	request: LatestRequest;
	/** The base branch asked for; null for the default. */
	chosen: string | null;
}

/**
 * Keeps one base comparison per repository current. `update` is cheap to
 * call on every refresh: it recomputes only when the repository's status
 * or chosen base changed, and the latest request wins.
 */
export class BaseComparisons {
	private tracked = new Map<string, Tracked>();

	/** `onUpdate` runs when a comparison finishes; callers read the loading state from `view` right after `update`. */
	constructor(private onUpdate: () => void) {}

	/** The comparison for the repository `id` (its common git dir), or null when none was asked for. */
	view(id: string): BaseView | null {
		return this.tracked.get(id)?.view ?? null;
	}

	/**
	 * Compares `repo` at `status` with `chosen`, or with its default base
	 * branch when null. `force` recomputes even when nothing changed.
	 */
	update(id: string, repo: GitRepo, status: RepoStatus, chosen: string | null, force = false) {
		const key = JSON.stringify([repo.gitDir, repo.folder, chosen, status]);
		let tracked = this.tracked.get(id);
		if (tracked && tracked.key === key && !force) return;
		const keepShown = !!tracked && tracked.view.kind !== 'loading' && tracked.chosen === chosen;
		if (!tracked) {
			tracked = { key, view: { kind: 'loading', ref: chosen }, request: new LatestRequest(), chosen };
			this.tracked.set(id, tracked);
		}
		tracked.key = key;
		tracked.chosen = chosen;
		// Keep the old list while a refresh runs, unless the base branch changed.
		if (!keepShown) tracked.view = { kind: 'loading', ref: chosen };
		const entry = tracked;
		const token = entry.request.next();
		void (async () => {
			const ref = chosen ?? (await repo.defaultBase().catch(() => null));
			const result = await compareWithBase(repo, ref, status).catch((err: unknown): BaseComparison => ({
				kind: 'error',
				ref,
				message: err instanceof Error ? err.message : String(err),
			}));
			if (!entry.request.isCurrent(token) || this.tracked.get(id) !== entry) return;
			entry.view = result;
			this.onUpdate();
		})();
	}

	/** Stops tracking `id`, e.g. when its repository leaves base mode. */
	drop(id: string) {
		this.tracked.get(id)?.request.cancel();
		this.tracked.delete(id);
	}

	clear() {
		for (const id of [...this.tracked.keys()]) this.drop(id);
	}
}

/**
 * Everything the working tree changed since it branched off `ref`: tracked
 * files that differ from the merge base of HEAD and `ref` (committed,
 * staged or not), plus untracked files from `status`.
 */
export async function compareWithBase(repo: GitRepo, ref: string | null, status: RepoStatus): Promise<BaseComparison> {
	if (!ref) return { kind: 'error', ref, message: 'No base branch found — select one above' };
	if (!(await repo.hasCommit(ref))) return { kind: 'error', ref, message: `Branch ${ref} not found` };
	let commit: string;
	try {
		commit = await repo.mergeBase(ref);
	} catch {
		return { kind: 'error', ref, message: `No common history with ${ref}` };
	}
	const [changes, ahead] = await Promise.all([repo.diffAgainst(commit), repo.commitsSince(commit)]);
	const base = { ref, commit };
	const entries: ChangeEntry[] = changes.map((c) => ({
		group: 'base',
		kind: c.kind,
		base,
		file: {
			path: c.path,
			origPath: c.origPath,
			index: '.',
			worktree: '.',
			untracked: false,
			conflicted: c.kind === 'conflicted',
		},
	}));
	const seen = new Set(changes.map((c) => c.path));
	for (const file of status.files) {
		if (file.untracked && !seen.has(file.path)) entries.push({ group: 'base', kind: 'untracked', base, file });
	}
	entries.sort((a, b) => a.file.path.localeCompare(b.file.path));
	return { kind: 'ok', ref, commit, ahead, entries };
}
