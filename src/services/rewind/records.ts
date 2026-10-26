/**
 * Records in Rewind's append-only log (`log.jsonl`), one JSON object per
 * line. Pure: no Obsidian or file-system imports.
 *
 * Format version 1. Readers skip lines they do not understand, so new
 * record types can be added without breaking older versions.
 */

export const LOG_VERSION = 1;

/** Who made a change. */
export type Source = 'heron' | 'git' | 'claude' | 'external';

/**
 * `baseline` records a file's content the first time Heron sees it, so the
 * first real change has something to diff against. Baselines are not shown.
 */
export type FileChangeKind = 'baseline' | 'create' | 'modify' | 'delete' | 'rename';

/** A file's content changed. Content is referenced by blob hash; null means the file did not exist. */
export interface FileRecord {
	v: 1;
	type: 'file';
	id: string;
	/** Milliseconds since the epoch. */
	t: number;
	/** Vault path of the repository's folder. */
	repo: string;
	/** Vault path of the file. */
	path: string;
	/** Previous vault path, for renames. */
	oldPath?: string;
	kind: FileChangeKind;
	before: string | null;
	after: string | null;
	/** Set when the source was known at capture time: saves and restores in Heron. */
	source?: 'heron';
	/** A label for Heron's own writes, e.g. "Restored a.ts to 14:03". */
	label?: string;
	/** Changes with the same group form one moment, e.g. the files of one restore. */
	group?: string;
}

/** HEAD moved in a repository (checkout, pull, reset…), from the reflog. */
export interface GitRecord {
	v: 1;
	type: 'git';
	id: string;
	t: number;
	repo: string;
	/** Reflog subject, e.g. "checkout: moving from main to feature". */
	subject: string;
	head: string | null;
	oid: string | null;
}

/** A Claude Code tool call that wrote files, from the hook log. */
export interface ClaudeRecord {
	v: 1;
	type: 'claude';
	id: string;
	t: number;
	session: string;
	/** Prompt number within the session, or null when unknown. */
	turn: number | null;
	prompt: string | null;
	tool: string;
	/** Vault paths of the files the tool wrote. */
	files: string[];
}

export type LogRecord = FileRecord | GitRecord | ClaudeRecord;

const FILE_KINDS = new Set<FileChangeKind>(['baseline', 'create', 'modify', 'delete', 'rename']);

const str = (v: unknown): v is string => typeof v === 'string';
const hashOrNull = (v: unknown): v is string | null => v === null || (str(v) && /^[0-9a-f]{64}$/.test(v));

/** Parses one log line, or returns null for blank, malformed or unknown lines. */
export function parseRecord(line: string): LogRecord | null {
	if (!line.trim()) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	if (r.v !== LOG_VERSION || !str(r.id) || typeof r.t !== 'number' || !Number.isFinite(r.t)) return null;
	switch (r.type) {
		case 'file': {
			if (!str(r.repo) || !str(r.path) || !FILE_KINDS.has(r.kind as FileChangeKind)) return null;
			if (!hashOrNull(r.before) || !hashOrNull(r.after)) return null;
			const rec: FileRecord = {
				v: 1, type: 'file', id: r.id, t: r.t, repo: r.repo, path: r.path,
				kind: r.kind as FileChangeKind, before: r.before, after: r.after,
			};
			if (str(r.oldPath)) rec.oldPath = r.oldPath;
			if (r.source === 'heron') rec.source = 'heron';
			if (str(r.label)) rec.label = r.label;
			if (str(r.group)) rec.group = r.group;
			return rec;
		}
		case 'git':
			if (!str(r.repo) || !str(r.subject)) return null;
			return {
				v: 1, type: 'git', id: r.id, t: r.t, repo: r.repo, subject: r.subject,
				head: str(r.head) ? r.head : null, oid: str(r.oid) ? r.oid : null,
			};
		case 'claude':
			if (!str(r.session) || !str(r.tool) || !Array.isArray(r.files)) return null;
			return {
				v: 1, type: 'claude', id: r.id, t: r.t, session: r.session,
				turn: typeof r.turn === 'number' ? r.turn : null,
				prompt: str(r.prompt) ? r.prompt : null,
				tool: r.tool,
				files: r.files.filter(str),
			};
		default:
			return null;
	}
}

let counter = 0;

/** A record id that is unique within a log: time plus a counter plus randomness. */
export function newId(now = Date.now()): string {
	counter = (counter + 1) % 0x10000;
	return `${now.toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
