import type { OutlineNode } from '../lsp/locations';

/** Pure helpers that pick what to tell the model about some code. */

/** Words that are never worth asking a language server about. */
const KEYWORDS = new Set([
	// Shared by many languages
	'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'switch', 'case', 'default', 'try', 'catch',
	'finally', 'throw', 'new', 'delete', 'true', 'false', 'null', 'this', 'self', 'super', 'class', 'struct', 'enum',
	'interface', 'type', 'const', 'let', 'var', 'function', 'fn', 'func', 'def', 'async', 'await', 'yield', 'import',
	'export', 'from', 'as', 'in', 'of', 'is', 'not', 'and', 'or', 'with', 'pass', 'lambda', 'None', 'True', 'False',
	'void', 'static', 'public', 'private', 'protected', 'readonly', 'extends', 'implements', 'typeof', 'instanceof',
	'undefined', 'package', 'go', 'defer', 'chan', 'map', 'range', 'mut', 'pub', 'impl', 'use', 'mod', 'match', 'loop',
	'where', 'trait', 'let', 'elif', 'except', 'raise', 'global', 'nonlocal', 'assert', 'string', 'number', 'boolean',
	'any', 'unknown', 'never', 'int', 'float', 'bool', 'str', 'char', 'long', 'double', 'byte', 'Self', 'crate',
	'get', 'set', 'declare', 'namespace', 'module', 'require', 'final', 'override', 'abstract', 'unsafe', 'ref',
]);

export interface Identifier {
	name: string;
	/** Offset of its first occurrence in the text it was found in. */
	index: number;
	/** How often it occurs. */
	count: number;
}

/**
 * Identifiers in `code`, in order of first occurrence, skipping keywords,
 * one-letter names, and words in strings or comments (roughly).
 */
export function identifiersIn(code: string): Identifier[] {
	const masked = maskStringsAndComments(code);
	const found = new Map<string, Identifier>();
	for (const m of masked.matchAll(/[A-Za-z_$][\w$]*/g)) {
		const name = m[0];
		if (name.length < 2 || KEYWORDS.has(name) || /^\d/.test(name)) continue;
		const existing = found.get(name);
		if (existing) existing.count++;
		else found.set(name, { name, index: m.index ?? 0, count: 1 });
	}
	return [...found.values()];
}

/** The identifiers that best characterize `code`: frequent and long ones first. */
export function keyIdentifiers(code: string, max: number): Identifier[] {
	return identifiersIn(code)
		.filter((id) => id.name.length >= 3)
		.sort((a, b) => b.count - a.count || b.name.length - a.name.length || a.index - b.index)
		.slice(0, max);
}

/** Replaces string literals and comments with spaces, keeping offsets. */
export function maskStringsAndComments(code: string): string {
	return code.replace(/\/\/[^\n]*|#(?![\w!])[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Import-like lines (JS/TS, Python, Go, Rust, C), at most `max`. */
export function importLines(code: string, max: number): string[] {
	const result: string[] = [];
	for (const line of code.split('\n')) {
		const t = line.trim();
		if (/^(import\b|from\s+\S+\s+import\b|export\s.*\bfrom\s|use\s|#include\b|extern crate\b)/.test(t)
			|| /\brequire\(\s*['"]/.test(t)) {
			result.push(t.slice(0, 200));
			if (result.length >= max) break;
		}
	}
	return result;
}

/** An outline as indented text, e.g. `class Server` / `  method start(port)`; at most `max` lines. */
export function outlineText(nodes: OutlineNode[], max: number): string {
	const lines: string[] = [];
	const visit = (list: OutlineNode[], depth: number) => {
		for (const node of list) {
			if (lines.length >= max) return;
			const detail = node.detail ? ` ${node.detail.slice(0, 80)}` : '';
			lines.push(`${'  '.repeat(depth)}${node.kind} ${node.name}${detail} (line ${node.start.line + 1})`);
			visit(node.children, depth + 1);
		}
	};
	visit(nodes, 0);
	return lines.join('\n');
}

/** Cuts `text` to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Lines `from`–`to` (zero-based, inclusive, clamped) of `lines`, as text. */
export function snippet(lines: string[], from: number, to: number): string {
	return lines.slice(Math.max(0, from), Math.min(lines.length, to + 1)).join('\n');
}
