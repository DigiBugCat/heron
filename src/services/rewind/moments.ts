/**
 * Groups attributed file changes into moments: one Claude turn, one git
 * operation, one restore, or a burst of saves or outside edits. Pure.
 */
import * as path from 'path';
import { AttributedChange, gitOpLabel } from './attribution';
import type { ClaudeRecord, GitRecord, Source } from './records';

/** Saves and outside edits closer together than this form one moment. */
export const QUIET_GAP_MS = 30_000;
/** Prompts are shortened to this many characters in labels. */
const PROMPT_LABEL_CHARS = 60;

/** One file's net change within a moment. */
export interface MomentFile {
	path: string;
	/** Path before the moment, when it was renamed. */
	oldPath?: string;
	kind: 'create' | 'modify' | 'delete' | 'rename';
	/** Content hash before the moment; null when the file did not exist. */
	before: string | null;
	/** Content hash after the moment; null when it was deleted. */
	after: string | null;
}

export interface Moment {
	id: string;
	source: Source;
	/** Time of the first and last change, in ms. */
	start: number;
	end: number;
	/** Vault paths of the repositories involved. */
	repos: string[];
	changes: AttributedChange[];
	files: MomentFile[];
	label: string;
	claude?: ClaudeRecord;
	git?: GitRecord;
}

/** Moments that only form from changes in a row; the others collect by key. */
function groupKey(c: AttributedChange): { key: string; byGap: boolean } {
	if (c.source === 'claude' && c.claude) return { key: `claude:${c.claude.session}:${c.claude.turn ?? c.claude.id}`, byGap: false };
	if (c.source === 'git' && c.git) return { key: `git:${c.git.id}`, byGap: false };
	if (c.group) return { key: `group:${c.group}`, byGap: false };
	return { key: `${c.source}:${c.repo}`, byGap: true };
}

/**
 * Groups changes into moments, newest first:
 * - a Claude turn (session and prompt), a git operation or a restore is one
 *   moment however its changes interleave with others;
 * - other saves and outside edits in one repository form a moment until
 *   nothing changes for `gap` ms.
 * Files whose content ends where it started are left out, and so are
 * moments with no files left.
 */
export function groupMoments(changes: readonly AttributedChange[], gap = QUIET_GAP_MS): Moment[] {
	const sorted = [...changes].sort((a, b) => a.t - b.t);
	const byKey = new Map<string, AttributedChange[][]>();
	const groups: AttributedChange[][] = [];
	for (const c of sorted) {
		const { key, byGap } = groupKey(c);
		const existing = byKey.get(key);
		const current = existing?.[existing.length - 1];
		const last = current?.[current.length - 1];
		if (current && last && (!byGap || c.t - last.t <= gap)) {
			current.push(c);
			continue;
		}
		const group = [c];
		groups.push(group);
		if (existing) existing.push(group);
		else byKey.set(key, [group]);
	}

	const moments: Moment[] = [];
	for (const group of groups) {
		const first = group[0];
		const last = group[group.length - 1];
		if (!first || !last) continue;
		const files = netFiles(group);
		if (!files.length) continue;
		const moment: Moment = {
			id: `${groupKey(first).key}:${first.id}`,
			source: first.source,
			start: first.t,
			end: last.t,
			repos: [...new Set(group.map((c) => c.repo))],
			changes: group,
			files,
			label: '',
		};
		if (first.claude) moment.claude = first.claude;
		if (first.git) moment.git = first.git;
		moment.label = momentLabel(moment);
		moments.push(moment);
	}
	return moments.sort((a, b) => b.end - a.end || b.start - a.start);
}

/** Each file's net change across `changes`, following renames, in order of first change. */
export function netFiles(changes: readonly AttributedChange[]): MomentFile[] {
	const files = new Map<string, MomentFile>();
	for (const c of changes) {
		if (c.oldPath && c.oldPath !== c.path) {
			const prior = files.get(c.oldPath);
			files.delete(c.oldPath);
			files.set(c.path, {
				path: c.path,
				oldPath: prior ? prior.oldPath ?? prior.path : c.oldPath,
				kind: 'rename',
				before: prior ? prior.before : c.before,
				after: c.after,
			});
			continue;
		}
		const prior = files.get(c.path);
		if (prior) prior.after = c.after;
		else files.set(c.path, { path: c.path, kind: 'modify', before: c.before, after: c.after });
	}
	const result: MomentFile[] = [];
	for (const f of files.values()) {
		const renamed = !!f.oldPath && f.oldPath !== f.path;
		if (!renamed) delete f.oldPath;
		if (!renamed && f.before === f.after) continue;
		f.kind = f.before === null ? 'create' : f.after === null ? 'delete' : renamed ? 'rename' : 'modify';
		result.push(f);
	}
	return result;
}

const base = (p: string) => path.posix.basename(p);

/** "ContentPane.ts" for one file, "4 files" for more. */
function filesWord(files: readonly MomentFile[]): string {
	const only = files.length === 1 ? files[0] : undefined;
	return only ? base(only.path) : `${files.length} files`;
}

function shorten(text: string, max: number): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * "Claude: add retry to mail sender · 4 files", "You saved ContentPane.ts",
 * "git checkout main · 12 files", "Deleted old.ts".
 */
export function momentLabel(m: Pick<Moment, 'source' | 'files' | 'changes' | 'claude' | 'git'>): string {
	const files = filesWord(m.files);
	switch (m.source) {
		case 'claude': {
			const prompt = m.claude?.prompt ? shorten(m.claude.prompt, PROMPT_LABEL_CHARS) : '';
			return prompt ? `Claude: ${prompt} · ${files}` : `Claude edited ${files}`;
		}
		case 'git':
			return `${m.git ? gitOpLabel(m.git.subject) : 'git'} · ${files}`;
		case 'heron':
			return m.changes.find((c) => c.label)?.label ?? `You saved ${files}`;
		default: {
			const only = m.files.length === 1 ? m.files[0] : undefined;
			if (!only) return `Changed ${files}`;
			switch (only.kind) {
				case 'create': return `Created ${base(only.path)}`;
				case 'delete': return `Deleted ${base(only.path)}`;
				case 'rename': return `Renamed ${base(only.oldPath ?? '')} → ${base(only.path)}`;
				default: return `Changed ${base(only.path)}`;
			}
		}
	}
}

/** The moment's change to `vaultPath` (by its path before or after the moment), if any. */
export function fileInMoment(m: Moment, vaultPath: string): MomentFile | undefined {
	return m.files.find((f) => f.path === vaultPath || f.oldPath === vaultPath);
}

/** Moments that changed `vaultPath`, keeping the order given. */
export function momentsForFile(moments: readonly Moment[], vaultPath: string): Moment[] {
	return moments.filter((m) => !!fileInMoment(m, vaultPath));
}

/** Moments that changed files in the repository at `repo`. */
export function momentsForRepo(moments: readonly Moment[], repo: string): Moment[] {
	return moments.filter((m) => m.repos.includes(repo));
}
