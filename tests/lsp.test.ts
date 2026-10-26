import { describe, expect, it } from 'vitest';
import { contentLength, encodeMessage, FramingError, MessageReader } from '../src/lsp/framing';
import { flattenDocumentSymbols, toFileLocations, workspaceSymbols } from '../src/lsp/locations';
import { parseCommand, serverForFile } from '../src/lsp/servers';
import { mergePaths, pathFromShellOutput } from '../src/lsp/shellEnv';
import { sanitizeSettings } from '../src/settings';
import { NavHistory } from '../src/ui/pane/navHistory';

describe('framing', () => {
	it('round-trips messages, counting UTF-8 bytes rather than characters', () => {
		const json = JSON.stringify({ text: 'héllo → 世界' });
		const encoded = encodeMessage(json);
		expect(encoded.toString('ascii').startsWith(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n{`)).toBe(true);
		expect(new MessageReader().push(encoded)).toEqual([json]);
	});

	it('reassembles messages split at any byte, including inside a character', () => {
		const a = JSON.stringify({ id: 1, value: 'ä' });
		const b = JSON.stringify({ id: 2 });
		const stream = Buffer.concat([encodeMessage(a), encodeMessage(b)]);
		for (let split = 1; split < stream.length; split++) {
			const reader = new MessageReader();
			const out = [...reader.push(stream.subarray(0, split)), ...reader.push(stream.subarray(split))];
			expect(out).toEqual([a, b]);
		}
	});

	it('ignores other headers and rejects a missing length', () => {
		expect(contentLength('Content-Type: application/vscode-jsonrpc\r\ncontent-length: 12')).toBe(12);
		expect(() => contentLength('Content-Type: x')).toThrow(FramingError);
	});
});

describe('servers', () => {
	it('picks the server and language ID by extension', () => {
		expect(serverForFile('main.py', {})).toMatchObject({ languageId: 'python', argv: ['basedpyright-langserver', '--stdio'] });
		expect(serverForFile('App.TSX', {})).toMatchObject({ languageId: 'typescriptreact' });
		expect(serverForFile('README.md', {})).toBeNull();
	});

	it('uses overrides, and an empty override turns a server off', () => {
		expect(serverForFile('a.go', { go: '/opt/go/bin/gopls -remote=auto' })?.argv).toEqual(['/opt/go/bin/gopls', '-remote=auto']);
		expect(serverForFile('a.go', { go: '' })).toBeNull();
	});

	it('splits commands with quotes and escapes', () => {
		expect(parseCommand(`"/Applications/My App/ls" --stdio 'a b' c\\ d`)).toEqual(['/Applications/My App/ls', '--stdio', 'a b', 'c d']);
		expect(parseCommand('  ')).toEqual([]);
		expect(parseCommand('x ""')).toEqual(['x', '']);
	});

	it('keeps only string commands for known servers in settings', () => {
		const s = sanitizeSettings({ serverCommands: { python: ' pyright-langserver --stdio ', go: '', bogus: 'x', rust: 3 } });
		expect(s.serverCommands).toEqual({ python: 'pyright-langserver --stdio', go: '' });
		expect(s.languageServers).toBe(true);
	});
});

describe('shell PATH', () => {
	it('reads the PATH after the marker, ignoring startup noise', () => {
		expect(pathFromShellOutput('Welcome!\n__HERON_PATH__/a:/b\n')).toBe('/a:/b');
		expect(pathFromShellOutput('nothing')).toBe('');
	});

	it('merges PATHs, keeping the first of each folder', () => {
		expect(mergePaths('/a:/b', '/b:/c', '', '/a')).toBe('/a:/b:/c');
	});
});

describe('locations', () => {
	const range = (line: number, character: number) => ({ start: { line, character }, end: { line, character } });

	it('normalizes Location, Location[] and LocationLink[], dropping duplicates and non-file URIs', () => {
		expect(toFileLocations({ uri: 'file:///src/a.ts', range: range(1, 2) })).toEqual([{ absPath: '/src/a.ts', position: { line: 1, character: 2 } }]);
		expect(toFileLocations([
			{ targetUri: 'file:///src/b.ts', targetRange: range(5, 0), targetSelectionRange: range(6, 4) },
			{ uri: 'file:///src/b.ts', range: range(6, 4) },
			{ uri: 'deno:/lib.d.ts', range: range(0, 0) },
			null,
		])).toEqual([{ absPath: '/src/b.ts', position: { line: 6, character: 4 } }]);
		expect(toFileLocations(null)).toEqual([]);
	});

	it('flattens nested document symbols with their containers, in document order', () => {
		const symbols = flattenDocumentSymbols([
			{ name: 'later', kind: 12, range: range(9, 0) },
			{ name: 'Server', kind: 5, range: range(1, 0), selectionRange: range(1, 6), children: [
				{ name: 'start', kind: 6, range: range(2, 2) },
			] },
		], '/a.ts');
		expect(symbols.map((s) => [s.name, s.kind, s.container, s.position.line])).toEqual([
			['Server', 'class', '', 1],
			['start', 'method', 'Server', 2],
			['later', 'function', '', 9],
		]);
	});

	it('accepts flat symbol information and workspace symbols without ranges', () => {
		const info = [{ name: 'x', kind: 13, location: { uri: 'file:///a.ts', range: range(3, 1) }, containerName: 'mod' }];
		expect(flattenDocumentSymbols(info, '/a.ts')[0]).toMatchObject({ name: 'x', kind: 'variable', container: 'mod' });
		const ws = workspaceSymbols([...info, { name: 'y', kind: 5, location: { uri: 'file:///b.ts' } }], 10);
		expect(ws.map((s) => [s.absPath, s.position.line])).toEqual([['/a.ts', 3], ['/b.ts', 0]]);
		expect(workspaceSymbols(ws, 1)).toHaveLength(0);
	});
});

describe('NavHistory', () => {
	const same = (a: number, b: number) => a === b;

	it('goes back and forward like a browser, and a new jump clears forward', () => {
		const h = new NavHistory<number>(same);
		h.record(1);
		h.record(2);
		expect(h.back(3)).toBe(2);
		expect(h.back(2)).toBe(1);
		expect(h.back(1)).toBeNull();
		expect(h.forward(1)).toBe(2);
		expect(h.canGoForward()).toBe(true);
		h.record(2);
		expect(h.canGoForward()).toBe(false);
	});

	it('does not record the same place twice in a row', () => {
		const h = new NavHistory<number>(same);
		h.record(1);
		h.record(1);
		expect(h.back(5)).toBe(1);
		expect(h.canGoBack()).toBe(false);
	});
});
