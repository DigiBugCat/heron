import { describe, expect, it } from 'vitest';
import { buildCallGraph, Requester } from '../src/lsp/callHierarchy';
import { callMapModel } from '../src/codemap/callMap';
import { renderMap, stableId } from '../src/codemap/canvas';

function item(name: string, file: string, line: number) {
	return { name, kind: 12, uri: `file:///repo/${file}`, range: { start: { line, character: 0 }, end: { line: line + 3, character: 1 } }, selectionRange: { start: { line, character: 9 }, end: { line, character: 9 + name.length } }, data: { id: name } };
}

/** main → run → [parse, save]; save → write; test → run; cli → main. */
const ITEMS = {
	main: item('main', 'src/main.ts', 1),
	run: item('run', 'src/app.ts', 10),
	parse: item('parse', 'src/parse.ts', 2),
	save: item('save', 'src/store.ts', 5),
	write: item('write', 'src/store.ts', 20),
	test: item('test', 'test/app.test.ts', 3),
	cli: item('cli', 'bin/cli.ts', 0),
};
type Name = keyof typeof ITEMS;
const CALLS: [Name, Name][] = [['main', 'run'], ['run', 'parse'], ['run', 'save'], ['save', 'write'], ['test', 'run'], ['cli', 'main']];

function fakeServer(log: string[]): Requester {
	return async (method, params) => {
		log.push(method);
		const p = params as { item?: { data: { id: Name } } };
		if (method === 'textDocument/prepareCallHierarchy') return [ITEMS.run];
		const name = p.item?.data.id;
		if (method === 'callHierarchy/outgoingCalls') return CALLS.filter(([from]) => from === name).map(([, to]) => ({ to: ITEMS[to], fromRanges: [] }));
		if (method === 'callHierarchy/incomingCalls') return CALLS.filter(([, to]) => to === name).map(([from]) => ({ from: ITEMS[from], fromRanges: [] }));
		throw new Error('unexpected');
	};
}

describe('call graph', () => {
	const doc = { uri: 'file:///repo/src/app.ts' };
	const pos = { line: 10, character: 12 };

	it('follows outgoing and incoming calls to the given depth', async () => {
		const log: string[] = [];
		const graph = await buildCallGraph(fakeServer(log), doc, pos, { depth: 1, maxItems: 50 });
		expect(graph?.items.map((i) => i.name).sort()).toEqual(['main', 'parse', 'run', 'save', 'test']);
		const name = (key: string) => graph?.items.find((i) => i.key === key)?.name;
		expect(graph?.edges.map((e) => `${name(e.from)}>${name(e.to)}`).sort()).toEqual(['main>run', 'run>parse', 'run>save', 'test>run']);
		expect(graph?.items.find((i) => i.name === 'run')).toMatchObject({ kind: 'function', absPath: '/repo/src/app.ts', line: 10 });

		const deeper = await buildCallGraph(fakeServer([]), doc, pos, { depth: 2, maxItems: 50 });
		expect(deeper?.items.map((i) => i.name).sort()).toEqual(['cli', 'main', 'parse', 'run', 'save', 'test', 'write']);
		expect(deeper?.truncated).toBe(false);
	});

	it('stops at the size limit and says so', async () => {
		const graph = await buildCallGraph(fakeServer([]), doc, pos, { depth: 3, maxItems: 3 });
		expect(graph?.items).toHaveLength(3);
		expect(graph?.truncated).toBe(true);
	});

	it('returns null when there is no symbol, and survives failing requests', async () => {
		expect(await buildCallGraph(async () => null, doc, pos)).toBeNull();
		const failing: Requester = async (method) => {
			if (method === 'textDocument/prepareCallHierarchy') return [ITEMS.run];
			throw new Error('boom');
		};
		expect((await buildCallGraph(failing, doc, pos))?.items.map((i) => i.name)).toEqual(['run']);
	});

	it('renders functions grouped by file, with the symbol highlighted', async () => {
		const graph = await buildCallGraph(fakeServer([]), doc, pos, { depth: 1, maxItems: 50 });
		if (!graph) throw new Error('no graph');
		const model = callMapModel(graph, {
			vaultPath: (abs) => `Code${abs}`,
			label: (abs) => abs.replace('/repo/', ''),
		});
		const { canvas } = renderMap(model, { kind: 'call-graph', version: 1, source: 'Code/repo/src/app.ts', level: 'calls' });
		const run = canvas.nodes.find((n) => n.id === stableId('c', graph.root));
		expect(run).toMatchObject({ color: '6' });
		expect(run?.text).toBe('**run**\nfunction · [[Code/repo/src/app.ts|app.ts]] · line 11');
		expect(canvas.nodes.filter((n) => n.type === 'group').map((n) => n.label).sort()).toEqual(['src/app.ts', 'src/main.ts', 'src/parse.ts', 'src/store.ts', 'test/app.test.ts']);
		expect(canvas.edges).toHaveLength(4);
	});
});
