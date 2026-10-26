import { describe, expect, it } from 'vitest';
import { AnchorText, makeAnchor, resolveAnchor } from '../src/notes/anchor';

const FILE = [
	'import { load } from "./load";',
	'',
	'export function start(port: number) {',
	'\tconst server = load(port);',
	'\tserver.listen();',
	'\treturn server;',
	'}',
	'',
	'export function stop(server: Server) {',
	'\tserver.close();',
	'}',
	'',
].join('\n');

/** Anchors the first occurrence of `quote` in `text`. */
function anchorOf(text: string, quote: string, occurrence = 0) {
	let from = -1;
	for (let i = 0; i <= occurrence; i++) from = text.indexOf(quote, from + 1);
	if (from < 0) throw new Error(`no ${quote}`);
	return makeAnchor(text, from, from + quote.length);
}

function found(text: string, anchor: ReturnType<typeof makeAnchor>) {
	const match = resolveAnchor(text, anchor);
	return match && { text: text.slice(match.from, match.to), quality: match.quality, from: match.from };
}

describe('makeAnchor', () => {
	it('keeps the quote, some context on each side and the line', () => {
		const anchor = anchorOf(FILE, 'server.listen();');
		expect(anchor.quote).toBe('server.listen();');
		expect(FILE.endsWith(anchor.suffix, FILE.indexOf('server.listen();') + 16 + anchor.suffix.length)).toBe(true);
		expect(anchor.prefix.endsWith('load(port);\n\t')).toBe(true);
		expect(anchor.line).toBe(4);
	});
});

describe('resolveAnchor', () => {
	it('finds the quote in the unchanged file', () => {
		const anchor = anchorOf(FILE, 'const server = load(port);');
		expect(found(FILE, anchor)).toMatchObject({ text: 'const server = load(port);', quality: 'exact' });
	});

	it('follows the quote when lines are added above it', () => {
		const anchor = anchorOf(FILE, '\tserver.listen();\n\treturn server;');
		const edited = `// a header comment\n// another\n${FILE}`;
		const match = found(edited, anchor);
		expect(match).toMatchObject({ text: '\tserver.listen();\n\treturn server;', quality: 'exact' });
		expect(match?.from).toBe(edited.indexOf('\tserver.listen();'));
	});

	it('finds a block that moved elsewhere in the file', () => {
		const block = 'export function stop(server: Server) {\n\tserver.close();\n}\n';
		const anchor = anchorOf(FILE, block);
		const moved = block + '\n' + FILE.replace(block, '');
		expect(found(moved, anchor)).toMatchObject({ text: block, quality: 'exact', from: 0 });
	});

	it('chooses between duplicate quotes by their context', () => {
		const text = 'function a() {\n\treturn 1;\n}\nfunction b() {\n\treturn 1;\n}\n';
		const second = anchorOf(text, 'return 1;', 1);
		// Lines added above shift both copies; context still picks the one in b().
		const edited = `// new\n// lines\n${text}`;
		const match = resolveAnchor(edited, second);
		expect(match?.from).toBe(edited.lastIndexOf('return 1;'));
	});

	it('uses the line hint when duplicates have the same context', () => {
		const text = 'x();\nx();\nx();\nx();\n';
		const third = makeAnchor(text, 10, 14);
		expect(third.quote).toBe('x();');
		const match = resolveAnchor(text, { ...third, prefix: '', suffix: '' });
		expect(match?.from).toBe(10);
	});

	it('survives re-indentation and reformatting', () => {
		const anchor = anchorOf(FILE, 'const server = load(port);\n\tserver.listen();');
		const reformatted = FILE.replace('\tconst server = load(port);\n\tserver.listen();', '    const server = load( port );\n\n    server.listen();');
		const match = found(reformatted, anchor);
		expect(match).toMatchObject({ quality: 'normalized', text: 'const server = load( port );\n\n    server.listen();' });
	});

	it('finds a block that was edited inside, approximately', () => {
		const quote = [
			'export function start(port: number) {',
			'\tconst server = load(port);',
			'\tserver.listen();',
			'\treturn server;',
			'}',
		].join('\n');
		const anchor = anchorOf(FILE, quote);
		const rewritten = FILE.replace('\tserver.listen();', '\tserver.listen({ backlog: 10 });\n\tlog("listening");');
		const match = found(rewritten, anchor);
		expect(match?.quality).toBe('fuzzy');
		expect(match?.text.startsWith('export function start(port: number) {')).toBe(true);
		expect(match?.text.endsWith('return server;')).toBe(true);
	});

	it('orphans a note whose code was deleted', () => {
		const anchor = anchorOf(FILE, 'export function stop(server: Server) {\n\tserver.close();\n}');
		const deleted = FILE.replace(/export function stop[\s\S]*$/, '');
		expect(resolveAnchor(deleted, anchor)).toBeNull();
	});

	it('orphans a one-line quote that was changed', () => {
		const anchor = anchorOf(FILE, 'server.close();');
		expect(resolveAnchor(FILE.replace('server.close();', 'server.shutdown();'), anchor)).toBeNull();
	});

	it('does not match a block approximately from a single surviving line', () => {
		const anchor = anchorOf(FILE, '\tconst server = load(port);\n\tserver.listen();\n\treturn server;');
		const text = 'unrelated();\n\treturn server;\nmore();\n';
		expect(resolveAnchor(text, anchor)).toBeNull();
	});

	it('orphans an empty or whitespace-only quote', () => {
		expect(resolveAnchor(FILE, { quote: '  \n', prefix: '', suffix: '' })).toBeNull();
	});

	it('resolves many anchors against one prepared text', () => {
		const doc = new AnchorText(FILE);
		const anchors = ['server.listen();', 'server.close();', 'return server;'].map((q) => anchorOf(FILE, q));
		expect(anchors.map((a) => resolveAnchor(doc, a)?.quality)).toEqual(['exact', 'exact', 'exact']);
	});
});
