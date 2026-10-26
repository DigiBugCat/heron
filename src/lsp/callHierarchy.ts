import { pathOfUri, symbolKindName } from './locations';

/** A function or method in a call graph. */
export interface CallItem {
	/** Identifies the symbol: its file URI and where its name starts. */
	key: string;
	name: string;
	kind: string;
	detail: string;
	/** Absolute path of its file, or null for a non-file URI. */
	absPath: string | null;
	/** Zero-based line of its name. */
	line: number;
}

export interface CallGraph {
	/** Key of the symbol the graph is about. */
	root: string;
	items: CallItem[];
	/** `from` calls `to`. */
	edges: { from: string; to: string }[];
	/** Calls were left out because the graph reached its size limit. */
	truncated: boolean;
}

export type Requester = (method: string, params: unknown) => Promise<unknown>;

export interface CallGraphOptions {
	/** How many calls away from the symbol to follow, in each direction. */
	depth: number;
	/** Most symbols in the graph. */
	maxItems: number;
}

export const DEFAULT_CALL_GRAPH: CallGraphOptions = { depth: 2, maxItems: 60 };

interface RawItem {
	name: string;
	kind: number;
	detail?: string;
	uri: string;
	selectionRange: { start: { line: number; character: number } };
}

function isRawItem(value: unknown): value is RawItem {
	const v = value as Partial<RawItem> | null;
	return !!v && typeof v.name === 'string' && typeof v.uri === 'string'
		&& typeof v.selectionRange?.start?.line === 'number';
}

function keyOf(item: RawItem): string {
	return `${item.uri}#${item.selectionRange.start.line}:${item.selectionRange.start.character}`;
}

function toItem(item: RawItem): CallItem {
	return {
		key: keyOf(item),
		name: item.name,
		kind: typeof item.kind === 'number' ? symbolKindName(item.kind) : '',
		detail: typeof item.detail === 'string' ? item.detail : '',
		absPath: pathOfUri(item.uri),
		line: item.selectionRange.start.line,
	};
}

async function ask(request: Requester, method: string, params: unknown): Promise<unknown[]> {
	try {
		const response = await request(method, params);
		return Array.isArray(response) ? (response as unknown[]) : [];
	} catch {
		return [];
	}
}

/**
 * Builds the call graph around the symbol at `position`, using the
 * language server's call hierarchy: what it calls and what calls it, up
 * to `depth` calls away each way. Null when there is no symbol there.
 */
export async function buildCallGraph(
	request: Requester,
	textDocument: { uri: string },
	position: { line: number; character: number },
	options: CallGraphOptions = DEFAULT_CALL_GRAPH,
): Promise<CallGraph | null> {
	const prepared = (await ask(request, 'textDocument/prepareCallHierarchy', { textDocument, position })).filter(isRawItem);
	const start = prepared[0];
	if (!start) return null;
	const items = new Map<string, CallItem>([[keyOf(start), toItem(start)]]);
	const edges = new Map<string, { from: string; to: string }>();
	let truncated = false;
	const addEdge = (from: string, to: string) => {
		if (from !== to) edges.set(`${from}\0${to}`, { from, to });
	};

	for (const direction of ['outgoing', 'incoming'] as const) {
		let frontier: RawItem[] = [start];
		const visited = new Set([keyOf(start)]);
		for (let level = 0; level < options.depth && frontier.length; level++) {
			const next: RawItem[] = [];
			for (const item of frontier) {
				const calls = await ask(request, `callHierarchy/${direction}Calls`, { item });
				for (const call of calls) {
					const other = (call as { to?: unknown; from?: unknown })[direction === 'outgoing' ? 'to' : 'from'];
					if (!isRawItem(other)) continue;
					const key = keyOf(other);
					if (!items.has(key)) {
						if (items.size >= options.maxItems) {
							truncated = true;
							continue;
						}
						items.set(key, toItem(other));
					}
					if (direction === 'outgoing') addEdge(keyOf(item), key);
					else addEdge(key, keyOf(item));
					if (!visited.has(key)) {
						visited.add(key);
						next.push(other);
					}
				}
			}
			frontier = next;
		}
	}
	return { root: keyOf(start), items: [...items.values()], edges: [...edges.values()], truncated };
}
