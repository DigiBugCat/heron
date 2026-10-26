import { enclosingSymbols, FileLocation, toFileLocations, workspaceSymbols } from '../lsp/locations';
import { hoverText } from '../lsp/requests';
import { identifiersIn, keyIdentifiers, snippet } from '../model/context';
import { parseExplanation, parseRanking } from '../model/parse';
import { Candidate, explainPrompt, similarPrompt, SymbolFacts } from '../model/prompts';
import { lineStarts, positionAt } from '../utils/textPositions';
import { ActionOptions, ActionSource, ask, CALLABLE, check, lineReader, TextRange, where, within } from './actionSource';

export type { ActionOptions, ActionSource, TextRange } from './actionSource';
export { diagram } from './modelDiagram';
export type { DiagramResult } from './modelDiagram';

/**
 * The model actions: explain a selection, find similar code and draw a
 * diagram. Each gathers what Heron already knows (the outline, the language
 * server's hover, definitions, references and call hierarchy, and `git grep`),
 * caps it, asks the model, and returns plain data for the UI to show or save.
 * Everything is injected, so tests run them with a fake server and model.
 * Diagrams are in `modelDiagram.ts`.
 */

const MAX_IDENTIFIERS = 8;
const DEFINITION_LINES = 12;
const MAX_CALLERS = 12;
const MAX_KEY_IDENTIFIERS = 3;
const MAX_CANDIDATES = 30;
const MAX_HITS_PER_SOURCE = 40;
const SNIPPET_BEFORE = 2;
const SNIPPET_AFTER = 6;
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
