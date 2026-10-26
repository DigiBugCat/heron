import { ModelError } from './client';

/** Reading model replies. Pure and tolerant of the usual decorations around an answer. */

const MAX_EXPLANATION_CHARS = 6_000;
const MAX_REASON_CHARS = 240;

/** The body of the only fenced block in `text` when the whole reply is one, else the text. */
function unwrapFence(text: string, languages: RegExp): string {
	const m = /^\s*(`{3,}|~{3,})[ \t]*([\w-]*)[ \t]*\n([\s\S]*?)\n\s*\1\s*$/.exec(text);
	return m && languages.test(m[2] ?? '') ? m[3] ?? '' : text;
}

/** An explanation to save as a note. */
export function parseExplanation(text: string): string {
	const body = unwrapFence(text, /^(markdown|md|)$/i).trim();
	if (!body) throw new ModelError('The model returned an empty explanation');
	return body.length > MAX_EXPLANATION_CHARS ? `${body.slice(0, MAX_EXPLANATION_CHARS)}…` : body;
}

export interface Ranked {
	id: number;
	reason: string;
}

/**
 * The candidates the model picked, best first: a JSON array of
 * `{id, reason}`, possibly in a code block or surrounded by prose. Unknown
 * and repeated ids are dropped.
 */
export function parseRanking(text: string, validIds: Set<number>): Ranked[] {
	const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(text)?.[1];
	const source = fenced ?? text;
	const start = source.indexOf('[');
	const end = source.lastIndexOf(']');
	let value: unknown;
	try {
		value = start >= 0 && end > start ? JSON.parse(source.slice(start, end + 1)) : null;
	} catch {
		value = null;
	}
	if (!Array.isArray(value)) throw new ModelError('Could not read the model\'s answer');
	const seen = new Set<number>();
	const result: Ranked[] = [];
	for (const item of value) {
		const raw: Record<string, unknown> = item && typeof item === 'object' ? (item as Record<string, unknown>) : { id: item as unknown };
		const id = typeof raw.id === 'number' ? raw.id : typeof raw.id === 'string' ? Number.parseInt(raw.id, 10) : NaN;
		if (!validIds.has(id) || seen.has(id)) continue;
		seen.add(id);
		const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
		result.push({ id, reason: reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason });
	}
	return result;
}

const DIAGRAM_START = /^(flowchart|graph|classDiagram|sequenceDiagram|stateDiagram(-v2)?|erDiagram|mindmap|C4\w*|block-beta|architecture-beta)\b/;

/** The Mermaid source in a reply: a ```mermaid block, another block, or the bare text. */
export function parseMermaid(text: string): string {
	const blocks = [...text.matchAll(/(`{3,}|~{3,})[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)\n\s*\1/g)];
	const chosen = blocks.find((b) => (b[2] ?? '').toLowerCase() === 'mermaid') ?? blocks[0];
	const source = (chosen ? chosen[3] ?? '' : text).trim();
	const first = source.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('%%')) ?? '';
	if (!DIAGRAM_START.test(first)) throw new ModelError('The model did not return a Mermaid diagram');
	// A fence inside would end the block the diagram is saved in.
	return source.replace(/^\s*(`{3,}|~{3,}).*$/gm, '').trim();
}
