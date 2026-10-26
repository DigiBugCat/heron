import { promises as fsp } from 'fs';
import * as path from 'path';

/**
 * Claude Code hooks for Rewind. The hook script appends one JSON line per
 * prompt and per file-writing tool call to `claude-events.jsonl`; Heron
 * reads new lines and matches them to file changes. The format is
 * documented in docs/claude-hooks.md; bump `HOOK_FORMAT_VERSION` (and keep
 * reading older versions) when it changes.
 */

export const HOOK_FORMAT_VERSION = 1;
export const HOOK_SCRIPT_NAME = 'claude-hook.mjs';
export const HOOK_LOG_NAME = 'claude-events.jsonl';
/** Tools whose calls write files. */
export const HOOK_TOOLS = ['Edit', 'Write', 'MultiEdit'];
/** At most this much of the hook log is read at once, in bytes. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

/** One line of the hook log. */
export interface HookLine {
	v: number;
	event: 'prompt' | 'tool';
	session: string;
	turn: number | null;
	prompt: string | null;
	/** Tool name, for `tool` lines. */
	tool: string | null;
	/** Absolute paths the tool wrote, for `tool` lines. */
	files: string[];
	cwd: string | null;
	/** Milliseconds since the epoch. */
	time: number;
}

/** Parses one hook log line; null for malformed lines and unknown versions. */
export function parseHookLine(line: string): HookLine | null {
	if (!line.trim()) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	if (r.v !== HOOK_FORMAT_VERSION) return null;
	if (r.event !== 'prompt' && r.event !== 'tool') return null;
	if (typeof r.session !== 'string' || typeof r.time !== 'number') return null;
	return {
		v: r.v,
		event: r.event,
		session: r.session,
		turn: typeof r.turn === 'number' ? r.turn : null,
		prompt: typeof r.prompt === 'string' ? r.prompt : null,
		tool: typeof r.tool === 'string' ? r.tool : null,
		files: Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === 'string') : [],
		cwd: typeof r.cwd === 'string' ? r.cwd : null,
		time: r.time,
	};
}

/**
 * Reads complete lines added to the hook log since byte `offset`. Starts
 * over when the file shrank (the hook rotates it). A partial last line is
 * left for next time.
 */
export async function readHookLog(file: string, offset: number): Promise<{ lines: HookLine[]; offset: number }> {
	let size: number;
	try {
		size = (await fsp.stat(file)).size;
	} catch {
		return { lines: [], offset: 0 };
	}
	if (size < offset) offset = 0;
	if (size === offset) return { lines: [], offset };
	const length = Math.min(size - offset, MAX_READ_BYTES);
	const buf = Buffer.alloc(length);
	const handle = await fsp.open(file, 'r');
	try {
		await handle.read(buf, 0, length, offset);
	} finally {
		await handle.close();
	}
	const end = buf.lastIndexOf(10);
	if (end < 0) return { lines: [], offset: length === MAX_READ_BYTES ? offset + length : offset };
	const lines = buf.toString('utf-8', 0, end).split('\n').map(parseHookLine).filter((l): l is HookLine => !!l);
	return { lines, offset: offset + end + 1 };
}

/** The size of the hook log now, to start reading from its end. */
export async function hookLogEnd(file: string): Promise<number> {
	try {
		return (await fsp.stat(file)).size;
	} catch {
		return 0;
	}
}

/** The command Claude Code runs for the hook. */
export function hookCommand(scriptPath: string): string {
	return `node "${scriptPath}"`;
}

/** The `hooks` block for Claude Code's settings.json. */
export function hookSettings(scriptPath: string): Record<string, unknown> {
	const hook = { type: 'command', command: hookCommand(scriptPath) };
	return {
		hooks: {
			UserPromptSubmit: [{ hooks: [hook] }],
			PostToolUse: [{ matcher: HOOK_TOOLS.join('|'), hooks: [hook] }],
		},
	};
}

/** Writes the hook script into `dir`; returns its path. */
export async function installHookScript(dir: string): Promise<string> {
	await fsp.mkdir(dir, { recursive: true });
	const file = path.join(dir, HOOK_SCRIPT_NAME);
	await fsp.writeFile(file, HOOK_SCRIPT, 'utf-8');
	return file;
}

/**
 * The hook script (Node.js, no dependencies). It writes next to itself, or
 * to `$HERON_HOOK_DIR`, prints nothing and always exits 0, so it can never
 * block or change what Claude does.
 */
export const HOOK_SCRIPT = `#!/usr/bin/env node
// Heron Rewind hook for Claude Code, log format v${HOOK_FORMAT_VERSION}.
// UserPromptSubmit: appends {"event":"prompt"} and remembers the session's turn.
// PostToolUse (${HOOK_TOOLS.join(', ')}): appends {"event":"tool"} with the files written.
// Lines go to ${HOOK_LOG_NAME} next to this script, or in $HERON_HOOK_DIR.
// It prints nothing and always exits 0, so it never blocks Claude.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = ${HOOK_FORMAT_VERSION};
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_PROMPT_CHARS = 2000;
const SESSION_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const dir = process.env.HERON_HOOK_DIR || path.dirname(fileURLToPath(import.meta.url));
const logFile = path.join(dir, '${HOOK_LOG_NAME}');
const sessionsDir = path.join(dir, 'claude-sessions');

function sessionFile(id) {
	return path.join(sessionsDir, String(id).replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
}

function readSession(id) {
	try { return JSON.parse(fs.readFileSync(sessionFile(id), 'utf-8')); } catch { return {}; }
}

function writeSession(id, state) {
	fs.mkdirSync(sessionsDir, { recursive: true });
	fs.writeFileSync(sessionFile(id), JSON.stringify(state));
}

function pruneSessions(now) {
	for (const name of fs.readdirSync(sessionsDir)) {
		const file = path.join(sessionsDir, name);
		try { if (now - fs.statSync(file).mtimeMs > SESSION_MAX_AGE_MS) fs.unlinkSync(file); } catch { /* ignore */ }
	}
}

function append(line) {
	fs.mkdirSync(dir, { recursive: true });
	try { if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, logFile + '.1'); } catch { /* no log yet */ }
	fs.appendFileSync(logFile, JSON.stringify(line) + '\\n');
}

function filesOf(input, cwd) {
	const files = [];
	for (const key of ['file_path', 'notebook_path']) {
		const value = input && input[key];
		if (typeof value === 'string' && value) files.push(path.resolve(cwd, value));
	}
	return files;
}

try {
	let raw = '';
	try { raw = fs.readFileSync(0, 'utf-8'); } catch { /* no input */ }
	const input = JSON.parse(raw || '{}');
	const now = Date.now();
	const session = String(input.session_id || 'unknown');
	const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
	if (input.hook_event_name === 'UserPromptSubmit') {
		const turn = (Number(readSession(session).turn) || 0) + 1;
		const prompt = typeof input.prompt === 'string' ? input.prompt.slice(0, MAX_PROMPT_CHARS) : '';
		writeSession(session, { turn, prompt, time: now });
		append({ v: VERSION, event: 'prompt', session, turn, prompt, cwd, time: now });
		if (turn === 1) pruneSessions(now);
	} else if (input.hook_event_name === 'PostToolUse') {
		const files = filesOf(input.tool_input, cwd);
		if (files.length) {
			const state = readSession(session);
			append({
				v: VERSION, event: 'tool', session,
				turn: Number(state.turn) || null,
				prompt: typeof state.prompt === 'string' ? state.prompt : null,
				tool: String(input.tool_name || ''), files, cwd, time: now,
			});
		}
	}
} catch { /* never get in Claude's way */ }
`;
