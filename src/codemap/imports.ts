import { MapLanguage, maskSource } from './mask';

/** One import found in a source file, before resolution. */
export interface ImportRef {
	/**
	 * What was imported: a module specifier for TypeScript/JavaScript and Go,
	 * a dotted module for Python (empty for `from . import x`), or a
	 * `::`-separated path for Rust.
	 */
	spec: string;
	/** Python: number of leading dots of a relative import. */
	level?: number;
	/** Python: the names of a from-import (`*` for a star import). */
	names?: string[];
	/** Rust: a `mod name;` declaration rather than a `use`. */
	mod?: boolean;
}

/** Reads the string literal whose opening quote is at `pos` in `original`; the masked text gives its end. */
function literalAt(original: string, masked: string, pos: number): string | null {
	const quote = original.charAt(pos);
	const end = masked.indexOf(quote, pos + 1);
	if (end < 0) return null;
	const nl = masked.indexOf('\n', pos + 1);
	if (quote !== '`' && nl >= 0 && nl < end) return null;
	return original.slice(pos + 1, end);
}

/** Positions of an opening quote right after each match of `re` (which must end with a lookahead for it). */
function quotesAfter(masked: string, re: RegExp): number[] {
	const found: number[] = [];
	for (const match of masked.matchAll(re)) found.push((match.index ?? 0) + match[0].length);
	return found;
}

const TS_IMPORT = /(?:^|[^\w$.])import\s*(?:type\s+)?(?:[\w$*{},\s]{0,1000}?\s*\bfrom\s*)?(?=['"])/g;
const TS_EXPORT_FROM = /(?:^|[^\w$.])export\s*(?:type\s+)?(?:\*\s*(?:as\s+[\w$]+\s*)?|\{[^}]{0,2000}\}\s*)from\s*(?=['"])/g;
const TS_CALL = /(?:^|[^\w$.])(?:require|import)\s*\(\s*(?=['"`])/g;

function parseTs(text: string, masked: string): ImportRef[] {
	const specs: string[] = [];
	for (const pos of [...quotesAfter(masked, TS_IMPORT), ...quotesAfter(masked, TS_EXPORT_FROM)]) {
		const spec = literalAt(text, masked, pos);
		if (spec) specs.push(spec);
	}
	for (const pos of quotesAfter(masked, TS_CALL)) {
		const spec = literalAt(text, masked, pos);
		if (!spec || spec.includes('${')) continue;
		// Only a lone literal argument: `require('a' + b)` is not resolvable.
		const after = masked.slice(pos + spec.length + 2).match(/^\s*([),])/);
		if (after) specs.push(spec);
	}
	return specs.map((spec) => ({ spec }));
}

const PY_FROM = /(?:^|;)[ \t]*from[ \t]+(\.*)[ \t]*([\w.]*)[ \t]+import[ \t]*(\([^)]*\)|[^\n;]*)/gm;
const PY_IMPORT = /(?:^|;)[ \t]*import[ \t]+([^\n;]+)/gm;
const PY_DYNAMIC = /\b(?:import_module|__import__)\s*\(\s*(?=['"])/g;
const PY_NAME = /^[A-Za-z_]\w*$/;

function parsePython(text: string, masked: string): ImportRef[] {
	// Join backslash continuations; line numbers are not needed.
	const joined = masked.replace(/\\\r?\n/g, (s) => ' '.repeat(s.length));
	const refs: ImportRef[] = [];
	for (const match of joined.matchAll(PY_FROM)) {
		const level = (match[1] ?? '').length;
		const module = (match[2] ?? '').replace(/^\.+/, '');
		const names = (match[3] ?? '').replace(/[()]/g, ' ').split(',')
			.map((part) => part.trim().split(/\s+/)[0] ?? '')
			.filter((name) => name === '*' || PY_NAME.test(name));
		if (!level && !module) continue;
		refs.push({ spec: module, level, names });
	}
	for (const match of joined.matchAll(PY_IMPORT)) {
		for (const part of (match[1] ?? '').split(',')) {
			const module = part.trim().split(/\s+/)[0] ?? '';
			if (/^[A-Za-z_][\w.]*$/.test(module)) refs.push({ spec: module, level: 0, names: [] });
		}
	}
	for (const pos of quotesAfter(joined, PY_DYNAMIC)) {
		const module = literalAt(text, joined, pos);
		if (module && /^[A-Za-z_][\w.]*$/.test(module)) refs.push({ spec: module, level: 0, names: [] });
	}
	return refs;
}

const GO_SINGLE = /\bimport\s*(?:[\w.]+\s+)?(?=["`])/g;
const GO_BLOCK = /\bimport\s*\(/g;

function parseGo(text: string, masked: string): ImportRef[] {
	const specs: string[] = [];
	for (const pos of quotesAfter(masked, GO_SINGLE)) {
		const spec = literalAt(text, masked, pos);
		if (spec) specs.push(spec);
	}
	for (const match of masked.matchAll(GO_BLOCK)) {
		const start = (match.index ?? 0) + match[0].length;
		const close = masked.indexOf(')', start);
		const end = close < 0 ? masked.length : close;
		let pos = start;
		while (pos < end) {
			const q = masked.slice(pos, end).search(/["`]/);
			if (q < 0) break;
			const at = pos + q;
			const closing = masked.indexOf(masked.charAt(at), at + 1);
			if (closing < 0 || closing > end) break;
			specs.push(text.slice(at + 1, closing));
			pos = closing + 1;
		}
	}
	return specs.filter(Boolean).map((spec) => ({ spec }));
}

const RUST_VIS = String.raw`(?:pub(?:\s*\([^)]*\))?\s+)?`;
const RUST_MOD = new RegExp(String.raw`(?:^|[;{}\s\]])${RUST_VIS}mod\s+([A-Za-z_]\w*)\s*;`, 'g');
const RUST_USE = new RegExp(String.raw`(?:^|[;{}\s\]])${RUST_VIS}use\s+([^;]+);`, 'g');
const RUST_EXTERN = /\bextern\s+crate\s+([A-Za-z_]\w*)/g;

/**
 * Expands a Rust use tree (`a::{b, c::d as e, f::*}`) into its paths:
 * `[a, b]`, `[a, c, d]`, `[a, f]`. `self` in a group means the prefix itself.
 */
export function expandUseTree(tree: string): string[][] {
	const tokens = tree.match(/[A-Za-z_]\w*|::|[{},*]/g) ?? [];
	let i = 0;
	const paths: string[][] = [];
	const parse = (prefix: string[]) => {
		const segs = [...prefix];
		if (tokens[i] === '::') i++; // leading `::`
		while (i < tokens.length) {
			const t = tokens[i] ?? '';
			if (t === '{') {
				i++;
				while (i < tokens.length && tokens[i] !== '}') {
					if (tokens[i] === ',') { i++; continue; }
					const before = i;
					parse(segs);
					if (i === before) i++;
				}
				i++; // `}`
				return;
			}
			if (t === '*') { i++; paths.push(segs); return; }
			if (t === ',' || t === '}') break;
			if (t === '::') { i++; continue; }
			if (t === 'as') { i += 2; break; }
			// `a::{self, b}`: `self` is `a` itself.
			if (t === 'self' && prefix.length > 0 && segs.length === prefix.length) { i++; continue; }
			segs.push(t);
			i++;
		}
		if (segs.length) paths.push(segs);
	};
	while (i < tokens.length) {
		if (tokens[i] === ',' || tokens[i] === '}') { i++; continue; }
		const before = i;
		parse([]);
		if (i === before) i++;
	}
	return paths;
}

function parseRust(masked: string): ImportRef[] {
	const refs: ImportRef[] = [];
	for (const match of masked.matchAll(RUST_MOD)) refs.push({ spec: match[1] ?? '', mod: true });
	for (const match of masked.matchAll(RUST_USE)) {
		for (const segs of expandUseTree(match[1] ?? '')) refs.push({ spec: segs.join('::') });
	}
	for (const match of masked.matchAll(RUST_EXTERN)) refs.push({ spec: match[1] ?? '' });
	return refs;
}

/** Finds the imports in a source file. Comments and strings never produce imports. */
export function parseImports(text: string, lang: MapLanguage, masked = maskSource(text, lang)): ImportRef[] {
	switch (lang) {
		case 'ts': return parseTs(text, masked);
		case 'python': return parsePython(text, masked);
		case 'go': return parseGo(text, masked);
		case 'rust': return parseRust(masked);
	}
}
