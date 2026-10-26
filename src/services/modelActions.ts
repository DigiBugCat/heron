import { enclosingSymbols, FileLocation, OutlineNode, toFileLocations, workspaceSymbols } from '../lsp/locations';
import { CallItem, callItems, callTargets, hoverText, ServerAccess } from '../lsp/requests';
import { ModelCancelled, ModelClient } from '../model/client';
import { clip, identifiersIn, importLines, keyIdentifiers, outlineText, snippet } from '../model/context';
import { parseExplanation, parseMermaid, parseRanking } from '../model/parse';
import { Candidate, diagramPrompt, explainPrompt, similarPrompt, SymbolFacts } from '../model/prompts';
import { lineStarts, positionAt, TextPosition } from '../utils/textPositions';

/**
 * The model actions: explain a selection, find similar code and draw a
 * diagram. Each gathers what Heron already knows (the outline, the language
 * server's hover, definitions, references and call hierarchy, and `git grep`),
 * caps it, asks the model, and returns plain data for the UI to show or save.
 * Everything is injected, so tests run them with a fake server and model.
 */

/** The code an action works on, and ways to learn more about it. */
export interface ActionSource {
	absPath: string;
	/** The file's current text, including unsaved edits. */
	text: string;
	/** Code fence language for the file, e.g. `ts`. */
	language: string;
	/** Short name for a file, e.g. `heron/src/main.ts`. */
	label(absPath: string): string;
	/** The file's symbols, or null without a language server. */
	outline(): Promise<OutlineNode[] | null>;
	/** The file's language server, or null. */
	server(): Promise<ServerAccess | null>;
	/** The lines of a file, or null when it cannot be read. */
	readLines(absPath: string): Promise<string[] | null>;
	/** Lines in the project containing `word` as a whole word (zero-based lines). */
	grep(word: string, limit: number, signal?: AbortSignal): Promise<{ absPath: string; line: number; text: string }[]>;
}

export interface ActionOptions {
	model: ModelClient;
	signal?: AbortSignal;
	/** Reports what the action is doing, for a status line. */
	progress?(message: string): void;
}

/** A selected range of the source's text, as offsets. */
export interface TextRange {
	from: number;
	to: number;
}

const MAX_IDENTIFIERS = 8;
const DEFINITION_LINES = 12;
const MAX_CALLERS = 12;
const MAX_KEY_IDENTIFIERS = 3;
const MAX_CANDIDATES = 30;
const MAX_HITS_PER_SOURCE = 40;
const SNIPPET_BEFORE = 2;
const SNIPPET_AFTER = 6;
const MAX_DIAGRAM_SYMBOLS = 12;
const MAX_EDGES_PER_SYMBOL = 12;
/** Longest wait for one language server request. */
const REQUEST_TIMEOUT_MS = 8_000;

const CALLABLE = new Set(['function', 'method', 'constructor']);

function check(signal?: AbortSignal) {
	if (signal?.aborted) throw new ModelCancelled();
}

/** A language server request that gives up quietly: null on error, timeout or a missing capability. */
async function ask(server: ServerAccess | null, capability: string, method: string, params: unknown): Promise<unknown> {
	if (!server || !server.supports(capability)) return null;
	let timer: number | undefined;
	try {
		return await Promise.race([
			server.request(method, params),
			new Promise((resolve) => { timer = window.setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS); }),
		]);
	} catch {
		return null;
	} finally {
		window.clearTimeout(timer);
	}
}

/** Reads files once per action: no cache outlives it, so nothing goes stale. */
function lineReader(source: ActionSource): (absPath: string) => Promise<string[] | null> {
	const read = new Map<string, Promise<string[] | null>>();
	const own = source.text.split('\n');
	return (absPath) => {
		if (absPath === source.absPath) return Promise.resolve(own);
		let lines = read.get(absPath);
		if (!lines) read.set(absPath, (lines = source.readLines(absPath)));
		return lines;
	};
}

function within(loc: FileLocation, absPath: string, from: TextPosition, to: TextPosition): boolean {
	return loc.absPath === absPath && loc.position.line >= from.line && loc.position.line <= to.line;
}

const where = (source: ActionSource, loc: FileLocation) => `${source.label(loc.absPath)}:${loc.position.line + 1}`;

// ---- Explain selection ----

/** Explains the code in `range`; returns markdown for a note. */
export async function explainSelection(source: ActionSource, range: TextRange, opts: ActionOptions): Promise<string> {
	const { signal } = opts;
	const starts = lineStarts(source.text);
	const start = positionAt(starts, range.from);
	const end = positionAt(starts, range.to);
	const selection = source.text.slice(range.from, range.to);
	const read = lineReader(source);
	const textDocument = { uri: '' };

	opts.progress?.('Reading the outline…');
	const outline = await source.outline();
	check(signal);
	const chain = outline ? enclosingSymbols(outline, start) : [];
	const server = await source.server();
	check(signal);
	if (server) textDocument.uri = server.uri;

	opts.progress?.('Asking the language server…');
	const ids = identifiersIn(selection).slice(0, MAX_IDENTIFIERS);
	const symbols = (await Promise.all(ids.map(async (id): Promise<SymbolFacts | null> => {
		const position = positionAt(starts, range.from + id.index);
		const [hover, def] = await Promise.all([
			ask(server, 'hoverProvider', 'textDocument/hover', { textDocument, position }),
			ask(server, 'definitionProvider', 'textDocument/definition', { textDocument, position }),
		]);
		const target = toFileLocations(def)[0];
		let definition = '';
		let definitionCode = '';
		if (target && !within(target, source.absPath, start, end)) {
			definition = where(source, target);
			const lines = await read(target.absPath);
			if (lines) definitionCode = snippet(lines, target.position.line, target.position.line + DEFINITION_LINES - 1);
		}
		const text = hoverText(hover);
		return text || definition ? { name: id.name, hover: text, definition, definitionCode } : null;
	}))).filter((s): s is SymbolFacts => !!s);
	check(signal);

	const callee = [...chain].reverse().find((n) => CALLABLE.has(n.kind));
	let callers: { location: string; code: string }[] = [];
	if (callee) {
		const refs = toFileLocations(await ask(server, 'referencesProvider', 'textDocument/references', {
			textDocument, position: callee.position, context: { includeDeclaration: false },
		})).filter((loc) => !within(loc, source.absPath, callee.start, callee.end)).slice(0, MAX_CALLERS);
		callers = await Promise.all(refs.map(async (loc) => ({
			location: where(source, loc),
			code: (await read(loc.absPath))?.[loc.position.line] ?? '',
		})));
	}
	check(signal);

	opts.progress?.('Waiting for the model…');
	const request = explainPrompt({
		file: source.label(source.absPath),
		language: source.language,
		selection,
		lines: { from: start.line + 1, to: end.line + 1 },
		enclosing: chain.map((n) => `${n.kind} ${n.name}`),
		symbols,
		calleeName: callee?.name ?? '',
		callers,
	});
	return parseExplanation(await opts.model.complete(request, signal));
}

// ---- Find similar ----

/** Code the model judged to be the same pattern, with its reason. */
export interface SimilarResult extends FileLocation {
	/** `file:line`. */
	title: string;
	reason: string;
}

interface Hit extends FileLocation {
	/** Identifiers or searches that led here; more means a likelier match. */
	votes: number;
}

/** Finds code like the code in `range`, ranked by the model. */
export async function findSimilar(source: ActionSource, range: TextRange, opts: ActionOptions): Promise<SimilarResult[]> {
	const { signal } = opts;
	const starts = lineStarts(source.text);
	const start = positionAt(starts, range.from);
	const end = positionAt(starts, range.to);
	const selection = source.text.slice(range.from, range.to);
	const read = lineReader(source);
	const keys = keyIdentifiers(selection, MAX_KEY_IDENTIFIERS);
	if (!keys.length) return [];

	const hits = new Map<string, Hit>();
	const add = (loc: FileLocation) => {
		if (within(loc, source.absPath, start, end)) return;
		const key = `${loc.absPath}:${loc.position.line}`;
		const hit = hits.get(key);
		if (hit) hit.votes++;
		else hits.set(key, { ...loc, votes: 1 });
	};

	opts.progress?.('Looking for candidates…');
	const server = await source.server();
	check(signal);
	const textDocument = { uri: server?.uri ?? '' };
	const outline = await source.outline();
	const enclosing = outline ? enclosingSymbols(outline, start).pop() : undefined;
	await Promise.all(keys.map(async (key) => {
		const position = positionAt(starts, range.from + key.index);
		const refs = toFileLocations(await ask(server, 'referencesProvider', 'textDocument/references', {
			textDocument, position, context: { includeDeclaration: false },
		}));
		refs.slice(0, MAX_HITS_PER_SOURCE).forEach(add);
		for (const hit of await source.grep(key.name, MAX_HITS_PER_SOURCE, signal).catch(() => [])) {
			add({ absPath: hit.absPath, position: { line: hit.line, character: 0 } });
		}
	}));
	check(signal);
	// Symbols named like the enclosing function or the key identifiers, e.g. `loadUser` for `loadConfig`.
	for (const query of [enclosing?.name, ...keys.map((k) => k.name)].filter((q): q is string => !!q).slice(0, 3)) {
		workspaceSymbols(await ask(server, 'workspaceSymbolProvider', 'workspace/symbol', { query }), MAX_HITS_PER_SOURCE).forEach(add);
	}
	check(signal);

	// Most-voted first; drop hits a few lines from a better one, which would show the same code.
	const ranked = [...hits.values()].sort((a, b) => b.votes - a.votes);
	const chosen: Hit[] = [];
	for (const hit of ranked) {
		if (chosen.length >= MAX_CANDIDATES) break;
		const near = chosen.some((c) => c.absPath === hit.absPath && Math.abs(c.position.line - hit.position.line) <= SNIPPET_AFTER);
		if (!near) chosen.push(hit);
	}
	if (!chosen.length) return [];

	const candidates: (Candidate & { loc: FileLocation })[] = [];
	for (const hit of chosen) {
		const lines = await read(hit.absPath);
		if (!lines) continue;
		const line = hit.position.line;
		candidates.push({
			id: candidates.length + 1,
			location: where(source, hit),
			code: snippet(lines, line - SNIPPET_BEFORE, line + SNIPPET_AFTER),
			loc: { absPath: hit.absPath, position: { line, character: 0 } },
		});
	}
	check(signal);

	opts.progress?.(`Ranking ${candidates.length} candidates…`);
	const request = similarPrompt({ file: source.label(source.absPath), language: source.language, code: selection }, candidates);
	const ranking = parseRanking(await opts.model.complete(request, signal), new Set(candidates.map((c) => c.id)));
	const byId = new Map(candidates.map((c) => [c.id, c]));
	return ranking.flatMap((r) => {
		const c = byId.get(r.id);
		return c ? [{ ...c.loc, title: c.location, reason: r.reason }] : [];
	});
}

// ---- Diagram ----

export interface DiagramResult {
	mermaid: string;
	/** What was drawn, e.g. `heron/src/main.ts` or `start in heron/src/server.ts`. */
	subject: string;
	/** The symbol drawn, or '' for the whole file. */
	symbol: string;
	/** Files the diagram draws on, this one first. */
	files: string[];
}

/** Top-level symbols and the members of top-level types, in order. */
function diagramSymbols(nodes: OutlineNode[]): OutlineNode[] {
	const result: OutlineNode[] = [];
	for (const node of nodes) {
		result.push(node);
		if (!CALLABLE.has(node.kind)) result.push(...node.children.filter((c) => CALLABLE.has(c.kind)));
	}
	return result.slice(0, MAX_DIAGRAM_SYMBOLS);
}

/**
 * Draws the file, or with `range` the symbol around it, from its outline,
 * imports, call hierarchy (or references when the server has none).
 */
export async function diagram(source: ActionSource, range: TextRange | null, opts: ActionOptions): Promise<DiagramResult> {
	const { signal } = opts;
	const starts = lineStarts(source.text);
	const fileLabel = source.label(source.absPath);
	const files = new Set<string>([source.absPath]);
	opts.progress?.('Reading the outline…');
	const outline = (await source.outline()) ?? [];
	const server = await source.server();
	check(signal);
	const textDocument = { uri: server?.uri ?? '' };

	let focus: OutlineNode | null = null;
	let symbolName = '';
	let position: TextPosition | null = null;
	if (range) {
		const at = positionAt(starts, range.from);
		focus = enclosingSymbols(outline, at).pop() ?? null;
		const word = identifiersIn(source.text.slice(range.from, range.to))[0];
		symbolName = focus?.name ?? word?.name ?? '';
		position = focus?.position ?? (word ? positionAt(starts, range.from + word.index) : at);
	}
	const targets: { name: string; position: TextPosition; start?: TextPosition; end?: TextPosition }[] = range
		? [{ name: symbolName, position: position ?? { line: 0, character: 0 }, start: focus?.start, end: focus?.end }]
		: diagramSymbols(outline).map((n) => ({ name: n.name, position: n.position, start: n.start, end: n.end }));

	opts.progress?.('Asking the language server…');
	const label = (item: CallItem) => {
		if (item.absPath !== source.absPath) files.add(item.absPath);
		return item.absPath === source.absPath ? item.name : `${item.name} (${source.label(item.absPath)})`;
	};
	const calls: { from: string; to: string }[] = [];
	const usedBy: { symbol: string; places: string[] }[] = [];
	for (const target of targets) {
		check(signal);
		const items = callItems(await ask(server, 'callHierarchyProvider', 'textDocument/prepareCallHierarchy', { textDocument, position: target.position }));
		const item = items[0];
		if (item) {
			const [outgoing, incoming] = await Promise.all([
				ask(server, 'callHierarchyProvider', 'callHierarchy/outgoingCalls', { item: item.raw }),
				ask(server, 'callHierarchyProvider', 'callHierarchy/incomingCalls', { item: item.raw }),
			]);
			for (const callee of callTargets(outgoing, 'to').slice(0, MAX_EDGES_PER_SYMBOL)) calls.push({ from: target.name, to: label(callee) });
			for (const caller of callTargets(incoming, 'from').slice(0, MAX_EDGES_PER_SYMBOL)) {
				if (range || caller.absPath !== source.absPath) calls.push({ from: label(caller), to: target.name });
			}
			continue;
		}
		// No call hierarchy: say where the symbol is used instead.
		const refs = toFileLocations(await ask(server, 'referencesProvider', 'textDocument/references', {
			textDocument, position: target.position, context: { includeDeclaration: false },
		}));
		const places = [...new Set(refs
			.filter((loc) => range ? !(target.start && target.end && within(loc, source.absPath, target.start, target.end)) : loc.absPath !== source.absPath)
			.map((loc) => {
				if (loc.absPath !== source.absPath) files.add(loc.absPath);
				return loc.absPath === source.absPath ? `line ${loc.position.line + 1}` : source.label(loc.absPath);
			}))].slice(0, MAX_EDGES_PER_SYMBOL);
		if (places.length) usedBy.push({ symbol: target.name, places });
	}
	check(signal);

	const code = range
		? focus ? snippetOf(source.text, starts, focus.start, focus.end) : source.text.slice(range.from, range.to)
		: '';
	const subject = range && symbolName ? `${symbolName} in ${fileLabel}` : fileLabel;
	opts.progress?.('Waiting for the model…');
	const request = diagramPrompt({
		subject,
		language: source.language,
		outline: outlineText(range && focus ? [focus] : outline, 200),
		imports: range ? [] : importLines(source.text, 40),
		calls,
		usedBy,
		code: clip(code, 8_000),
	});
	const mermaid = parseMermaid(await opts.model.complete(request, signal));
	return { mermaid, subject, symbol: range ? symbolName : '', files: [...files] };
}

function snippetOf(text: string, starts: number[], from: TextPosition, to: TextPosition): string {
	const a = starts[from.line] ?? 0;
	const b = to.line + 1 < starts.length ? (starts[to.line + 1] ?? text.length) : text.length;
	return text.slice(a, b);
}
