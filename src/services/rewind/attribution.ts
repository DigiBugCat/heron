/**
 * Decides who made each file change. Pure: works on records only, so late
 * evidence (a hook line written after the change was captured) still counts.
 */
import type { ClaudeRecord, FileRecord, GitRecord, Source } from './records';

/** A Claude hook line is written after its tool changed the file. */
export const CLAUDE_BEFORE_MS = 20_000;
export const CLAUDE_AFTER_MS = 3_000;
/** Git's file changes usually arrive before Heron notices HEAD moved. */
export const GIT_BEFORE_MS = 10_000;
export const GIT_AFTER_MS = 5_000;

export interface AttributedChange extends Omit<FileRecord, 'source'> {
	source: Source;
	claude?: ClaudeRecord;
	git?: GitRecord;
}

/**
 * Labels each change (baselines excluded) with its source:
 * - `heron` when Heron wrote it (known at capture time);
 * - `claude` when a Claude Code tool call wrote that file shortly before
 *   its hook line;
 * - `git` when HEAD moved in its repository around the same time
 *   (checkout, pull, reset…);
 * - `external` otherwise.
 * The closest match in time wins.
 */
export function attribute(files: readonly FileRecord[], claude: readonly ClaudeRecord[], git: readonly GitRecord[]): AttributedChange[] {
	const claudeByPath = new Map<string, ClaudeRecord[]>();
	for (const c of claude) {
		for (const f of c.files) {
			let list = claudeByPath.get(f);
			if (!list) claudeByPath.set(f, list = []);
			list.push(c);
		}
	}
	const gitByRepo = new Map<string, GitRecord[]>();
	for (const g of git) {
		let list = gitByRepo.get(g.repo);
		if (!list) gitByRepo.set(g.repo, list = []);
		list.push(g);
	}

	const result: AttributedChange[] = [];
	for (const f of files) {
		if (f.kind === 'baseline') continue;
		if (f.source === 'heron') {
			result.push({ ...f, source: 'heron' });
			continue;
		}
		const candidates = [...(claudeByPath.get(f.path) ?? []), ...(f.oldPath ? claudeByPath.get(f.oldPath) ?? [] : [])];
		const c = closest(candidates, f.t, CLAUDE_BEFORE_MS, CLAUDE_AFTER_MS);
		if (c) {
			result.push({ ...f, source: 'claude', claude: c });
			continue;
		}
		const g = closest(gitByRepo.get(f.repo) ?? [], f.t, GIT_BEFORE_MS, GIT_AFTER_MS);
		result.push(g ? { ...f, source: 'git', git: g } : { ...f, source: 'external' });
	}
	return result;
}

/**
 * The record whose time is nearest `t`, among those with
 * `record.t - before <= t <= record.t + after`.
 */
function closest<T extends { t: number }>(records: readonly T[], t: number, before: number, after: number): T | null {
	let best: T | null = null;
	for (const r of records) {
		if (t < r.t - before || t > r.t + after) continue;
		if (!best || Math.abs(r.t - t) < Math.abs(best.t - t)) best = r;
	}
	return best;
}

/** Reflog operations that do not change the working tree. */
const NO_FILE_CHANGES = /^(commit|branch)\b/;

/** True when a reflog subject describes an operation that changes files (not a commit). */
export function changesFiles(subject: string): boolean {
	return !NO_FILE_CHANGES.test(subject);
}

/**
 * A short label for a reflog subject:
 * "checkout: moving from main to feature" → "git checkout feature",
 * "reset: moving to HEAD~1" → "git reset HEAD~1", "pull: Fast-forward" → "git pull".
 */
export function gitOpLabel(subject: string): string {
	const checkout = /^checkout: moving from .+ to (.+)$/.exec(subject);
	if (checkout) return `git checkout ${checkout[1]}`;
	const reset = /^reset: moving to (.+)$/.exec(subject);
	if (reset) return `git reset ${reset[1]}`;
	const merge = /^merge (\S+):/.exec(subject);
	if (merge) return `git merge ${merge[1]}`;
	const op = /^([a-z-]+)/.exec(subject)?.[1];
	return op ? `git ${op}` : 'git';
}
