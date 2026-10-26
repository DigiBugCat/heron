import { lineAt, lineStarts } from '../utils/textPositions';

/**
 * Text-quote anchoring for margin notes, after the approach of the Lectern
 * plugin (MIT) and the W3C `TextQuoteSelector`: a note remembers the code it
 * quotes and a little text on either side, not line numbers, so it can be
 * found again after the file is edited, reformatted or rewritten by an agent.
 *
 * Resolution tries, in order:
 * 1. the exact quote, choosing between duplicates by context and line hint;
 * 2. the quote ignoring whitespace (re-indented or reformatted code);
 * 3. most of the quote's lines in a nearby window (a block that was edited
 *    inside, or moved and edited).
 * When none of these finds it, the note is orphaned.
 */

/** Characters of context kept on each side of a quote. */
export const CONTEXT_CHARS = 48;
/** Occurrences of a quote considered before giving up on choosing between them. */
const MAX_CANDIDATES = 500;
/** Quotes longer than this many significant lines are not matched approximately. */
const MAX_FUZZY_LINES = 80;
/** Share of a quote's significant lines that must still be there for an approximate match. */
const FUZZY_THRESHOLD = 0.6;

export interface TextAnchor {
	/** The quoted text, exactly as it was selected. */
	quote: string;
	/** Text just before the quote. */
	prefix: string;
	/** Text just after the quote. */
	suffix: string;
	/** Zero-based line the quote started on when last seen; breaks ties. */
	line?: number;
}

export type AnchorQuality = 'exact' | 'normalized' | 'fuzzy';

export interface AnchorMatch {
	from: number;
	to: number;
	quality: AnchorQuality;
}

/** Makes an anchor for `text.slice(from, to)`. */
export function makeAnchor(text: string, from: number, to: number): TextAnchor {
	return {
		quote: text.slice(from, to),
		prefix: text.slice(Math.max(0, from - CONTEXT_CHARS), from),
		suffix: text.slice(to, to + CONTEXT_CHARS),
		line: lineAt(lineStarts(text), from),
	};
}

/**
 * A document prepared once for resolving many anchors: its line starts and
 * a copy without whitespace, mapped back to the original offsets.
 */
export class AnchorText {
	readonly starts: number[];
	private squeezedText: string | null = null;
	private squeezedMap: number[] = [];
	private lines: { text: string; from: number; to: number }[] | null = null;

	constructor(readonly text: string) {
		this.starts = lineStarts(text);
	}

	/** The text without whitespace, and the original offset of each character. */
	squeezed(): { text: string; map: number[] } {
		if (this.squeezedText === null) {
			const chars: string[] = [];
			const map: number[] = [];
			for (let i = 0; i < this.text.length; i++) {
				const ch = this.text[i] ?? '';
				if (/\s/.test(ch)) continue;
				chars.push(ch);
				map.push(i);
			}
			this.squeezedText = chars.join('');
			this.squeezedMap = map;
		}
		return { text: this.squeezedText, map: this.squeezedMap };
	}

	/** Significant lines (see `isSignificant`), trimmed, with their extent. */
	significantLines(): { text: string; from: number; to: number }[] {
		if (!this.lines) {
			this.lines = [];
			for (let n = 0; n < this.starts.length; n++) {
				const from = this.starts[n] ?? 0;
				const next = this.starts[n + 1];
				const to = next === undefined ? this.text.length : next - 1;
				const trimmed = this.text.slice(from, to).trim();
				if (isSignificant(trimmed)) this.lines.push({ text: trimmed, from, to });
			}
		}
		return this.lines;
	}
}

/** Lines that say something on their own; `}` or `);` would match anywhere. */
function isSignificant(trimmed: string): boolean {
	return trimmed.replace(/[^\p{L}\p{N}_]/gu, '').length >= 2;
}

function squeeze(text: string): string {
	return text.replace(/\s+/g, '');
}

/** Length of the common ending of `a` and `b`. */
function commonSuffix(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
	return n;
}

/** Length of the common beginning of `a` and `b`. */
function commonPrefix(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return n;
}

/** How well the text around `from`–`to` matches the anchor's context, ignoring whitespace. */
function contextScore(doc: AnchorText, anchor: TextAnchor, from: number, to: number): number {
	const window = CONTEXT_CHARS * 3;
	const before = squeeze(doc.text.slice(Math.max(0, from - window), from));
	const after = squeeze(doc.text.slice(to, to + window));
	return commonSuffix(before, squeeze(anchor.prefix)) + commonPrefix(after, squeeze(anchor.suffix));
}

/** Picks the candidate with the best context, then the one nearest the line hint, then the first. */
function best(doc: AnchorText, anchor: TextAnchor, candidates: { from: number; to: number }[]): { from: number; to: number } | null {
	let chosen: { from: number; to: number } | null = null;
	let chosenScore = -1;
	let chosenDistance = Infinity;
	for (const c of candidates) {
		const score = candidates.length > 1 ? contextScore(doc, anchor, c.from, c.to) : 0;
		const distance = anchor.line === undefined ? 0 : Math.abs(lineAt(doc.starts, c.from) - anchor.line);
		if (score > chosenScore || (score === chosenScore && distance < chosenDistance)) {
			chosen = c;
			chosenScore = score;
			chosenDistance = distance;
		}
	}
	return chosen;
}

function exactCandidates(doc: AnchorText, quote: string): { from: number; to: number }[] {
	const found: { from: number; to: number }[] = [];
	for (let i = doc.text.indexOf(quote); i >= 0 && found.length < MAX_CANDIDATES; i = doc.text.indexOf(quote, i + 1)) {
		found.push({ from: i, to: i + quote.length });
	}
	return found;
}

function normalizedCandidates(doc: AnchorText, quote: string): { from: number; to: number }[] {
	const q = squeeze(quote);
	if (!q) return [];
	const { text, map } = doc.squeezed();
	const found: { from: number; to: number }[] = [];
	for (let i = text.indexOf(q); i >= 0 && found.length < MAX_CANDIDATES; i = text.indexOf(q, i + 1)) {
		found.push({ from: map[i] ?? 0, to: (map[i + q.length - 1] ?? 0) + 1 });
	}
	return found;
}

/** Length of the longest common subsequence of two short lists of lines. */
function lcs(a: string[], b: string[]): number {
	let prev = new Array<number>(b.length + 1).fill(0);
	for (const x of a) {
		const row = new Array<number>(b.length + 1).fill(0);
		for (let j = 0; j < b.length; j++) row[j + 1] = x === b[j] ? (prev[j] ?? 0) + 1 : Math.max(prev[j + 1] ?? 0, row[j] ?? 0);
		prev = row;
	}
	return prev[b.length] ?? 0;
}

/**
 * Windows of the document that keep most of the quote's significant lines in
 * order. Each document line equal to a quote line votes for where the quote
 * would start; the best-voted windows are checked line by line.
 */
function fuzzyCandidates(doc: AnchorText, quote: string): { from: number; to: number; score: number }[] {
	const quoteLines = quote.split('\n').map((l) => l.trim()).filter(isSignificant);
	const n = quoteLines.length;
	if (n < 2 || n > MAX_FUZZY_LINES) return [];
	const needed = Math.max(2, Math.ceil(n * FUZZY_THRESHOLD));
	const lines = doc.significantLines();
	const where = new Map<string, number[]>();
	quoteLines.forEach((l, k) => {
		const list = where.get(l) ?? [];
		list.push(k);
		where.set(l, list);
	});
	const votes = new Map<number, number>();
	lines.forEach((line, d) => {
		for (const k of where.get(line.text) ?? []) votes.set(d - k, (votes.get(d - k) ?? 0) + 1);
	});
	const slack = Math.ceil(n / 2);
	const found: { from: number; to: number; score: number }[] = [];
	const starts = [...votes].filter(([, v]) => v >= Math.min(needed, 2)).sort((a, b) => b[1] - a[1]).slice(0, 50);
	for (const [start] of starts) {
		const lo = Math.max(0, start - slack);
		const window = lines.slice(lo, start + n + slack);
		const score = lcs(quoteLines, window.map((l) => l.text));
		if (score < needed) continue;
		// Trim the window to the lines that matched a quote line.
		const quoteSet = new Set(quoteLines);
		const matched = window.filter((l) => quoteSet.has(l.text));
		const first = matched[0];
		const last = matched[matched.length - 1];
		if (!first || !last) continue;
		const firstQuote = quoteLines[0] ?? '';
		const lastQuote = quoteLines[n - 1] ?? '';
		// Keep the original first and last line when they survived, so the range covers the whole block.
		const from = window.find((l) => l.text === firstQuote)?.from ?? first.from;
		const lastMatch = [...window].reverse().find((l) => l.text === lastQuote);
		const to = lastMatch && lastMatch.to >= from ? lastMatch.to : last.to;
		const indent = doc.text.slice(from).search(/\S/);
		found.push({ from: from + Math.max(0, indent), to, score });
	}
	return found;
}

/** Finds `anchor` in `doc`, or returns null when the quote is gone (an orphaned note). */
export function resolveAnchor(doc: AnchorText | string, anchor: TextAnchor): AnchorMatch | null {
	const text = typeof doc === 'string' ? new AnchorText(doc) : doc;
	if (!anchor.quote.trim()) return null;
	const exact = best(text, anchor, exactCandidates(text, anchor.quote));
	if (exact) return { ...exact, quality: 'exact' };
	const normalized = best(text, anchor, normalizedCandidates(text, anchor.quote));
	if (normalized) return { ...normalized, quality: 'normalized' };
	const fuzzy = fuzzyCandidates(text, anchor.quote);
	const top = Math.max(0, ...fuzzy.map((c) => c.score));
	const chosen = best(text, anchor, fuzzy.filter((c) => c.score === top));
	return chosen ? { from: chosen.from, to: chosen.to, quality: 'fuzzy' } : null;
}
