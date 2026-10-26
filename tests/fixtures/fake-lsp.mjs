// A tiny language server for tests. Answers over stdio with fixed results
// relative to the root it was started in: definitions point at target.ts.
import { writeFileSync } from 'fs';

if (process.env.FAKE_LSP_PID_FILE) writeFileSync(process.env.FAKE_LSP_PID_FILE, String(process.pid));
if (process.argv.includes('--crash')) {
	process.stderr.write('fake-lsp: crashing on purpose\n');
	process.exit(3);
}

let root = '';
let pending = Buffer.alloc(0);

function send(message) {
	const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf-8');
	process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

const at = (line, character) => ({ start: { line, character }, end: { line, character: character + 3 } });

function handle(msg) {
	const reply = (result) => send({ id: msg.id, result });
	switch (msg.method) {
		case 'initialize':
			root = msg.params.rootUri;
			return reply({ capabilities: {
				textDocumentSync: 1, hoverProvider: true, definitionProvider: true, referencesProvider: true,
				documentSymbolProvider: true, workspaceSymbolProvider: true,
			} });
		case 'textDocument/definition':
			return reply({ uri: `${root}/target.ts`, range: at(2, 4) });
		case 'textDocument/references':
			return reply([
				{ uri: `${root}/target.ts`, range: at(2, 4) },
				{ uri: msg.params.textDocument.uri, range: at(0, 7) },
			]);
		case 'textDocument/documentSymbol':
			return reply([{ name: 'Outer', kind: 5, range: at(0, 0), selectionRange: at(0, 6), children: [
				{ name: 'inner', kind: 6, range: at(1, 2), selectionRange: at(1, 2) },
			] }]);
		case 'textDocument/hover':
			return reply({ contents: { kind: 'markdown', value: '**fake hover**' } });
		case undefined:
			// A response to our progress request: report work, then finish it.
			if (msg.id === 'progress-1' && msg.result === null) {
				send({ method: '$/progress', params: { token: 't1', value: { kind: 'begin', title: 'Indexing' } } });
				setTimeout(() => send({ method: '$/progress', params: { token: 't1', value: { kind: 'end' } } }), 300);
			}
			return;
		case 'initialized':
			if (process.argv.includes('--progress')) send({ id: 'progress-1', method: 'window/workDoneProgress/create', params: { token: 't1' } });
			return;
		case 'shutdown':
			return reply(null);
		case 'exit':
			return process.exit(0);
		default:
			if (msg.id !== undefined) reply(null);
	}
}

process.stdin.on('data', (chunk) => {
	pending = Buffer.concat([pending, chunk]);
	for (;;) {
		const end = pending.indexOf('\r\n\r\n');
		if (end < 0) return;
		const length = Number(/Content-Length: (\d+)/i.exec(pending.toString('ascii', 0, end))[1]);
		if (pending.length < end + 4 + length) return;
		handle(JSON.parse(pending.toString('utf-8', end + 4, end + 4 + length)));
		pending = pending.subarray(end + 4 + length);
	}
});
