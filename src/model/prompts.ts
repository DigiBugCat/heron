import type { ModelRequest } from './client';
import { clip } from './context';

/**
 * Prompts for the model actions. Pure: everything the model sees is built
 * here from plain data, with sizes capped so a prompt stays small.
 */

/** Most characters of context in one prompt, besides the selected code. */
export const PROMPT_BUDGET = 24_000;
export const MAX_SELECTION_CHARS = 8_000;
const MAX_HOVER_CHARS = 800;
const MAX_DEFINITION_CHARS = 1_200;

function fence(code: string, language: string): string {
	const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((r) => r.length));
	const f = '`'.repeat(longest + 1);
	return `${f}${language}\n${code}\n${f}`;
}

/** Adds blocks in order while they fit in `budget` characters. */
function fill(blocks: string[], budget: number): string[] {
	const kept: string[] = [];
	let used = 0;
	for (const block of blocks) {
		if (used + block.length > budget) break;
		kept.push(block);
		used += block.length;
	}
	return kept;
}

// ---- Explain selection ----

export interface SymbolFacts {
	name: string;
	/** Hover text from the language server. */
	hover: string;
	/** `file:line` of the definition, or ''. */
	definition: string;
	/** A few lines at the definition, or ''. */
	definitionCode: string;
}

export interface ExplainContext {
	/** Short path of the file, e.g. `heron/src/main.ts`. */
	file: string;
	/** Code fence language, e.g. `ts`. */
	language: string;
	selection: string;
	/** 1-based lines of the selection. */
	lines: { from: number; to: number };
	/** Enclosing symbols, outermost first, e.g. `class Server`, `method start`. */
	enclosing: string[];
	symbols: SymbolFacts[];
	/** The innermost enclosing function, whose callers are listed. */
	calleeName: string;
	callers: { location: string; code: string }[];
}

export const EXPLAIN_SYSTEM = [
	'You explain code to a developer who is reviewing code that an AI agent wrote.',
	'Be concise and concrete: say what the selected code does, why it is likely there, and anything surprising, risky or worth checking.',
	'Start with a one-sentence summary, then at most five short bullet points. Use markdown, refer to identifiers in backticks, and do not repeat the code.',
	'Use only what the context supports; say so when something cannot be known from it.',
].join(' ');

export function explainPrompt(ctx: ExplainContext): ModelRequest {
	const head = [
		`File: ${ctx.file} (lines ${ctx.lines.from}–${ctx.lines.to})`,
		...(ctx.enclosing.length ? [`Inside: ${ctx.enclosing.join(' › ')}`] : []),
		'',
		'Selected code:',
		fence(clip(ctx.selection, MAX_SELECTION_CHARS), ctx.language),
	].join('\n');
	const symbolBlocks = ctx.symbols.map((s) => {
		const parts = [`- \`${s.name}\`${s.definition ? `, defined at ${s.definition}` : ''}`];
		if (s.hover) parts.push(`  Hover: ${clip(s.hover, MAX_HOVER_CHARS).replace(/\n/g, '\n  ')}`);
		if (s.definitionCode) parts.push(`  Definition:\n${fence(clip(s.definitionCode, MAX_DEFINITION_CHARS), ctx.language).replace(/^/gm, '  ')}`);
		return parts.join('\n');
	});
	const callerBlocks = ctx.callers.map((c) => `- ${c.location}: \`${clip(c.code.trim(), 200)}\``);
	const symbols = fill(symbolBlocks, PROMPT_BUDGET * 0.7);
	const callers = fill(callerBlocks, PROMPT_BUDGET - symbols.join('').length);
	const sections = [head];
	if (symbols.length) sections.push(`Symbols used in the selection, from the language server:\n${symbols.join('\n')}`);
	if (callers.length) sections.push(`Callers of \`${ctx.calleeName}\`:\n${callers.join('\n')}`);
	sections.push('Explain the selected code.');
	return { system: EXPLAIN_SYSTEM, prompt: sections.join('\n\n'), maxTokens: 700 };
}

// ---- Find similar ----

export interface Candidate {
	/** Number the model refers to the candidate by. */
	id: number;
	/** `file:line`. */
	location: string;
	code: string;
}

export const SIMILAR_SYSTEM = [
	'You compare code for a developer reviewing a codebase.',
	'Given a pattern and numbered candidate snippets, decide which candidates are instances of the same pattern:',
	'the same idea or structure, possibly with different names, not merely code that mentions the same identifier.',
	'Reply with JSON only: an array of {"id": number, "reason": string} for the matching candidates, best match first.',
	'Each reason is one short sentence on what makes it the same pattern or how it differs. Reply [] if none match.',
].join(' ');

export function similarPrompt(pattern: { file: string; language: string; code: string }, candidates: Candidate[]): ModelRequest {
	const blocks = candidates.map((c) => `[${c.id}] ${c.location}\n${fence(clip(c.code, 1_200), pattern.language)}`);
	const kept = fill(blocks, PROMPT_BUDGET);
	return {
		system: SIMILAR_SYSTEM,
		prompt: [
			`Pattern, from ${pattern.file}:`,
			fence(clip(pattern.code, MAX_SELECTION_CHARS), pattern.language),
			'Candidates:',
			kept.join('\n\n'),
			'Which candidates are the same pattern?',
		].join('\n\n'),
		maxTokens: 1_200,
	};
}

// ---- Diagram ----

export interface DiagramContext {
	/** What is drawn, e.g. `heron/src/main.ts` or `start in heron/src/server.ts`. */
	subject: string;
	language: string;
	outline: string;
	imports: string[];
	/** Call edges `caller → callee`, from the language server. */
	calls: { from: string; to: string }[];
	/** Where the file's (or symbol's) symbols are used, by symbol. */
	usedBy: { symbol: string; places: string[] }[];
	/** The symbol's code, for a symbol diagram. */
	code: string;
}

export const DIAGRAM_SYSTEM = [
	'You draw the structure of code as a Mermaid diagram for a developer reviewing it.',
	'Use only the facts given. Reply with a single ```mermaid code block and nothing else.',
	'Prefer `flowchart LR` for calls and dependencies, or `classDiagram` for types and their members.',
	'Keep it readable: at most 25 nodes, short labels in double quotes, subgraphs per file when that helps.',
].join(' ');

export function diagramPrompt(ctx: DiagramContext): ModelRequest {
	const blocks: string[] = [];
	if (ctx.code) blocks.push(`Code:\n${fence(clip(ctx.code, MAX_SELECTION_CHARS), ctx.language)}`);
	if (ctx.outline) blocks.push(`Outline (symbols from the language server):\n${clip(ctx.outline, 6_000)}`);
	if (ctx.imports.length) blocks.push(`Imports:\n${ctx.imports.map((i) => `- ${i}`).join('\n')}`);
	if (ctx.calls.length) blocks.push(`Calls:\n${ctx.calls.map((c) => `- ${c.from} → ${c.to}`).join('\n')}`);
	if (ctx.usedBy.length) {
		blocks.push(`Used from:\n${ctx.usedBy.map((u) => `- ${u.symbol}: ${u.places.join(', ')}`).join('\n')}`);
	}
	return {
		system: DIAGRAM_SYSTEM,
		prompt: [`Draw a diagram of ${ctx.subject}.`, ...fill(blocks, PROMPT_BUDGET)].join('\n\n'),
		maxTokens: 2_000,
	};
}
