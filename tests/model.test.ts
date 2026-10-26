// @vitest-environment jsdom
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
	ANTHROPIC_URL, apiClient, apiRequest, cliArgs, cliClient, HttpRequest, ModelCancelled, ModelError,
	parseApiResponse, parseCliOutput, processRunner,
} from '../src/model/client';
import { clip, identifiersIn, importLines, keyIdentifiers, maskStringsAndComments, outlineText } from '../src/model/context';
import { parseExplanation, parseMermaid, parseRanking } from '../src/model/parse';
import { diagramPrompt, explainPrompt, PROMPT_BUDGET, similarPrompt } from '../src/model/prompts';

const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-claude.mjs');
const fakeCommand = (...args: string[]) => [process.execPath, FAKE_CLAUDE, ...args].map((a) => `"${a}"`).join(' ');
const localPath = () => Promise.resolve(process.env.PATH ?? '');
const REQUEST = { system: 'Be brief.', prompt: 'Explain x', maxTokens: 100 };

describe('Anthropic API transport', () => {
	it('builds a Messages API request', () => {
		const req = apiRequest('claude-haiku-5-5', 'sk-test', REQUEST);
		expect(req.url).toBe(ANTHROPIC_URL);
		expect(req.headers).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' });
		expect(JSON.parse(req.body)).toEqual({
			model: 'claude-haiku-5-5', max_tokens: 100, system: 'Be brief.',
			messages: [{ role: 'user', content: 'Explain x' }],
		});
	});

	it('reads the text of a response', () => {
		const text = JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'Hello ' }, { type: 'tool_use' }, { type: 'text', text: 'there' }] });
		expect(parseApiResponse({ status: 200, text })).toBe('Hello there');
	});

	it('reports API errors with their message', () => {
		const error = (status: number, message: string) => ({ status, text: JSON.stringify({ type: 'error', error: { type: 'x', message } }) });
		expect(() => parseApiResponse(error(401, 'invalid x-api-key'))).toThrow('The API key was rejected: invalid x-api-key');
		expect(() => parseApiResponse(error(529, 'Overloaded'))).toThrow('The API returned 529: Overloaded');
		expect(() => parseApiResponse({ status: 502, text: '<html>bad gateway</html>' })).toThrow('502: <html>bad gateway</html>');
		expect(() => parseApiResponse({ status: 200, text: '{"content":[]}' })).toThrow('no text');
	});

	it('asks for the key only when called, and fails clearly without one', async () => {
		const post = vi.fn((req: HttpRequest) => Promise.resolve({ status: 200, text: JSON.stringify({ content: [{ type: 'text', text: req.headers['x-api-key'] ?? '' }] }) }));
		let key: string | null = null;
		const client = apiClient({ model: 'm', apiKey: () => key, post });
		await expect(client.complete(REQUEST)).rejects.toThrow(/No Anthropic API key/);
		expect(post).not.toHaveBeenCalled();
		key = 'sk-later';
		await expect(client.complete(REQUEST)).resolves.toBe('sk-later');
	});

	it('stops waiting when cancelled, even though the request cannot be stopped', async () => {
		const client = apiClient({ model: 'm', apiKey: () => 'k', post: () => new Promise(() => { /* never answers */ }) });
		const controller = new AbortController();
		const pending = client.complete(REQUEST, controller.signal);
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(ModelCancelled);
	});

	it('wraps network failures', async () => {
		const client = apiClient({ model: 'm', apiKey: () => 'k', post: () => Promise.reject(new Error('ENOTFOUND')) });
		await expect(client.complete(REQUEST)).rejects.toThrow('Cannot reach the Anthropic API: ENOTFOUND');
	});
});

describe('Claude Code CLI transport', () => {
	it('runs claude -p with JSON output, the model and no tools or settings', () => {
		const args = cliArgs('claude-haiku-5-5', 'sys');
		expect(args.slice(0, 5)).toEqual(['-p', '--model', 'claude-haiku-5-5', '--output-format', 'json']);
		expect(args).toEqual(expect.arrayContaining(['--system-prompt', 'sys', '--tools', '', '--setting-sources', '--strict-mcp-config']));
	});

	it('reads the result, skipping warnings before the JSON', () => {
		expect(parseCliOutput({ code: 0, stderr: '', stdout: 'warn\n{"type":"result","subtype":"success","is_error":false,"result":"ok"}' })).toBe('ok');
	});

	it('reports failures with the CLI output', () => {
		expect(() => parseCliOutput({ code: 1, stdout: '', stderr: 'Invalid API key · Please run /login' })).toThrow('Claude Code failed (exit code 1): Invalid API key · Please run /login');
		expect(() => parseCliOutput({ code: 0, stderr: '', stdout: '{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}' })).toThrow('error_max_turns');
		expect(() => parseCliOutput({ code: 0, stderr: '', stdout: '{"type":"result","subtype":"success","is_error":true,"result":"Credit balance is too low"}' })).toThrow('Credit balance is too low');
	});

	it('passes the prompt on stdin and the system prompt as an argument', async () => {
		const run = vi.fn(() => Promise.resolve({ code: 0, stderr: '', stdout: '{"subtype":"success","result":"done"}' }));
		const client = cliClient({ model: 'claude-haiku-5-5', command: 'npx claude', run });
		await expect(client.complete(REQUEST)).resolves.toBe('done');
		expect(run).toHaveBeenCalledWith('npx', ['claude', ...cliArgs('claude-haiku-5-5', 'Be brief.')], 'Explain x', undefined);
	});

	it('talks to a real process', async () => {
		const client = cliClient({ model: 'claude-haiku-5-5', command: fakeCommand(), run: processRunner(localPath) });
		await expect(client.complete(REQUEST)).resolves.toBe('claude-haiku-5-5|Be brief.|tools=|Explain x');
	});

	it('reports a process that fails, and one that is missing', async () => {
		const failing = cliClient({ model: 'm', command: fakeCommand('--fail'), run: processRunner(localPath) });
		await expect(failing.complete(REQUEST)).rejects.toThrow('Claude Code failed (exit code 1): fake-claude: not logged in');
		const missing = cliClient({ model: 'm', command: 'heron-no-such-claude', run: processRunner(localPath) });
		await expect(missing.complete(REQUEST)).rejects.toThrow('heron-no-such-claude was not found');
	});

	it('kills the process when cancelled or too slow', async () => {
		const controller = new AbortController();
		const hanging = cliClient({ model: 'm', command: fakeCommand('--hang'), run: processRunner(localPath) });
		const pending = hanging.complete(REQUEST, controller.signal);
		setTimeout(() => controller.abort(), 100);
		await expect(pending).rejects.toBeInstanceOf(ModelCancelled);
		const slow = cliClient({ model: 'm', command: fakeCommand('--hang'), run: processRunner(localPath, 200) });
		await expect(slow.complete(REQUEST)).rejects.toThrow('did not answer within');
	});
});

describe('context helpers', () => {
	it('finds identifiers outside strings and comments, without keywords', () => {
		const code = 'const user = loadUser(id); // loadAll here\nreturn "fetchName" + user.name;';
		expect(identifiersIn(code).map((i) => i.name)).toEqual(['user', 'loadUser', 'id', 'name']);
		expect(identifiersIn(code)[0]).toMatchObject({ index: 6, count: 2 });
		expect(maskStringsAndComments('a "b" c').length).toBe(7);
	});

	it('picks frequent, long identifiers as keys', () => {
		expect(keyIdentifiers('retry(fetchPage); retry(fetchPage); x = ab', 2).map((i) => i.name)).toEqual(['fetchPage', 'retry']);
	});

	it('lists import lines and outlines', () => {
		expect(importLines('import a from "a";\nconst b = require("b");\nfrom x import y\nfoo();', 10)).toHaveLength(3);
		const node = { name: 'Server', kind: 'class', detail: '', position: { line: 0, character: 6 }, start: { line: 0, character: 0 }, end: { line: 9, character: 1 } };
		expect(outlineText([{ ...node, children: [{ ...node, name: 'start', kind: 'method', detail: '(port)', children: [] }] }], 10))
			.toBe('class Server (line 1)\n  method start (port) (line 1)');
		expect(clip('abcdef', 4)).toBe('abc…');
	});
});

describe('prompts', () => {
	const ctx = {
		file: 'heron/src/server.ts', language: 'ts', selection: 'start(port);', lines: { from: 4, to: 4 },
		enclosing: ['class Server', 'method boot'],
		symbols: [{ name: 'start', hover: 'function start(port: number): void', definition: 'heron/src/start.ts:3', definitionCode: 'export function start(port: number) {}' }],
		calleeName: 'boot', callers: [{ location: 'heron/src/main.ts:10', code: '  server.boot();' }],
	};

	it('explains with the selection, enclosing symbols, symbol facts and callers', () => {
		const { system, prompt, maxTokens } = explainPrompt(ctx);
		expect(system).toMatch(/reviewing code that an AI agent wrote/);
		expect(prompt).toContain('File: heron/src/server.ts (lines 4–4)');
		expect(prompt).toContain('Inside: class Server › method boot');
		expect(prompt).toContain('```ts\nstart(port);\n```');
		expect(prompt).toContain('- `start`, defined at heron/src/start.ts:3');
		expect(prompt).toContain('Hover: function start(port: number): void');
		expect(prompt).toContain('Callers of `boot`:\n- heron/src/main.ts:10: `server.boot();`');
		expect(maxTokens).toBeGreaterThan(0);
	});

	it('caps the context it sends', () => {
		const many = Array.from({ length: 500 }, (_, i) => ({ ...ctx.symbols[0]!, name: `sym${i}`, hover: 'h'.repeat(800) }));
		const { prompt } = explainPrompt({ ...ctx, symbols: many, selection: 'x'.repeat(50_000) });
		expect(prompt.length).toBeLessThan(PROMPT_BUDGET + 10_000);
	});

	it('fences code that contains backticks', () => {
		const { prompt } = explainPrompt({ ...ctx, selection: 'const s = ```;' });
		expect(prompt).toContain('````ts\nconst s = ```;\n````');
	});

	it('numbers candidates for ranking', () => {
		const { prompt, system } = similarPrompt({ file: 'a.ts', language: 'ts', code: 'retry(fetch)' }, [
			{ id: 1, location: 'b.ts:3', code: 'retry(load)' },
			{ id: 2, location: 'c.ts:9', code: 'other()' },
		]);
		expect(system).toMatch(/JSON only/);
		expect(prompt).toContain('[1] b.ts:3\n```ts\nretry(load)\n```');
		expect(prompt).toContain('[2] c.ts:9');
	});

	it('describes structure for a diagram', () => {
		const { prompt, system } = diagramPrompt({
			subject: 'heron/src/server.ts', language: 'ts', outline: 'class Server (line 1)', imports: ['import x from "x";'],
			calls: [{ from: 'start', to: 'listen (heron/src/net.ts)' }], usedBy: [{ symbol: 'Server', places: ['heron/src/main.ts'] }], code: '',
		});
		expect(system).toMatch(/Mermaid/);
		expect(prompt).toContain('Draw a diagram of heron/src/server.ts.');
		expect(prompt).toContain('- start → listen (heron/src/net.ts)');
		expect(prompt).toContain('- Server: heron/src/main.ts');
		expect(prompt).not.toContain('Code:');
	});
});

describe('parsing replies', () => {
	it('reads explanations, unwrapping a markdown fence', () => {
		expect(parseExplanation('  Loads the user.\n\n- a\n')).toBe('Loads the user.\n\n- a');
		expect(parseExplanation('```markdown\nLoads it.\n```')).toBe('Loads it.');
		expect(parseExplanation('```ts\nx\n```')).toBe('```ts\nx\n```');
		expect(() => parseExplanation('  ')).toThrow(ModelError);
	});

	it('reads rankings in prose, fences and loose shapes', () => {
		const ids = new Set([1, 2, 3]);
		expect(parseRanking('[{"id":2,"reason":"Same retry loop."},{"id":9,"reason":"x"},{"id":2,"reason":"dup"}]', ids))
			.toEqual([{ id: 2, reason: 'Same retry loop.' }]);
		expect(parseRanking('Here you go:\n```json\n[{"id":"3","reason":" r "}, 1]\n```\nDone.', ids))
			.toEqual([{ id: 3, reason: 'r' }, { id: 1, reason: '' }]);
		expect(parseRanking('None of them. []', ids)).toEqual([]);
		expect(() => parseRanking('I could not decide.', ids)).toThrow(ModelError);
	});

	it('reads Mermaid diagrams', () => {
		expect(parseMermaid('Here:\n```mermaid\nflowchart LR\n  a --> b\n```\n')).toBe('flowchart LR\n  a --> b');
		expect(parseMermaid('```\n%% comment\nclassDiagram\n  A <|-- B\n```')).toBe('%% comment\nclassDiagram\n  A <|-- B');
		expect(parseMermaid('graph TD\n a-->b')).toBe('graph TD\n a-->b');
		expect(() => parseMermaid('```python\nprint(1)\n```')).toThrow('did not return a Mermaid diagram');
	});
});
