import { extensionOf } from '../utils/fileIcons';

/** A language server Heron knows how to start, and the files it handles. */
export interface ServerSpec {
	id: string;
	name: string;
	/** Command line used when the user has not set one. */
	defaultCommand: string;
	/** LSP language ID for each file extension the server handles. */
	languages: Record<string, string>;
	/** Sent as `initializationOptions`. */
	initializationOptions?: unknown;
}

export const BUILTIN_SERVERS: readonly ServerSpec[] = [
	{
		id: 'python',
		name: 'Python',
		defaultCommand: 'basedpyright-langserver --stdio',
		languages: { py: 'python', pyi: 'python' },
	},
	{
		id: 'typescript',
		name: 'TypeScript and JavaScript',
		defaultCommand: 'typescript-language-server --stdio',
		languages: {
			ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact',
			js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
		},
	},
	{
		id: 'go',
		name: 'Go',
		defaultCommand: 'gopls',
		languages: { go: 'go' },
	},
	{
		id: 'rust',
		name: 'Rust',
		defaultCommand: 'rust-analyzer',
		languages: { rs: 'rust' },
		// Reading only: don't run `cargo check` or build scripts, which write `target/`.
		initializationOptions: { checkOnSave: false, cargo: { buildScripts: { enable: false } }, procMacro: { enable: false } },
	},
];

/** The server to use for a file and the command line to start it. */
export interface ServerChoice {
	spec: ServerSpec;
	languageId: string;
	argv: string[];
}

/**
 * Picks the server for `fileName`. `commands` holds the user's overrides by
 * server ID; an empty override turns that server off.
 */
export function serverForFile(fileName: string, commands: Record<string, string>): ServerChoice | null {
	const ext = extensionOf(fileName.toLowerCase());
	for (const spec of BUILTIN_SERVERS) {
		const languageId = spec.languages[ext];
		if (!languageId) continue;
		const argv = parseCommand(commands[spec.id] ?? spec.defaultCommand);
		return argv.length ? { spec, languageId, argv } : null;
	}
	return null;
}

/**
 * Splits a command line into arguments. Supports single and double quotes
 * and backslash escapes outside single quotes; a leading `~/` is expanded by
 * the caller, not here.
 */
export function parseCommand(command: string): string[] {
	const args: string[] = [];
	let current = '';
	let started = false;
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command.charAt(i);
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === '\\' && quote === '"' && i + 1 < command.length) current += command.charAt(++i);
			else current += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
		} else if (ch === '\\' && i + 1 < command.length) {
			current += command.charAt(++i);
			started = true;
		} else if (/\s/.test(ch)) {
			if (started) args.push(current);
			current = '';
			started = false;
		} else {
			current += ch;
			started = true;
		}
	}
	if (started) args.push(current);
	return args;
}
