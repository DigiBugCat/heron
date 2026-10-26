import { spawn } from 'child_process';
import * as os from 'os';
import { serverPath } from '../lsp/shellEnv';
import { parseCommand } from '../lsp/servers';

/**
 * A small LLM client with two transports: the Anthropic Messages API with an
 * API key, or the local Claude Code CLI (`claude -p`), which reuses the
 * user's Claude Code login. No `obsidian` imports: the HTTP call is injected
 * (Obsidian's `requestUrl` in the plugin, a stub in tests).
 */

export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
/** Longest a model call may take before it is abandoned. */
export const MODEL_TIMEOUT_MS = 120_000;
/** Largest CLI output kept, in characters. */
const MAX_OUTPUT_CHARS = 1_000_000;

export interface ModelRequest {
	system: string;
	prompt: string;
	maxTokens: number;
}

export interface ModelClient {
	/** Returns the model's text reply; rejects with `ModelError` (or `ModelCancelled`). */
	complete(request: ModelRequest, signal?: AbortSignal): Promise<string>;
}

export class ModelError extends Error {}

export class ModelCancelled extends ModelError {
	constructor() {
		super('Cancelled');
	}
}

function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) throw new ModelCancelled();
}

/** Rejects as soon as `signal` aborts, even if `work` can't be stopped (e.g. an HTTP request). */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new ModelCancelled());
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener('abort', onAbort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
}

// ---- Anthropic Messages API ----

export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

export interface HttpResponse {
	status: number;
	text: string;
}

/** Sends an HTTP request without throwing for error statuses (Obsidian's `requestUrl` with `throw: false`). */
export type HttpPost = (request: HttpRequest) => Promise<HttpResponse>;

export function apiRequest(model: string, apiKey: string, request: ModelRequest): HttpRequest {
	return {
		url: ANTHROPIC_URL,
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': ANTHROPIC_VERSION,
		},
		body: JSON.stringify({
			model,
			max_tokens: request.maxTokens,
			system: request.system,
			messages: [{ role: 'user', content: request.prompt }],
		}),
	};
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

/** The text of a Messages API response, or a `ModelError` with the API's message. */
export function parseApiResponse(response: HttpResponse): string {
	const json = parseJson(response.text) as {
		type?: unknown; content?: unknown; error?: { message?: unknown }; stop_reason?: unknown;
	} | null;
	if (response.status >= 400 || json?.type === 'error') {
		const message = typeof json?.error?.message === 'string' ? json.error.message : response.text.slice(0, 200) || 'no details';
		if (response.status === 401) throw new ModelError(`The API key was rejected: ${message}`);
		throw new ModelError(`The API returned ${response.status}: ${message}`);
	}
	if (!json || !Array.isArray(json.content)) throw new ModelError('The API returned an unexpected response');
	const text = (json.content as { type?: unknown; text?: unknown }[])
		.filter((block) => block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text as string)
		.join('');
	if (!text.trim()) throw new ModelError('The model returned no text');
	return text;
}

/** The Messages API, with the key read when a request is made. */
export function apiClient(opts: { model: string; apiKey: () => string | null; post: HttpPost }): ModelClient {
	return {
		async complete(request, signal) {
			throwIfAborted(signal);
			const key = opts.apiKey();
			if (!key) throw new ModelError('No Anthropic API key. Add one in Heron\'s settings, or use the Claude Code transport.');
			let response: HttpResponse;
			try {
				response = await abortable(opts.post(apiRequest(opts.model, key, request)), signal);
			} catch (err) {
				if (err instanceof ModelError) throw err;
				throw new ModelError(`Cannot reach the Anthropic API: ${err instanceof Error ? err.message : String(err)}`);
			}
			return parseApiResponse(response);
		},
	};
}

// ---- Claude Code CLI ----

/**
 * Arguments for `claude -p`. Besides the model and JSON output, they keep the
 * call small and self-contained: no tools, no settings, MCP servers, skills
 * or CLAUDE.md files (which can add hundreds of thousands of tokens to every
 * call), and no saved session.
 */
export function cliArgs(model: string, system: string): string[] {
	return [
		'-p',
		'--model', model,
		'--output-format', 'json',
		'--system-prompt', system,
		'--tools', '',
		'--setting-sources', '',
		'--strict-mcp-config',
		'--disable-slash-commands',
		'--no-session-persistence',
	];
}

export interface ProcessResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Runs a command with `input` on stdin; kills it when `signal` aborts. */
export type RunProcess = (command: string, args: string[], input: string, signal?: AbortSignal) => Promise<ProcessResult>;

/** The reply in `claude -p --output-format json` output, or a `ModelError`. */
export function parseCliOutput(result: ProcessResult): string {
	// Warnings may precede the JSON object on stdout.
	const start = result.stdout.indexOf('{');
	const json = start < 0 ? null : parseJson(result.stdout.slice(start)) as {
		type?: unknown; is_error?: unknown; result?: unknown; subtype?: unknown;
	} | null;
	if (!json || typeof json !== 'object') {
		const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300);
		throw new ModelError(`Claude Code failed${result.code ? ` (exit code ${result.code})` : ''}: ${detail || 'no output'}`);
	}
	if (json.is_error === true || (json.subtype !== undefined && json.subtype !== 'success')) {
		const message = typeof json.result === 'string' && json.result ? json.result : typeof json.subtype === 'string' ? json.subtype : 'error';
		throw new ModelError(`Claude Code reported an error: ${message.slice(0, 300)}`);
	}
	if (typeof json.result !== 'string' || !json.result.trim()) throw new ModelError('Claude Code returned no text');
	return json.result;
}

/** The Claude Code CLI; `command` is how to run `claude` (default `claude`). */
export function cliClient(opts: { model: string; command: string; run?: RunProcess }): ModelClient {
	const run = opts.run ?? runProcess;
	return {
		async complete(request, signal) {
			throwIfAborted(signal);
			const [command, ...prefix] = parseCommand(opts.command.trim() || 'claude');
			if (!command) throw new ModelError('No Claude Code command is set');
			const input = request.prompt;
			const result = await run(command, [...prefix, ...cliArgs(opts.model, request.system)], input, signal);
			throwIfAborted(signal);
			return parseCliOutput(result);
		},
	};
}

/**
 * Runs commands in the temp folder (so no project files or CLAUDE.md are
 * picked up), with the login shell's PATH so a GUI-launched Obsidian finds them.
 */
export function processRunner(searchPath: () => Promise<string> = serverPath, timeoutMs = MODEL_TIMEOUT_MS): RunProcess {
	return (command, args, input, signal) => spawnWithInput(command, args, input, searchPath, timeoutMs, signal);
}

export const runProcess: RunProcess = processRunner();

async function spawnWithInput(
	command: string,
	args: string[],
	input: string,
	searchPath: () => Promise<string>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ProcessResult> {
	const PATH = await searchPath();
	throwIfAborted(signal);
	return new Promise<ProcessResult>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: os.tmpdir(),
			env: { ...process.env, PATH },
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			fn();
		};
		const onAbort = () => {
			child.kill();
			finish(() => reject(new ModelCancelled()));
		};
		const timer = window.setTimeout(() => {
			child.kill();
			finish(() => reject(new ModelError(`Claude Code did not answer within ${Math.round(timeoutMs / 1000)} seconds`)));
		}, timeoutMs);
		signal?.addEventListener('abort', onAbort, { once: true });
		child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString('utf-8'); });
		child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString('utf-8'); });
		child.on('error', (err: NodeJS.ErrnoException) => {
			const message = err.code === 'ENOENT'
				? `${command} was not found. Install Claude Code, or set its command in Heron's settings.`
				: err.message;
			finish(() => reject(new ModelError(message)));
		});
		child.on('close', (code) => finish(() => resolve({ code, stdout, stderr })));
		child.stdin.on('error', () => { /* reported through 'close' */ });
		child.stdin.end(input);
	});
}
