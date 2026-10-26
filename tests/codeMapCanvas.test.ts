import { describe, expect, it } from 'vitest';
import {
	CanvasData, codeMapMeta, CodeMapMeta, facingSide, LEGEND_ID, MapModel, mergeCanvas, NODE_WIDTH, parseCanvas,
	renderMap, sizeForText, stableId, stringifyCanvas,
} from '../src/codemap/canvas';
import { LAYOUT, layeredLayout, layerAndOrder, LayoutEdge, LayoutNode, Rect } from '../src/codemap/layout';
import { fileMapModel, folderMapModel, MapContext } from '../src/codemap/models';
import { buildGraph, folderGraph } from '../src/codemap/graph';

/** Deterministic shuffle. */
function shuffle<T>(items: T[], seed: number): T[] {
	const out = [...items];
	let s = seed;
	for (let i = out.length - 1; i > 0; i--) {
		s = (s * 1103515245 + 12345) % 2147483648;
		const j = s % (i + 1);
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

function inside(inner: Rect, outer: Rect): boolean {
	return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

function overlap(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Crossings between edges from one layer to the next. */
function crossings(top: string[], bottom: string[], edges: LayoutEdge[]): number {
	const pairs = edges
		.filter((e) => top.includes(e.from) && bottom.includes(e.to))
		.map((e) => [top.indexOf(e.from), bottom.indexOf(e.to)] as const);
	let count = 0;
	for (let i = 0; i < pairs.length; i++) {
		for (let j = i + 1; j < pairs.length; j++) {
			const [a1, b1] = pairs[i] ?? [0, 0];
			const [a2, b2] = pairs[j] ?? [0, 0];
			if ((a1 - a2) * (b1 - b2) < 0) count++;
		}
	}
	return count;
}

const node = (id: string, group: string | null, width = 200, height = 100): LayoutNode => ({ id, group, width, height });

describe('code map: layout', () => {
	const nodes = [
		node('src/main.ts', 'src'), node('src/app.ts', 'src'), node('src/util/a.ts', 'src/util'), node('src/util/b.ts', 'src/util', 260, 140),
		node('src/ui/view.ts', 'src/ui'), node('src/ui/menu.ts', 'src/ui'), node('README.ts', null), node('src/util/c.ts', 'src/util'),
	];
	const edges: LayoutEdge[] = [
		{ from: 'src/main.ts', to: 'src/app.ts' }, { from: 'src/app.ts', to: 'src/ui/view.ts' }, { from: 'src/ui/view.ts', to: 'src/ui/menu.ts' },
		{ from: 'src/ui/menu.ts', to: 'src/util/a.ts' }, { from: 'src/util/a.ts', to: 'src/util/b.ts' }, { from: 'src/app.ts', to: 'src/util/c.ts' },
		{ from: 'src/util/b.ts', to: 'src/util/a.ts' }, // a cycle
	];

	it('is deterministic whatever order the input comes in', () => {
		const first = layeredLayout(nodes, edges);
		for (const seed of [1, 7, 42]) {
			const again = layeredLayout(shuffle(nodes, seed), shuffle(edges, seed + 1));
			expect([...again.nodes].sort()).toEqual([...first.nodes].sort());
			expect([...again.groups].sort()).toEqual([...first.groups].sort());
		}
	});

	it('flows left to right, keeps nodes inside their group and groups apart', () => {
		const { nodes: rects, groups } = layeredLayout(nodes, edges);
		expect(rects.size).toBe(nodes.length);
		const x = (id: string) => rects.get(id)?.x ?? NaN;
		expect(x('src/main.ts')).toBeLessThan(x('src/app.ts'));
		expect(x('src/app.ts')).toBeLessThan(x('src/ui/view.ts'));
		expect(x('src/ui/view.ts')).toBeLessThan(x('src/ui/menu.ts'));
		expect(x('src/ui/menu.ts')).toBeLessThan(x('src/util/a.ts'));
		for (const n of nodes) {
			if (n.group) expect(inside(rects.get(n.id) as Rect, groups.get(n.group) as Rect)).toBe(true);
			expect(rects.get(n.id)).toMatchObject({ width: n.width, height: n.height });
		}
		const boxes = [...groups.values(), rects.get('README.ts') as Rect];
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i] as Rect, boxes[j] as Rect)).toBe(false);
		}
	});

	it('orders layers to remove crossings', () => {
		const top = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'];
		const perm = [3, 0, 5, 1, 4, 2];
		const bottom = top.map((_, i) => `b${i}`);
		const es = top.map((a, i) => ({ from: a, to: `b${perm[i]}` }));
		expect(crossings(top, bottom, es)).toBeGreaterThan(0);
		const layers = layerAndOrder([...top, ...bottom], es);
		expect(layers).toHaveLength(2);
		expect(crossings(layers[0] ?? [], layers[1] ?? [], es)).toBe(0);
	});

	it('breaks cycles and wraps tall columns', () => {
		expect(layerAndOrder(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }])).toEqual([['a'], ['b'], ['c']]);
		const many = Array.from({ length: 30 }, (_, i) => node(`f${String(i).padStart(2, '0')}`, 'g'));
		const { nodes: rects, groups } = layeredLayout(many, []);
		const columns = new Set([...rects.values()].map((r) => r.x));
		expect(columns.size).toBeGreaterThan(1);
		expect((groups.get('g')?.height ?? 0) - 2 * LAYOUT.groupPadding).toBeLessThanOrEqual(LAYOUT.maxColumnHeight);
	});
});

const meta: CodeMapMeta = { kind: 'code-map', version: 1, source: 'Code/app', level: 'files' };

function ctx(changes: Record<string, 'added' | 'modified'> = {}): MapContext {
	return {
		scope: '',
		rootLabel: 'app',
		vaultPath: (p) => `Code/app/${p}`,
		change: (p) => changes[p],
		now: new Date(2026, 9, 26, 9, 5),
	};
}

const SOURCES = [
	{ path: 'src/main.ts', text: 'import { run } from "./app";\nimport "react";\nexport function main() {}\n' },
	{ path: 'src/app.ts', text: 'import { a } from "./util/a";\nexport function run() {}\n' },
	{ path: 'src/util/a.ts', text: 'export const a = 1;\n' },
	{ path: 'index.ts', text: 'import "./src/main";\n' },
];

function graphOf(sources = SOURCES) {
	return buildGraph({ files: sources.map((s) => s.path), configs: new Map(), sources });
}

/** Checks the parts of the JSON Canvas spec a generated canvas must meet. */
function expectValidCanvas(canvas: CanvasData) {
	const parsed = JSON.parse(stringifyCanvas(canvas)) as CanvasData;
	const ids = new Set<string>();
	for (const n of parsed.nodes) {
		expect(ids.has(n.id)).toBe(false);
		ids.add(n.id);
		expect(['text', 'file', 'link', 'group']).toContain(n.type);
		for (const k of ['x', 'y', 'width', 'height'] as const) expect(Number.isInteger(n[k])).toBe(true);
		expect(n.width).toBeGreaterThan(0);
		expect(n.height).toBeGreaterThan(0);
		if (n.type === 'text') expect(typeof n.text).toBe('string');
		if (n.color !== undefined) expect(n.color).toMatch(/^(?:[1-6]|#[0-9a-fA-F]{6})$/);
	}
	for (const e of parsed.edges) {
		expect(ids.has(e.id)).toBe(false);
		ids.add(e.id);
		expect(parsed.nodes.some((n) => n.id === e.fromNode)).toBe(true);
		expect(parsed.nodes.some((n) => n.id === e.toNode)).toBe(true);
		for (const side of [e.fromSide, e.toSide]) if (side !== undefined) expect(['top', 'right', 'bottom', 'left']).toContain(side);
	}
	// Groups come first so they are drawn behind the cards.
	const firstCard = parsed.nodes.findIndex((n) => n.type !== 'group');
	const lastGroup = parsed.nodes.map((n) => n.type).lastIndexOf('group');
	expect(lastGroup).toBeLessThan(firstCard === -1 ? Infinity : firstCard);
}

describe('code map: canvas', () => {
	it('derives stable, distinct ids from paths', () => {
		expect(stableId('f', 'src/a.ts')).toBe(stableId('f', 'src/a.ts'));
		expect(stableId('f', 'src/a.ts')).not.toBe(stableId('f', 'src/b.ts'));
		expect(stableId('f', 'src/a.ts')).not.toBe(stableId('d', 'src/a.ts'));
		expect(stableId('f', 'src/a.ts')).toMatch(/^heron-f-[0-9a-f]{16}$/);
	});

	it('sizes cards to their text within limits', () => {
		const short = sizeForText('[[Code/app/src/a.ts|a.ts]]\n1 line');
		const long = sizeForText('[[Code/app/src/a.ts|a_much_longer_file_name_for_testing.ts]]\n1 line');
		expect(short.width).toBe(NODE_WIDTH.min);
		expect(long.width).toBeGreaterThan(short.width);
		expect(sizeForText('x'.repeat(500)).width).toBe(NODE_WIDTH.max);
		expect(sizeForText('a\nb\nc').height).toBeGreaterThan(sizeForText('a').height);
	});

	it('renders a valid canvas of linked file cards grouped by folder, coloured by git status', () => {
		const model = fileMapModel(graphOf(), ctx({ 'src/app.ts': 'modified', 'src/util/a.ts': 'added' }));
		const { canvas, members } = renderMap(model, meta);
		expectValidCanvas(canvas);
		expect(canvas.heron).toEqual(meta);
		const card = (p: string) => canvas.nodes.find((n) => n.id === stableId('f', p));
		expect(card('src/main.ts')?.text).toBe('[[Code/app/src/main.ts|main.ts]]\n`main`\n3 lines · 1 package');
		expect(card('src/app.ts')).toMatchObject({ color: '2' });
		expect(card('src/app.ts')?.text).toContain('changed');
		expect(card('src/util/a.ts')).toMatchObject({ color: '4' });
		expect(card('src/main.ts')?.color).toBeUndefined();
		const groups = canvas.nodes.filter((n) => n.type === 'group');
		expect(groups.map((g) => g.label).sort()).toEqual(['app', 'src', 'src/util']);
		for (const g of groups) {
			for (const id of members.get(g.id) ?? []) expect(inside(canvas.nodes.find((n) => n.id === id) as Rect, g)).toBe(true);
		}
		expect(canvas.edges).toHaveLength(3);
		expect(canvas.edges.find((e) => e.fromNode === stableId('f', 'src/main.ts'))).toMatchObject({ toNode: stableId('f', 'src/app.ts'), fromSide: 'right', toSide: 'left' });
		expect(canvas.nodes.find((n) => n.id === LEGEND_ID)?.text).toContain('Updated 2026-10-26 09:05');
	});

	it('renders a valid folder-level canvas with summed import counts', () => {
		const model = folderMapModel(folderGraph(graphOf(), ''), ctx({ 'src/util/a.ts': 'added' }));
		const { canvas } = renderMap(model, { ...meta, level: 'folders' });
		expectValidCanvas(canvas);
		const texts = canvas.nodes.filter((n) => n.type === 'text' && n.id !== LEGEND_ID).map((n) => n.text?.split('\n')[0]);
		expect(texts.sort()).toEqual(['**app/**', '**src/**', '**src/util/**']);
		expect(canvas.nodes.find((n) => n.text?.startsWith('**src/util/**'))).toMatchObject({ color: '4' });
		expect(canvas.edges).toHaveLength(2);
	});

	it('picks the sides of nodes that face each other', () => {
		const a = { x: 0, y: 0, width: 100, height: 100 };
		expect(facingSide(a, { x: 300, y: 20, width: 100, height: 100 })).toBe('right');
		expect(facingSide(a, { x: -300, y: 0, width: 100, height: 100 })).toBe('left');
		expect(facingSide(a, { x: 10, y: 400, width: 100, height: 100 })).toBe('bottom');
		expect(facingSide(a, { x: 10, y: -400, width: 100, height: 100 })).toBe('top');
	});

	it('reads canvases defensively', () => {
		expect(parseCanvas('not json')).toBeNull();
		expect(parseCanvas('[]')).toBeNull();
		expect(parseCanvas('{"nodes":[{"id":"a"},{"id":"b","x":1,"y":2}],"edges":[{"id":"e"}]}')).toEqual({ nodes: [{ id: 'b', x: 1, y: 2 }], edges: [] });
		expect(codeMapMeta(parseCanvas('{"nodes":[],"edges":[]}'))).toBeNull();
		expect(codeMapMeta(parseCanvas(JSON.stringify({ nodes: [], edges: [], heron: meta })))).toEqual(meta);
	});
});

describe('code map: regenerating', () => {
	function render(sources = SOURCES, changes: Record<string, 'added' | 'modified'> = {}) {
		return renderMap(fileMapModel(graphOf(sources), ctx(changes)), meta);
	}

	it('keeps moved cards, drops deleted ones, places new ones near their folder and refreshes colours', () => {
		const first = render().canvas;
		const mainId = stableId('f', 'src/main.ts');
		const appId = stableId('f', 'src/app.ts');
		const indexId = stableId('f', 'index.ts');
		// The user moves two cards, adds a note and connects it, and the file has extra data Obsidian keeps.
		const edited: CanvasData = {
			...first,
			nodes: [
				...first.nodes.map((n) => (n.id === mainId ? { ...n, x: 2000, y: 1500 } : n.id === appId ? { ...n, x: 2400, y: 1500 } : n)),
				{ id: 'user-note', type: 'text', x: -500, y: -500, width: 200, height: 80, text: 'My note' },
			],
			edges: [
				...first.edges,
				{ id: 'user-edge', fromNode: 'user-note', toNode: mainId },
				{ id: 'user-edge-gone', fromNode: 'user-note', toNode: indexId },
			],
			extra: { keep: true },
		};
		const sources = [
			...SOURCES.filter((s) => s.path !== 'index.ts'),
			{ path: 'src/new.ts', text: 'import "./app";\n' },
		];
		const merged = mergeCanvas(parseCanvas(stringifyCanvas(edited)), render(sources, { 'src/main.ts': 'modified' }));
		expectValidCanvas(merged);
		const byId = new Map(merged.nodes.map((n) => [n.id, n]));
		expect(byId.get(mainId)).toMatchObject({ x: 2000, y: 1500, color: '2' });
		expect(byId.get(appId)).toMatchObject({ x: 2400, y: 1500 });
		expect(byId.get(appId)?.color).toBeUndefined();
		expect(byId.has(indexId)).toBe(false);
		expect(byId.get('user-note')).toMatchObject({ x: -500, y: -500, text: 'My note' });
		expect(merged.edges.map((e) => e.id)).toContain('user-edge');
		expect(merged.edges.map((e) => e.id)).not.toContain('user-edge-gone');
		expect(merged.extra).toEqual({ keep: true });
		expect(merged.heron).toEqual(meta);

		// The new file lands next to its moved siblings, without overlapping anything.
		const added = byId.get(stableId('f', 'src/new.ts')) as Rect;
		expect(Math.abs(added.x - 2000)).toBeLessThan(1000);
		expect(Math.abs(added.y - 1500)).toBeLessThan(1000);
		for (const n of merged.nodes) {
			if (n.type !== 'group' && n.id !== stableId('f', 'src/new.ts')) expect(overlap(added, n)).toBe(false);
		}
		// The src group was fitted around its moved cards.
		const srcGroup = byId.get(stableId('g', 'src')) as Rect;
		for (const p of ['src/main.ts', 'src/app.ts', 'src/new.ts']) expect(inside(byId.get(stableId('f', p)) as Rect, srcGroup)).toBe(true);
		// The removed root folder's group is gone.
		expect(byId.has(stableId('g', ''))).toBe(false);
	});

	it('gives the same canvas when nothing changed', () => {
		const first = render().canvas;
		expect(mergeCanvas(first, render())).toEqual(first);
	});

	it('starts fresh without a previous canvas', () => {
		const fresh = render();
		expect(mergeCanvas(null, fresh)).toBe(fresh.canvas);
	});
});

describe('code map: models', () => {
	it('falls back to bold names for files outside the vault or with unlinkable names', () => {
		const model: MapModel = fileMapModel(graphOf([{ path: 'a#b.ts', text: '' }]), { ...ctx(), vaultPath: () => null });
		expect(model.nodes[0]?.text.split('\n')[0]).toBe('**a#b.ts**');
	});
});
