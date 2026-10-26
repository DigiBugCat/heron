export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LayoutNode {
	id: string;
	/** Nodes with the same group are laid out together inside one box; null for none. */
	group: string | null;
	width: number;
	height: number;
}

export interface LayoutEdge {
	from: string;
	to: string;
}

export interface LayoutResult {
	nodes: Map<string, Rect>;
	/** The box around each group's nodes. */
	groups: Map<string, Rect>;
}

export const LAYOUT = {
	/** Space between columns of nodes inside a group. */
	gapX: 80,
	/** Space between nodes in a column. */
	gapY: 30,
	/** Space between a group's box and its nodes. */
	groupPadding: 40,
	/** Space between columns of groups. */
	groupGapX: 160,
	/** Space between groups in a column; leaves room for the group's label above it. */
	groupGapY: 90,
	/** Columns taller than this wrap into several (unless one node is taller). */
	maxColumnHeight: 1100,
	maxGroupColumnHeight: 2600,
	/** Barycenter sweeps when ordering layers. */
	sweeps: 8,
} as const;

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Splits `ids` into layers, left to right, so that edges point rightwards:
 * cycles are broken by dropping back edges of a depth-first search, then
 * each node goes one layer after its furthest predecessor (longest path).
 * Within layers, nodes are ordered by repeated barycenter sweeps to reduce
 * crossings. Fully deterministic: inputs are sorted first.
 */
export function layerAndOrder(ids: string[], edges: LayoutEdge[], sweeps: number = LAYOUT.sweeps): string[][] {
	const nodes = [...new Set(ids)].sort(compare);
	const known = new Set(nodes);
	const succ = new Map<string, string[]>(nodes.map((n) => [n, []]));
	const seenEdge = new Set<string>();
	for (const e of edges) {
		const key = `${e.from}\0${e.to}`;
		if (e.from === e.to || !known.has(e.from) || !known.has(e.to) || seenEdge.has(key)) continue;
		seenEdge.add(key);
		succ.get(e.from)?.push(e.to);
	}
	for (const list of succ.values()) list.sort(compare);

	// Drop back edges (iterative DFS, nodes and successors in sorted order).
	const state = new Map<string, 1 | 2>();
	const dag = new Map<string, string[]>(nodes.map((n) => [n, []]));
	for (const start of nodes) {
		if (state.has(start)) continue;
		const stack: { node: string; next: number }[] = [{ node: start, next: 0 }];
		state.set(start, 1);
		while (stack.length) {
			const top = stack[stack.length - 1];
			if (!top) break;
			const out = succ.get(top.node) ?? [];
			if (top.next >= out.length) {
				state.set(top.node, 2);
				stack.pop();
				continue;
			}
			const to = out[top.next++];
			if (to === undefined) continue;
			const s = state.get(to);
			if (s === 1) continue; // back edge: dropped
			dag.get(top.node)?.push(to);
			if (!s) {
				state.set(to, 1);
				stack.push({ node: to, next: 0 });
			}
		}
	}

	// Longest-path layering over a topological order.
	const indegree = new Map<string, number>(nodes.map((n) => [n, 0]));
	for (const list of dag.values()) for (const to of list) indegree.set(to, (indegree.get(to) ?? 0) + 1);
	const layer = new Map<string, number>(nodes.map((n) => [n, 0]));
	const queue = nodes.filter((n) => indegree.get(n) === 0);
	for (let qi = 0; qi < queue.length; qi++) {
		const n = queue[qi] ?? '';
		for (const to of dag.get(n) ?? []) {
			layer.set(to, Math.max(layer.get(to) ?? 0, (layer.get(n) ?? 0) + 1));
			const left = (indegree.get(to) ?? 0) - 1;
			indegree.set(to, left);
			if (left === 0) queue.push(to);
		}
	}
	const count = Math.max(0, ...layer.values()) + 1;
	const layers: string[][] = Array.from({ length: nodes.length ? count : 0 }, () => []);
	for (const n of nodes) layers[layer.get(n) ?? 0]?.push(n);

	// Barycenter ordering: neighbours in any other layer, by normalized position.
	const neighbours = new Map<string, string[]>(nodes.map((n) => [n, []]));
	for (const [from, list] of dag) {
		for (const to of list) {
			neighbours.get(from)?.push(to);
			neighbours.get(to)?.push(from);
		}
	}
	const position = new Map<string, number>();
	const place = (l: string[]) => l.forEach((n, i) => position.set(n, (i + 0.5) / l.length));
	layers.forEach(place);
	for (let sweep = 0; sweep < sweeps; sweep++) {
		const down = sweep % 2 === 0;
		const order = layers.map((_, i) => i);
		if (!down) order.reverse();
		for (const li of order) {
			const current = layers[li];
			if (!current) continue;
			const towards = (other: number) => (down ? other < li : other > li);
			const bary = new Map<string, number>();
			for (const n of current) {
				const ns = (neighbours.get(n) ?? []).filter((m) => towards(layer.get(m) ?? 0));
				bary.set(n, ns.length ? ns.reduce((sum, m) => sum + (position.get(m) ?? 0), 0) / ns.length : position.get(n) ?? 0);
			}
			const index = new Map(current.map((n, i) => [n, i]));
			current.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0) || (index.get(a) ?? 0) - (index.get(b) ?? 0));
			place(current);
		}
	}
	return layers;
}

interface Sized {
	id: string;
	width: number;
	height: number;
}

/**
 * Places ordered layers as columns, left to right, top-aligned; a column
 * taller than `maxHeight` wraps into further columns. Returns positions
 * relative to (0, 0) and the overall size.
 */
function placeColumns(layers: string[][], size: Map<string, Sized>, gapX: number, gapY: number, maxHeight: number, center: boolean) {
	const rects = new Map<string, Rect>();
	const columns: string[][] = [];
	for (const l of layers) {
		let column: string[] = [];
		let height = 0;
		for (const id of l) {
			const h = size.get(id)?.height ?? 0;
			if (column.length && height + gapY + h > maxHeight) {
				columns.push(column);
				column = [];
				height = 0;
			}
			height += (column.length ? gapY : 0) + h;
			column.push(id);
		}
		if (column.length) columns.push(column);
	}
	const heights = columns.map((c) => c.reduce((sum, id, i) => sum + (i ? gapY : 0) + (size.get(id)?.height ?? 0), 0));
	const totalHeight = Math.max(0, ...heights);
	let x = 0;
	columns.forEach((column, ci) => {
		const width = Math.max(...column.map((id) => size.get(id)?.width ?? 0));
		let y = center ? Math.round((totalHeight - (heights[ci] ?? 0)) / 2) : 0;
		for (const id of column) {
			const s = size.get(id);
			rects.set(id, { x, y, width: s?.width ?? 0, height: s?.height ?? 0 });
			y += (s?.height ?? 0) + gapY;
		}
		x += width + gapX;
	});
	return { rects, width: Math.max(0, x - gapX), height: totalHeight };
}

/**
 * Lays out a graph left to right in two levels. Inside each group, nodes
 * are layered by the edges between them; the groups themselves (and nodes
 * without a group) are then layered by the edges between groups. Groups
 * never overlap, and the same input always gives the same layout,
 * whatever order it comes in.
 */
export function layeredLayout(nodes: LayoutNode[], edges: LayoutEdge[]): LayoutResult {
	const sorted = [...nodes].sort((a, b) => compare(a.id, b.id));
	const clusterOf = new Map<string, string>();
	const members = new Map<string, LayoutNode[]>();
	for (const n of sorted) {
		// Group and lone-node cluster ids cannot collide: '\u0001' never appears in ids.
		const cluster = n.group === null ? `\u0001${n.id}` : `\u0002${n.group}`;
		clusterOf.set(n.id, cluster);
		const list = members.get(cluster) ?? [];
		list.push(n);
		members.set(cluster, list);
	}

	// Inner layouts.
	const inner = new Map<string, { rects: Map<string, Rect>; width: number; height: number }>();
	const clusterSize = new Map<string, Sized>();
	for (const [cluster, list] of members) {
		const ids = list.map((n) => n.id);
		const idSet = new Set(ids);
		const layers = layerAndOrder(ids, edges.filter((e) => idSet.has(e.from) && idSet.has(e.to)));
		const size = new Map(list.map((n) => [n.id, n as Sized]));
		const placed = placeColumns(layers, size, LAYOUT.gapX, LAYOUT.gapY, LAYOUT.maxColumnHeight, false);
		inner.set(cluster, placed);
		const pad = cluster.startsWith('\u0002') ? LAYOUT.groupPadding : 0;
		clusterSize.set(cluster, { id: cluster, width: placed.width + 2 * pad, height: placed.height + 2 * pad });
	}

	// Outer layout of clusters.
	const clusterEdges = edges
		.map((e) => ({ from: clusterOf.get(e.from) ?? '', to: clusterOf.get(e.to) ?? '' }))
		.filter((e) => e.from && e.to && e.from !== e.to);
	const outerLayers = layerAndOrder([...members.keys()], clusterEdges);
	const outer = placeColumns(outerLayers, clusterSize, LAYOUT.groupGapX, LAYOUT.groupGapY, LAYOUT.maxGroupColumnHeight, true);

	const result: LayoutResult = { nodes: new Map(), groups: new Map() };
	for (const [cluster, box] of outer.rects) {
		const placed = inner.get(cluster);
		if (!placed) continue;
		const isGroup = cluster.startsWith('\u0002');
		const pad = isGroup ? LAYOUT.groupPadding : 0;
		for (const [id, r] of placed.rects) result.nodes.set(id, { ...r, x: box.x + pad + r.x, y: box.y + pad + r.y });
		if (isGroup) result.groups.set(cluster.slice(1), { ...box });
	}
	return result;
}
