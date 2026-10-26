import { parseImports } from './imports';
import { languageOf, MapLanguage, maskSource } from './mask';
import { outlineSymbols } from './outline';
import { ImportResolver } from './resolve';

/** Above this many files, a folder-level map is offered instead. */
export const MAX_FILE_NODES = 150;

/** A source file to map, with its text. */
export interface SourceInput {
	/** Path relative to the repository root, '/'-separated. */
	path: string;
	text: string;
}

export interface FileNode {
	/** Path relative to the repository root. */
	path: string;
	language: MapLanguage;
	lines: number;
	/** Top-level symbols. */
	symbols: string[];
	/** Outside packages it imports, sorted. */
	external: string[];
	/** Files of the repository outside the mapped folder that it imports. */
	outside: number;
}

/** `from` imports `to`; `weight` counts the import statements behind it. */
export interface GraphEdge {
	from: string;
	to: string;
	weight: number;
}

export interface CodeGraph {
	/** Sorted by path. */
	nodes: FileNode[];
	/** Sorted by `from`, then `to`; no self-edges. */
	edges: GraphEdge[];
}

export interface GraphInput {
	/** Every file of the repository, for resolving imports (not only source files). */
	files: Iterable<string>;
	/** Text of config files by path: tsconfig.json, jsconfig.json, go.mod, Cargo.toml. */
	configs: ReadonlyMap<string, string>;
	/** The source files in the mapped folder. */
	sources: SourceInput[];
}

export function countLines(text: string): number {
	if (!text) return 0;
	let lines = 1;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
	return text.endsWith('\n') ? lines - 1 : lines;
}

function byPath<T extends { path: string }>(a: T, b: T): number {
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function edgeKey(from: string, to: string): string {
	return `${from}\0${to}`;
}

/**
 * Builds the import graph of the mapped source files: a node per file,
 * an edge per pair of files where one imports the other. Imports of files
 * outside the mapped sources are counted, not drawn.
 */
export function buildGraph(input: GraphInput): CodeGraph {
	const resolver = new ImportResolver(input.files, input.configs);
	const inScope = new Set(input.sources.map((s) => s.path));
	const nodes: FileNode[] = [];
	const weights = new Map<string, GraphEdge>();
	const done = new Set<string>();
	for (const source of [...input.sources].sort(byPath)) {
		const language = languageOf(source.path);
		if (!language || done.has(source.path)) continue;
		done.add(source.path);
		const masked = maskSource(source.text, language);
		const external = new Set<string>();
		const outside = new Set<string>();
		for (const ref of parseImports(source.text, language, masked)) {
			const resolved = resolver.resolve(source.path, ref, language);
			if (resolved.kind === 'external') external.add(resolved.name);
			if (resolved.kind !== 'files') continue;
			for (const target of resolved.paths) {
				if (target === source.path) continue;
				if (!inScope.has(target)) {
					if (languageOf(target)) outside.add(target);
					continue;
				}
				const key = edgeKey(source.path, target);
				const edge = weights.get(key);
				if (edge) edge.weight++;
				else weights.set(key, { from: source.path, to: target, weight: 1 });
			}
		}
		nodes.push({
			path: source.path,
			language,
			lines: countLines(source.text),
			symbols: outlineSymbols(masked, language),
			external: [...external].sort(),
			outside: outside.size,
		});
	}
	const edges = [...weights.values()].sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
	return { nodes, edges };
}

export interface FolderNode {
	/** Folder relative to the mapped folder; '' for files directly in it. */
	key: string;
	/** Paths of its files, relative to the repository root. */
	files: string[];
	lines: number;
	external: string[];
}

export interface FolderGraph {
	/** How many folder levels below the mapped folder the nodes go. */
	depth: number;
	nodes: FolderNode[];
	edges: GraphEdge[];
}

/** `filePath`'s folder relative to `scope`, cut to `depth` levels. */
function folderKey(filePath: string, scope: string, depth: number): string {
	const rel = scope && filePath.startsWith(`${scope}/`) ? filePath.slice(scope.length + 1) : filePath;
	const parts = rel.split('/').slice(0, -1);
	return parts.slice(0, depth).join('/');
}

/**
 * Folds a file graph into folders below `scope`, as deep as possible while
 * staying within `maxNodes` folders. Edge weights add up the file edges.
 */
export function folderGraph(graph: CodeGraph, scope: string, maxNodes = MAX_FILE_NODES): FolderGraph {
	const maxDepth = Math.max(0, ...graph.nodes.map((n) => folderKey(n.path, scope, Infinity).split('/').filter(Boolean).length));
	let depth = Math.max(1, maxDepth);
	while (depth > 1 && new Set(graph.nodes.map((n) => folderKey(n.path, scope, depth))).size > maxNodes) depth--;
	const folders = new Map<string, { files: string[]; lines: number; external: Set<string> }>();
	const keyOf = new Map<string, string>();
	for (const node of graph.nodes) {
		const key = folderKey(node.path, scope, depth);
		keyOf.set(node.path, key);
		const folder = folders.get(key) ?? { files: [], lines: 0, external: new Set<string>() };
		folder.files.push(node.path);
		folder.lines += node.lines;
		for (const e of node.external) folder.external.add(e);
		folders.set(key, folder);
	}
	const weights = new Map<string, GraphEdge>();
	for (const edge of graph.edges) {
		const from = keyOf.get(edge.from);
		const to = keyOf.get(edge.to);
		if (from === undefined || to === undefined || from === to) continue;
		const key = edgeKey(from, to);
		const existing = weights.get(key);
		if (existing) existing.weight += edge.weight;
		else weights.set(key, { from, to, weight: edge.weight });
	}
	const nodes = [...folders.entries()]
		.map(([key, f]): FolderNode => ({ key, files: f.files, lines: f.lines, external: [...f.external].sort() }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const edges = [...weights.values()].sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
	return { depth, nodes, edges };
}
