import { execFileSync } from 'child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	HOOK_LOG_NAME, hookLogEnd, hookSettings, installHookScript, parseHookLine, readHookLog,
} from '../src/services/rewind/claudeHook';
import { attribute } from '../src/services/rewind/attribution';
import type { FileRecord } from '../src/services/rewind/records';
import { claudeRecordFrom } from '../src/services/rewind/timeline';
import { remove, tempDir } from './helpers';

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) remove(cleanup.pop() ?? ''); });

function runHook(script: string, input: unknown, env: Record<string, string> = {}): string {
	return execFileSync(process.execPath, [script], { input: JSON.stringify(input), env: { ...process.env, ...env }, encoding: 'utf-8' });
}

describe('Claude Code hook script', () => {
	it('logs prompts and file-writing tool calls with the session’s turn', async () => {
		const dir = tempDir('heron-hook-');
		cleanup.push(dir);
		const script = await installHookScript(dir);
		const base = { session_id: 'abc', cwd: '/work/repo' };
		const out = [
			runHook(script, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'add retry to mail sender' }),
			runHook(script, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/mail.ts', old_string: 'a', new_string: 'b' } }),
			runHook(script, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} }),
			runHook(script, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'now the tests' }),
			runHook(script, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/work/repo/test.ts', content: 'x' } }),
			runHook(script, 'not an object'),
		];
		// Prints nothing: UserPromptSubmit output would be added to Claude's context.
		expect(out.join('')).toBe('');
		const lines = readFileSync(path.join(dir, HOOK_LOG_NAME), 'utf-8').trim().split('\n').map(parseHookLine);
		expect(lines.map((l) => l && [l.event, l.turn, l.prompt, l.tool, l.files])).toEqual([
			['prompt', 1, 'add retry to mail sender', null, []],
			['tool', 1, 'add retry to mail sender', 'Edit', ['/work/repo/src/mail.ts']],
			['prompt', 2, 'now the tests', null, []],
			['tool', 2, 'now the tests', 'Write', ['/work/repo/test.ts']],
		]);
		expect(lines.every((l) => l?.v === 1 && l.session === 'abc' && typeof l.time === 'number')).toBe(true);
	});

	it('writes to $HERON_HOOK_DIR when set', async () => {
		const dir = tempDir('heron-hook-');
		const other = tempDir('heron-hook-other-');
		cleanup.push(dir, other);
		const script = await installHookScript(dir);
		runHook(script, { session_id: 's', cwd: '/', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, { HERON_HOOK_DIR: other });
		expect(readFileSync(path.join(other, HOOK_LOG_NAME), 'utf-8')).toContain('"prompt":"hi"');
	});

	it('builds the settings to paste into Claude Code', () => {
		expect(hookSettings('/data/Heron/claude-hook.mjs')).toEqual({
			hooks: {
				UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "/data/Heron/claude-hook.mjs"' }] }],
				PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'node "/data/Heron/claude-hook.mjs"' }] }],
			},
		});
	});
});

describe('reading the hook log', () => {
	const line = (o: Record<string, unknown>) => JSON.stringify({ v: 1, event: 'tool', session: 's', turn: 1, prompt: 'p', tool: 'Edit', files: ['/v/Code/app/a.ts'], cwd: '/v', time: 5, ...o }) + '\n';

	it('reads new complete lines from an offset, and starts over after rotation', async () => {
		const dir = tempDir('heron-hook-');
		cleanup.push(dir);
		const file = path.join(dir, HOOK_LOG_NAME);
		expect(await readHookLog(file, 0)).toEqual({ lines: [], offset: 0 });
		writeFileSync(file, line({ time: 1 }) + line({ time: 2, v: 2 }) + 'garbage\n' + '{"v":1,"event":"to');
		const first = await readHookLog(file, 0);
		expect(first.lines.map((l) => l.time)).toEqual([1]);
		appendFileSync(file, 'ol"}\n' + line({ time: 3 }));
		const second = await readHookLog(file, first.offset);
		expect(second.lines.map((l) => l.time)).toEqual([3]);
		expect(second.offset).toBe(await hookLogEnd(file));
		writeFileSync(file, line({ time: 4 }));
		expect((await readHookLog(file, second.offset)).lines.map((l) => l.time)).toEqual([4]);
	});

	it('turns tool lines into records for files in the vault and matches them to changes', () => {
		const toVault = (abs: string) => (abs.startsWith('/v/Code/app/') ? abs.slice(3) : null);
		const tool = parseHookLine(line({ files: ['/v/Code/app/a.ts', '/elsewhere/b.ts'], time: 10_000 }));
		const record = tool && claudeRecordFrom(tool, toVault);
		expect(record).toMatchObject({ type: 'claude', session: 's', turn: 1, prompt: 'p', tool: 'Edit', files: ['Code/app/a.ts'], t: 10_000 });
		expect(claudeRecordFrom(parseHookLine(line({ files: ['/elsewhere/b.ts'] }))!, toVault)).toBeNull();
		expect(claudeRecordFrom(parseHookLine(line({ event: 'prompt' }))!, toVault)).toBeNull();

		const change: FileRecord = { v: 1, type: 'file', id: 'f', t: 9_800, repo: 'Code/app', path: 'Code/app/a.ts', kind: 'modify', before: null, after: null };
		expect(attribute([change], record ? [record] : [], [])[0]?.source).toBe('claude');
	});
});
