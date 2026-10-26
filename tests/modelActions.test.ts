// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'url';
import type { OutlineNode } from '../src/lsp/locations';
import type { ServerAccess } from '../src/lsp/requests';
import { ModelCancelled, ModelClient, ModelRequest } from '../src/model/client';
import { ActionSource, diagram, explainSelection, findSimilar } from '../src/services/modelActions';

const ROOT = '/repo';
const MAIN = `${ROOT}/src/server.ts`;
const NET = `${ROOT}/src/net.ts`;
const APP = `${ROOT}/src/app.ts`;
const uri = (p: string) => pathToFileURL(p).href;
const range = (line: number, character = 0) => ({ start: { line, character }, end: { line, character: character + 3 } });

const TEXT = [
	'import { listen } from "./net";',            // 0
	'export class Server {',                      // 1
	'\tstart(port: number) {',                     // 2
	'\t\tconst socket = listen(port);',            // 3
	'\t\tretryWith(socket, 3);',                   // 4
	'\t}',                                         // 5
	'}',                                           // 6
	'',
].join('\n');

const FILES: Record<string, string> = {
	[NET]: 'export function listen(port: number) {\n\treturn open(port);\n}\n',
	[APP]: 'const s = new Server();\ns.start(80);\n\nfunction other() {\n\tconst c = listen(81);\n\tretryWith(c, 5);\n}\n',
};

function node(name: string, kind: string, start: number, end: number, children: OutlineNode[] = []): OutlineNode {
	return { name, kind, detail: '', position: { line: start, character: 1 }, start: { line: start, character: 0 }, end: { line: end, character: 1 }, children };
}

const OUTLINE = [node('Server', 'class', 1, 6, [node('start', 'method', 2, 5)])];

/** A fake language server answering from fixed tables. */
function fakeServer(overrides: Record<string, (params: Record<string, unknown>) => unknown> = {}, missing: string[] = []): ServerAccess & { calls: string[] } {
	const calls: string[] = [];
	const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
		'textDocument/hover': (p) => {
			const pos = p.position as { line: number };
			return pos.line === 3 ? { contents: { kind: 'markdown', value: 'function listen(port: number): Socket' } } : null;
		},
		'textDocument/definition': (p) => {
			const pos = p.position as { line: number; character: number };
			return pos.line === 3 && pos.character > 16 ? [{ uri: uri(NET), range: range(0, 16) }] : null;
		},
		'textDocument/references': (p) => {
			const pos = p.position as { line: number };
			// References to `start` (the enclosing method): one caller in app.ts.
			if (pos.line === 2) return [{ uri: uri(APP), range: range(1, 2) }, { uri: uri(MAIN), range: range(2, 1) }];
			// References to the key identifiers.
			return [{ uri: uri(APP), range: range(4, 11) }, { uri: uri(MAIN), range: range(3, 17) }];
		},
		'workspace/symbol': () => [{ name: 'other', kind: 12, location: { uri: uri(APP), range: range(3, 9) } }],
		'textDocument/prepareCallHierarchy': (p) => {
			const pos = p.position as { line: number };
			return pos.line === 2 ? [{ name: 'start', kind: 6, uri: uri(MAIN), range: range(2), selectionRange: range(2, 1) }] : [];
		},
		'callHierarchy/outgoingCalls': () => [{ to: { name: 'listen', kind: 12, uri: uri(NET), range: range(0), selectionRange: range(0, 16) } }],
		'callHierarchy/incomingCalls': () => [{ from: { name: '<module>', kind: 2, uri: uri(APP), range: range(1) } }],
		...overrides,
	};
	return {
		uri: uri(MAIN),
		calls,
		supports: (capability) => !missing.includes(capability),
		request: (method, params) => {
			calls.push(method);
			const handler = handlers[method];
			return Promise.resolve(handler ? handler(params as Record<string, unknown>) : null);
		},
	};
}

function source(server: ServerAccess | null, overrides: Partial<ActionSource> = {}): ActionSource {
	return {
		absPath: MAIN,
		text: TEXT,
		language: 'ts',
		label: (p) => p.replace(`${ROOT}/`, 'repo/'),
		outline: () => Promise.resolve(server ? OUTLINE : null),
		server: () => Promise.resolve(server),
		readLines: (p) => Promise.resolve(FILES[p]?.split('\n') ?? null),
		grep: (word) => Promise.resolve(Object.entries(FILES).flatMap(([absPath, text]) => text.split('\n')
			.map((line, i) => ({ absPath, line: i, text: line }))
			.filter((hit) => new RegExp(`\\b${word}\\b`).test(hit.text)))),
		...overrides,
	};
}

/** A fake model that records requests and answers with `reply`. */
function fakeModel(reply: string | ((req: ModelRequest) => string)): ModelClient & { requests: ModelRequest[] } {
	const requests: ModelRequest[] = [];
	return {
		requests,
		complete: (req) => {
			requests.push(req);
			return Promise.resolve(typeof reply === 'string' ? reply : reply(req));
		},
	};
}

const selectionOf = (text: string) => ({ from: TEXT.indexOf(text), to: TEXT.indexOf(text) + text.length });

describe('explain selection', () => {
	it('grounds the prompt in the outline, hover, definitions and callers', async () => {
		const model = fakeModel('```markdown\nOpens a socket and retries.\n```');
		const progress = vi.fn();
		const body = await explainSelection(source(fakeServer()), selectionOf('const socket = listen(port);\n\t\tretryWith(socket, 3);'), { model, progress });
		expect(body).toBe('Opens a socket and retries.');
		const prompt = model.requests[0]?.prompt ?? '';
		expect(prompt).toContain('File: repo/src/server.ts (lines 4–5)');
		expect(prompt).toContain('Inside: class Server › method start');
		expect(prompt).toContain('`listen`, defined at repo/src/net.ts:1');
		expect(prompt).toContain('Hover: function listen(port: number): Socket');
		expect(prompt).toContain('export function listen(port: number) {');
		// The enclosing method's callers, without the declaration itself.
		expect(prompt).toContain('Callers of `start`:\n- repo/src/app.ts:2: `s.start(80);`');
		expect(progress).toHaveBeenCalledWith('Waiting for the model…');
	});

	it('still explains without a language server', async () => {
		const model = fakeModel('It retries.');
		await expect(explainSelection(source(null), selectionOf('retryWith(socket, 3);'), { model })).resolves.toBe('It retries.');
		expect(model.requests[0]?.prompt).not.toContain('Symbols used');
	});

	it('skips requests the server cannot answer, and ones that fail', async () => {
		const server = fakeServer({ 'textDocument/definition': () => { throw new Error('boom'); } }, ['hoverProvider']);
		const model = fakeModel('ok');
		await explainSelection(source(server), selectionOf('listen(port)'), { model });
		expect(server.calls).not.toContain('textDocument/hover');
		expect(model.requests).toHaveLength(1);
	});

	it('stops when cancelled, without asking the model', async () => {
		const controller = new AbortController();
		controller.abort();
		const model = fakeModel('never');
		await expect(explainSelection(source(fakeServer()), selectionOf('listen(port)'), { model, signal: controller.signal })).rejects.toBeInstanceOf(ModelCancelled);
		expect(model.requests).toHaveLength(0);
	});
});

describe('find similar', () => {
	it('gathers candidates from references, symbols and grep, and keeps what the model ranks', async () => {
		const model = fakeModel((req) => {
			const id = /\[(\d+)\] repo\/src\/app\.ts:5/.exec(req.prompt)?.[1];
			return JSON.stringify([{ id: Number(id), reason: 'Same listen-then-retry pattern.' }, { id: 999, reason: 'unknown' }]);
		});
		const results = await findSimilar(source(fakeServer()), selectionOf('const socket = listen(port);\n\t\tretryWith(socket, 3);'), { model });
		expect(results).toEqual([{ absPath: APP, position: { line: 4, character: 0 }, title: 'repo/src/app.ts:5', reason: 'Same listen-then-retry pattern.' }]);
		const prompt = model.requests[0]?.prompt ?? '';
		// The selection itself is not a candidate.
		expect(prompt).not.toMatch(/\] repo\/src\/server\.ts:4/);
		// Hits a few lines apart are merged into one candidate.
		expect(prompt.match(/\] repo\/src\/app\.ts:/g)?.length).toBe(1);
	});

	it('works from grep alone without a language server', async () => {
		const model = fakeModel('[]');
		await expect(findSimilar(source(null), selectionOf('retryWith(socket, 3);'), { model })).resolves.toEqual([]);
		expect(model.requests[0]?.prompt).toContain('repo/src/app.ts:6');
	});

	it('does not ask the model when there is nothing to compare', async () => {
		const model = fakeModel('[]');
		const lonely = source(null, { grep: () => Promise.resolve([]) });
		await expect(findSimilar(lonely, selectionOf('retryWith(socket, 3);'), { model })).resolves.toEqual([]);
		expect(model.requests).toHaveLength(0);
	});
});

describe('diagram', () => {
	it('draws a file from its outline, imports and call hierarchy', async () => {
		const model = fakeModel('```mermaid\nflowchart LR\n  start --> listen\n```');
		const result = await diagram(source(fakeServer()), null, { model });
		expect(result).toMatchObject({ mermaid: 'flowchart LR\n  start --> listen', subject: 'repo/src/server.ts', symbol: '' });
		expect(result.files[0]).toBe(MAIN);
		expect([...result.files].sort()).toEqual([APP, NET, MAIN]);
		const prompt = model.requests[0]?.prompt ?? '';
		expect(prompt).toContain('class Server (line 2)');
		expect(prompt).toContain('- import { listen } from "./net";');
		expect(prompt).toContain('- start → listen (repo/src/net.ts)');
		expect(prompt).toContain('- <module> (repo/src/app.ts) → start');
	});

	it('draws the symbol around a selection, with its code', async () => {
		const model = fakeModel('graph TD\n a-->b');
		const result = await diagram(source(fakeServer()), selectionOf('retryWith'), { model });
		expect(result.symbol).toBe('start');
		expect(result.subject).toBe('start in repo/src/server.ts');
		expect(model.requests[0]?.prompt).toContain('Code:\n```ts\n\tstart(port: number) {');
	});

	it('falls back to references without a call hierarchy', async () => {
		const model = fakeModel('flowchart LR\n a-->b');
		await diagram(source(fakeServer({}, ['callHierarchyProvider'])), null, { model });
		expect(model.requests[0]?.prompt).toContain('Used from:\n- Server: repo/src/app.ts');
	});

	it('rejects a reply that is not a diagram', async () => {
		await expect(diagram(source(null), null, { model: fakeModel('Sorry, I cannot.') })).rejects.toThrow('did not return a Mermaid diagram');
	});
});
