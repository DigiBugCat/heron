import { LAYOUT, layeredLayout, Rect } from './layout';

/** A JSON Canvas node (https://jsoncanvas.org). Unknown keys are kept. */
export interface CanvasNode {
	id: string;
	type: 'text' | 'file' | 'link' | 'group';
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
	text?: string;
	file?: string;
	label?: string;
	[key: string]: unknown;
}

export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';

export interface CanvasEdge {
	id: string;
	fromNode: string;
	toNode: string;
	fromSide?: CanvasSide;
	toSide?: CanvasSide;
	toEnd?: 'none' | 'arrow';
	color?: string;
	label?: string;
	[key: string]: unknown;
}

/** What Heron records about a canvas it generated, under the top-level `heron` key. */
export interface CodeMapMeta {
	kind: 'code-map' | 'call-graph';
	version: 1;
	/** Code map: vault path of the mapped folder. Call graph: the symbol's vault path or absolute path. */
	source: string;
	level: 'files' | 'folders' | 'calls';
}

export interface CanvasData {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	heron?: CodeMapMeta;
	[key: string]: unknown;
}

/** Canvas preset colours: 1 red, 2 orange, 4 green, 6 purple. */
export const CANVAS_COLORS = { conflict: '1', modified: '2', added: '4', focus: '6' } as const;

/** Every id Heron generates starts with this, so regeneration can tell its nodes from the user's. */
export const ID_PREFIX = 'heron-';
export const LEGEND_ID = `${ID_PREFIX}legend`;

/** A map, before layout: text cards, groups to put them in, and arrows between them. */
export interface MapModel {
	nodes: { id: string; text: string; group: string | null; color?: string }[];
	edges: { from: string; to: string; label?: string }[];
	/** Label shown on each group's box, by group key. */
	groupLabels: Map<string, string>;
	/** Optional card shown above the map. */
	legend?: string;
}

export interface RenderedMap {
	canvas: CanvasData;
	/** Node ids in each group node, by the group node's id. */
	members: Map<string, string[]>;
}

/** FNV-1a, 32 bits, from a given offset basis. */
function fnv1a(text: string, basis: number): number {
	let h = basis >>> 0;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/** A stable id for `key` (for example a file path), the same every time it is generated. */
export function stableId(kind: string, key: string): string {
	const a = fnv1a(key, 0x811c9dc5).toString(16).padStart(8, '0');
	const b = fnv1a(key, 0x01000193 ^ 0x9e3779b9).toString(16).padStart(8, '0');
	return `${ID_PREFIX}${kind}-${a}${b}`;
}

/** The text of a markdown line as it reads on screen: links show their alias, without code marks. */
export function visibleText(line: string): string {
	return line
		.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
		.replace(/\[\[([^\]]*)\]\]/g, (_, target: string) => target.slice(target.lastIndexOf('/') + 1))
		.replace(/[`*_]/g, '')
		.replace(/^#+\s*/, '');
}

const CHAR_WIDTH = 8.4;
const LINE_HEIGHT = 26;
const TEXT_PADDING_X = 48;
const TEXT_PADDING_Y = 36;
export const NODE_WIDTH = { min: 200, max: 420 } as const;

/** A text card's size for `text`, wide enough for its longest line within limits. */
export function sizeForText(text: string): { width: number; height: number } {
	const lines = text.split('\n').map(visibleText);
	const longest = Math.max(0, ...lines.map((l) => l.length));
	const width = Math.min(NODE_WIDTH.max, Math.max(NODE_WIDTH.min, Math.ceil(longest * CHAR_WIDTH + TEXT_PADDING_X)));
	const perLine = Math.max(1, Math.floor((width - TEXT_PADDING_X) / CHAR_WIDTH));
	const rows = lines.reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / perLine)), 0);
	const height = Math.ceil((rows * LINE_HEIGHT + TEXT_PADDING_Y) / 10) * 10;
	return { width: Math.ceil(width / 10) * 10, height };
}

/** The side of `a` facing `b`, so arrows leave and enter nodes sensibly wherever they are. */
export function facingSide(a: Rect, b: Rect): CanvasSide {
	const dx = b.x + b.width / 2 - (a.x + a.width / 2);
	const dy = b.y + b.height / 2 - (a.y + a.height / 2);
	if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
	return dy >= 0 ? 'bottom' : 'top';
}

/** Edges between Heron's nodes, with sides picked from the nodes' positions. */
function edgesFor(model: MapModel, rects: Map<string, Rect>): CanvasEdge[] {
	const edges: CanvasEdge[] = [];
	for (const e of model.edges) {
		const from = rects.get(e.from);
		const to = rects.get(e.to);
		if (!from || !to || e.from === e.to) continue;
		edges.push({
			id: stableId('e', `${e.from}>${e.to}`),
			fromNode: e.from,
			fromSide: facingSide(from, to),
			toNode: e.to,
			toSide: facingSide(to, from),
			toEnd: 'arrow',
			...(e.label ? { label: e.label } : {}),
		});
	}
	return edges;
}

const LEGEND_GAP = 120;

/**
 * Lays out `model` and returns the canvas: group boxes first (so they sit
 * behind), then the cards, then the legend above the map.
 */
export function renderMap(model: MapModel, meta: CodeMapMeta): RenderedMap {
	const sizes = new Map(model.nodes.map((n) => [n.id, sizeForText(n.text)]));
	const layout = layeredLayout(
		model.nodes.map((n) => ({ id: n.id, group: n.group, ...(sizes.get(n.id) ?? { width: 0, height: 0 }) })),
		model.edges,
	);
	const members = new Map<string, string[]>();
	const groupNodes: CanvasNode[] = [];
	for (const [key, rect] of [...layout.groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		const id = stableId('g', key);
		members.set(id, model.nodes.filter((n) => n.group === key).map((n) => n.id));
		groupNodes.push({ id, type: 'group', ...rect, label: model.groupLabels.get(key) ?? key });
	}
	const cards: CanvasNode[] = model.nodes.map((n) => ({
		id: n.id,
		type: 'text',
		...(layout.nodes.get(n.id) ?? { x: 0, y: 0, width: NODE_WIDTH.min, height: 60 }),
		text: n.text,
		...(n.color ? { color: n.color } : {}),
	}));
	const nodes = [...groupNodes, ...cards];
	if (model.legend) {
		const size = sizeForText(model.legend);
		const top = Math.min(0, ...nodes.map((n) => n.y));
		const left = Math.min(0, ...nodes.map((n) => n.x));
		nodes.push({ id: LEGEND_ID, type: 'text', x: left, y: top - LEGEND_GAP - size.height, ...size, text: model.legend });
	}
	return { canvas: { nodes, edges: edgesFor(model, layout.nodes), heron: meta }, members };
}

/** Parses a canvas file's text; null when it is not a canvas. */
export function parseCanvas(text: string): CanvasData | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const data = raw as Record<string, unknown>;
	const nodes = Array.isArray(data.nodes) ? data.nodes : [];
	const edges = Array.isArray(data.edges) ? data.edges : [];
	const isNode = (n: unknown): n is CanvasNode => !!n && typeof n === 'object' && typeof (n as CanvasNode).id === 'string'
		&& typeof (n as CanvasNode).x === 'number' && typeof (n as CanvasNode).y === 'number';
	const isEdge = (e: unknown): e is CanvasEdge => !!e && typeof e === 'object' && typeof (e as CanvasEdge).id === 'string'
		&& typeof (e as CanvasEdge).fromNode === 'string' && typeof (e as CanvasEdge).toNode === 'string';
	return { ...data, nodes: nodes.filter(isNode), edges: edges.filter(isEdge) };
}

/** The Heron metadata of a parsed canvas, if it is a code map or call graph Heron generated. */
export function codeMapMeta(canvas: CanvasData | null): CodeMapMeta | null {
	const meta = canvas?.heron;
	if (!meta || typeof meta !== 'object') return null;
	if ((meta.kind !== 'code-map' && meta.kind !== 'call-graph') || typeof meta.source !== 'string') return null;
	return meta;
}

/** Serializes a canvas the way Obsidian writes them. */
export function stringifyCanvas(canvas: CanvasData): string {
	return JSON.stringify(canvas, null, '\t');
}

function overlaps(a: Rect, b: Rect, margin: number): boolean {
	return a.x < b.x + b.width + margin && b.x < a.x + a.width + margin
		&& a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;
}

function distance(a: Rect, b: Rect): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

const MERGE_MARGIN = 20;

/**
 * Combines a freshly rendered map with the canvas it replaces. Cards that
 * were already there keep the position the user gave them (matched by
 * their path-derived ids); new cards go where the fresh layout puts them
 * relative to the nearest card that stayed (a folder sibling, else an
 * import neighbour), moved down until they overlap nothing. Cards for
 * deleted files disappear, group boxes are fitted around their cards
 * again, and colours, texts and arrows are refreshed. Nodes and edges the
 * user added themselves are kept as they are.
 */
export function mergeCanvas(previous: CanvasData | null, fresh: RenderedMap): CanvasData {
	if (!previous) return fresh.canvas;
	const prevById = new Map(previous.nodes.map((n) => [n.id, n]));
	const isOwn = (id: string) => id.startsWith(ID_PREFIX);
	const freshGroups = fresh.canvas.nodes.filter((n) => n.type === 'group');
	const freshCards = fresh.canvas.nodes.filter((n) => n.type !== 'group');
	const groupOf = new Map<string, string>();
	for (const [group, ids] of fresh.members) for (const id of ids) groupOf.set(id, group);
	const neighbours = new Map<string, Set<string>>();
	for (const e of fresh.canvas.edges) {
		if (!neighbours.has(e.fromNode)) neighbours.set(e.fromNode, new Set());
		if (!neighbours.has(e.toNode)) neighbours.set(e.toNode, new Set());
		neighbours.get(e.fromNode)?.add(e.toNode);
		neighbours.get(e.toNode)?.add(e.fromNode);
	}

	const freshRect = new Map(freshCards.map((n) => [n.id, n as Rect]));
	const kept = freshCards.filter((n) => prevById.has(n.id));
	const added = freshCards.filter((n) => !prevById.has(n.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
	const placed = new Map<string, CanvasNode>();
	for (const n of kept) {
		const old = prevById.get(n.id);
		placed.set(n.id, { ...n, x: old?.x ?? n.x, y: old?.y ?? n.y });
	}
	const userNodes = previous.nodes.filter((n) => !isOwn(n.id));
	const occupied: Rect[] = [...placed.values(), ...userNodes.filter((n) => n.type !== 'group')];
	for (const n of added) {
		const candidates = (filter: (id: string) => boolean) => kept
			.filter((k) => k.id !== LEGEND_ID && filter(k.id))
			.sort((a, b) => distance(a, n) - distance(b, n) || (a.id < b.id ? -1 : 1));
		const group = groupOf.get(n.id);
		const anchor = candidates((id) => !!group && groupOf.get(id) === group)[0]
			?? candidates((id) => neighbours.get(n.id)?.has(id) ?? false)[0]
			?? candidates(() => true)[0];
		const from = anchor ? freshRect.get(anchor.id) : undefined;
		const to = anchor ? placed.get(anchor.id) : undefined;
		const rect: Rect = { x: n.x + (to && from ? to.x - from.x : 0), y: n.y + (to && from ? to.y - from.y : 0), width: n.width, height: n.height };
		for (let guard = 0; guard < 1000; guard++) {
			const hits = occupied.filter((o) => overlaps(rect, o, MERGE_MARGIN));
			if (!hits.length) break;
			rect.y = Math.max(...hits.map((o) => o.y + o.height)) + MERGE_MARGIN * 2;
		}
		const node = { ...n, x: rect.x, y: rect.y };
		placed.set(n.id, node);
		occupied.push(node);
	}

	const groups: CanvasNode[] = [];
	for (const g of freshGroups) {
		const cards = (fresh.members.get(g.id) ?? []).map((id) => placed.get(id)).filter((c): c is CanvasNode => !!c);
		if (!cards.length) continue;
		const pad = LAYOUT.groupPadding;
		const x = Math.min(...cards.map((c) => c.x)) - pad;
		const y = Math.min(...cards.map((c) => c.y)) - pad;
		const right = Math.max(...cards.map((c) => c.x + c.width)) + pad;
		const bottom = Math.max(...cards.map((c) => c.y + c.height)) + pad;
		groups.push({ ...g, x, y, width: right - x, height: bottom - y });
	}

	const cards = freshCards.map((n) => placed.get(n.id) ?? n);
	const nodes = [...userNodes.filter((n) => n.type === 'group'), ...groups, ...cards, ...userNodes.filter((n) => n.type !== 'group')];
	const rects = new Map(nodes.map((n) => [n.id, n as Rect]));
	const edges = fresh.canvas.edges.map((e) => {
		const from = rects.get(e.fromNode);
		const to = rects.get(e.toNode);
		return from && to ? { ...e, fromSide: facingSide(from, to), toSide: facingSide(to, from) } : e;
	});
	const userEdges = previous.edges.filter((e) => !isOwn(e.id) && rects.has(e.fromNode) && rects.has(e.toNode));
	return { ...previous, ...fresh.canvas, nodes, edges: [...edges, ...userEdges] };
}
