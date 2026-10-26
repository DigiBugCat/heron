/** Languages whose imports the code map understands. */
export type MapLanguage = 'ts' | 'python' | 'go' | 'rust';

const LANGUAGE_BY_EXTENSION: Record<string, MapLanguage> = {
	ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts',
	py: 'python', pyi: 'python',
	go: 'go',
	rs: 'rust',
};

/** The map language of a file, by extension, or null when imports are not parsed for it. */
export function languageOf(filePath: string): MapLanguage | null {
	const name = filePath.slice(filePath.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	if (dot <= 0) return null;
	return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

const IDENT = /[\w$]/;
/** After these, a `/` starts a regular expression rather than a division. */
const REGEX_AFTER_CHARS = new Set('(,=:[!&|?{};+-*%<>~^');
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

/** Mutable copy of a source text whose characters can be blanked, keeping offsets and newlines. */
class Masker {
	private out: string[];

	constructor(private text: string) {
		this.out = text.split('');
	}

	/** Replaces `[from, to)` with spaces, keeping line breaks. */
	blank(from: number, to: number) {
		for (let k = Math.max(0, from); k < Math.min(to, this.text.length); k++) {
			const c = this.text.charAt(k);
			if (c !== '\n' && c !== '\r') this.out[k] = ' ';
		}
	}

	result(): string {
		return this.out.join('');
	}
}

/**
 * End of a quoted string starting at `start` (the opening quote): the index
 * just past the closing quote, or of the line break for an unterminated one.
 */
function endOfQuoted(text: string, start: number, quote: string, multiline = false): number {
	let j = start + 1;
	while (j < text.length) {
		const c = text.charAt(j);
		if (c === '\\') j += 2;
		else if (c === quote) return j + 1;
		else if (c === '\n' && !multiline) return j;
		else j++;
	}
	return text.length;
}

function lineEnd(text: string, from: number): number {
	const j = text.indexOf('\n', from);
	return j < 0 ? text.length : j;
}

/** Blanks a string's contents, keeping its quotes so its position can still be found. */
function blankString(m: Masker, start: number, end: number, openLength: number, closeLength: number, terminated: boolean) {
	m.blank(start + openLength, terminated ? end - closeLength : end);
}

function maskJs(text: string): string {
	const m = new Masker(text);
	// Open template literals and the `${…}` expressions inside them.
	const modes: ({ tpl: true } | { tpl: false; depth: number })[] = [];
	let lastSig = '';
	let lastWord = '';
	let i = 0;
	while (i < text.length) {
		const top = modes[modes.length - 1];
		const c = text.charAt(i);
		const next = text.charAt(i + 1);
		if (top?.tpl) {
			if (c === '\\') { m.blank(i, i + 2); i += 2; continue; }
			if (c === '`') { modes.pop(); lastSig = '`'; i++; continue; }
			if (c === '$' && next === '{') { modes.push({ tpl: false, depth: 0 }); lastSig = '{'; i += 2; continue; }
			m.blank(i, i + 1);
			i++;
			continue;
		}
		if (c === '/' && next === '/') {
			const j = lineEnd(text, i);
			m.blank(i, j);
			i = j;
			continue;
		}
		if (c === '/' && next === '*') {
			const close = text.indexOf('*/', i + 2);
			const j = close < 0 ? text.length : close + 2;
			m.blank(i, j);
			i = j;
			continue;
		}
		if (c === '/' && (lastSig === '' || REGEX_AFTER_CHARS.has(lastSig) || (lastSig === 'w' && REGEX_AFTER_WORDS.has(lastWord)))) {
			let j = i + 1;
			let inClass = false;
			let closed = false;
			while (j < text.length && text.charAt(j) !== '\n') {
				const r = text.charAt(j);
				if (r === '\\') { j += 2; continue; }
				if (r === '[') inClass = true;
				else if (r === ']') inClass = false;
				else if (r === '/' && !inClass) { closed = true; break; }
				j++;
			}
			if (closed) {
				m.blank(i + 1, j);
				j++;
				while (j < text.length && /[a-z]/i.test(text.charAt(j))) j++;
				lastSig = ')';
				i = j;
				continue;
			}
		}
		if (c === '"' || c === '\'') {
			const j = endOfQuoted(text, i, c);
			blankString(m, i, j, 1, 1, text.charAt(j - 1) === c && j - 1 > i);
			lastSig = c;
			i = j;
			continue;
		}
		if (c === '`') {
			modes.push({ tpl: true });
			i++;
			continue;
		}
		if (c === '{' && top && !top.tpl) top.depth++;
		if (c === '}' && top && !top.tpl) {
			if (top.depth === 0) {
				modes.pop();
				i++;
				continue;
			}
			top.depth--;
		}
		if (IDENT.test(c)) {
			let j = i + 1;
			while (j < text.length && IDENT.test(text.charAt(j))) j++;
			lastWord = text.slice(i, j);
			lastSig = 'w';
			i = j;
			continue;
		}
		if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') lastSig = c;
		i++;
	}
	return m.result();
}

function maskPython(text: string): string {
	const m = new Masker(text);
	let i = 0;
	while (i < text.length) {
		const c = text.charAt(i);
		if (c === '#') {
			const j = lineEnd(text, i);
			m.blank(i, j);
			i = j;
			continue;
		}
		if (c === '"' || c === '\'') {
			const triple = text.startsWith(c.repeat(3), i);
			if (triple) {
				let j = i + 3;
				let end = text.length;
				while (j < text.length) {
					if (text.charAt(j) === '\\') { j += 2; continue; }
					if (text.startsWith(c.repeat(3), j)) { end = j + 3; break; }
					j++;
				}
				blankString(m, i, end, 3, 3, end <= text.length && text.startsWith(c.repeat(3), end - 3) && end - 3 > i);
				i = end;
			} else {
				const j = endOfQuoted(text, i, c);
				blankString(m, i, j, 1, 1, text.charAt(j - 1) === c && j - 1 > i);
				i = j;
			}
			continue;
		}
		i++;
	}
	return m.result();
}

/** Go and Rust share `//` and `/* *\/` comments; Rust block comments nest. */
function maskCLike(text: string, lang: 'go' | 'rust'): string {
	const m = new Masker(text);
	let i = 0;
	while (i < text.length) {
		const c = text.charAt(i);
		const next = text.charAt(i + 1);
		if (c === '/' && next === '/') {
			const j = lineEnd(text, i);
			m.blank(i, j);
			i = j;
			continue;
		}
		if (c === '/' && next === '*') {
			let depth = 1;
			let j = i + 2;
			while (j < text.length && depth > 0) {
				if (text.startsWith('/*', j) && lang === 'rust') { depth++; j += 2; } else if (text.startsWith('*/', j)) { depth--; j += 2; } else j++;
			}
			m.blank(i, j);
			i = j;
			continue;
		}
		if (c === '"') {
			const j = endOfQuoted(text, i, '"', lang === 'rust');
			blankString(m, i, j, 1, 1, text.charAt(j - 1) === '"' && j - 1 > i);
			i = j;
			continue;
		}
		if (lang === 'go' && c === '`') {
			const close = text.indexOf('`', i + 1);
			const j = close < 0 ? text.length : close + 1;
			blankString(m, i, j, 1, 1, close >= 0);
			i = j;
			continue;
		}
		if (lang === 'go' && c === '\'') {
			const j = endOfQuoted(text, i, '\'');
			m.blank(i, j);
			i = j;
			continue;
		}
		if (lang === 'rust' && (c === 'r' || (c === 'b' && next === 'r')) && (i === 0 || !IDENT.test(text.charAt(i - 1)))) {
			const start = c === 'b' ? i + 1 : i;
			let hashes = 0;
			while (text.charAt(start + 1 + hashes) === '#') hashes++;
			if (text.charAt(start + 1 + hashes) === '"') {
				const closer = '"' + '#'.repeat(hashes);
				const close = text.indexOf(closer, start + 2 + hashes);
				const j = close < 0 ? text.length : close + closer.length;
				m.blank(start + 2 + hashes, close < 0 ? j : close);
				i = j;
				continue;
			}
		}
		if (lang === 'rust' && c === '\'') {
			// A char literal ('x', '\n'); otherwise a lifetime ('a).
			if (next === '\\') {
				const close = text.indexOf('\'', i + 3);
				const j = close < 0 ? i + 1 : close + 1;
				m.blank(i, j);
				i = j;
				continue;
			}
			const codePoint = text.codePointAt(i + 1);
			const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
			if (text.charAt(i + 1 + width) === '\'') {
				m.blank(i, i + 2 + width);
				i += 2 + width;
				continue;
			}
		}
		i++;
	}
	return m.result();
}

/**
 * Returns `text` with comments blanked and the contents of string literals
 * replaced by spaces. Offsets, line breaks and quote characters are kept, so
 * a match in the masked text can read the original string at the same place.
 * Keyword searches in the result never match inside comments or strings.
 */
export function maskSource(text: string, lang: MapLanguage): string {
	switch (lang) {
		case 'ts': return maskJs(text);
		case 'python': return maskPython(text);
		case 'go': return maskCLike(text, 'go');
		case 'rust': return maskCLike(text, 'rust');
	}
}
