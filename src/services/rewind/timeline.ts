import { attribute } from './attribution';
import { groupMoments, Moment } from './moments';
import type { ClaudeRecord, FileRecord, GitRecord, LogRecord } from './records';
import type { HookLine } from './claudeHook';
import { newId } from './records';

/** Attributes and groups every change in the log into moments, newest first. Pure. */
export function buildMoments(records: readonly LogRecord[]): Moment[] {
	const files: FileRecord[] = [];
	const claude: ClaudeRecord[] = [];
	const git: GitRecord[] = [];
	for (const r of records) {
		if (r.type === 'file') files.push(r);
		else if (r.type === 'claude') claude.push(r);
		else git.push(r);
	}
	return groupMoments(attribute(files, claude, git));
}

/**
 * Turns a hook log `tool` line into a record, keeping only the files inside
 * the vault (as vault paths, via `toVaultPath`). Null when none are.
 */
export function claudeRecordFrom(line: HookLine, toVaultPath: (absPath: string) => string | null): ClaudeRecord | null {
	if (line.event !== 'tool') return null;
	const files = line.files.map(toVaultPath).filter((p): p is string => !!p);
	if (!files.length) return null;
	return {
		v: 1, type: 'claude', id: newId(line.time), t: line.time,
		session: line.session, turn: line.turn, prompt: line.prompt, tool: line.tool ?? '', files,
	};
}
