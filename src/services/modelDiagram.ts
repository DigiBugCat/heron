import { enclosingSymbols, OutlineNode, toFileLocations } from '../lsp/locations';
import { CallItem, callItems, callTargets } from '../lsp/requests';
import { clip, identifiersIn, importLines, outlineText } from '../model/context';
import { parseMermaid } from '../model/parse';
import { diagramPrompt } from '../model/prompts';
import { lineStarts, positionAt, TextPosition } from '../utils/textPositions';
import { ActionOptions, ActionSource, ask, CALLABLE, check, TextRange, within } from './actionSource';

/** Draws code as a Mermaid diagram from its outline, imports and call hierarchy. */

const MAX_DIAGRAM_SYMBOLS = 12;
const MAX_EDGES_PER_SYMBOL = 12;

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
