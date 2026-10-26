import { ChildProcess, spawn } from 'child_process';
import type { Transport } from '@codemirror/lsp-client';
import { encodeMessage, MessageReader } from './framing';

/** How much of the server's stderr to keep for error messages, in characters. */
const STDERR_TAIL = 4000;

export interface StdioTransportOptions {
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** Called once when the process fails to start or exits. */
	onExit: (reason: string) => void;
	/**
	 * Answers a request from the server, or returns null to pass it on to the
	 * client (which rejects requests it does not implement).
	 */
	answer?: (method: string, params: unknown) => { result: unknown } | null;
}

/**
 * Talks to a language server over the standard input and output of a child
 * process, implementing `@codemirror/lsp-client`'s `Transport`.
 */
export class StdioTransport implements Transport {
	private child: ChildProcess;
	private handlers = new Set<(message: string) => void>();
	private reader = new MessageReader();
	private stderr = '';
	private exited = false;

	constructor(private opts: StdioTransportOptions) {
		const [command, ...args] = opts.argv;
		if (!command) throw new Error('Empty language server command');
		this.child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		this.child.stdout?.on('data', (chunk: Buffer) => this.receive(chunk));
		this.child.stderr?.on('data', (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString('utf-8')).slice(-STDERR_TAIL);
		});
		// Writes after the server died would otherwise surface as uncaught errors.
		this.child.stdin?.on('error', () => undefined);
		this.child.on('error', (err: NodeJS.ErrnoException) => {
			this.exit(err.code === 'ENOENT' ? `${command} was not found` : err.message);
		});
		this.child.on('exit', (code, signal) => {
			const how = signal ? `was stopped (${signal})` : `exited with code ${code ?? '?'}`;
			const detail = this.stderr.trim().split('\n').slice(-3).join('\n');
			this.exit(detail ? `${command} ${how}: ${detail}` : `${command} ${how}`);
		});
	}

	send(message: string): void {
		if (this.exited || !this.child.stdin?.writable) throw new Error('Language server is not running');
		this.child.stdin.write(encodeMessage(message));
	}

	subscribe(handler: (value: string) => void): void {
		this.handlers.add(handler);
	}

	unsubscribe(handler: (value: string) => void): void {
		this.handlers.delete(handler);
	}

	/** True until the process has exited or failed to start. */
	get running(): boolean {
		return !this.exited;
	}

	/** Stops the process; `onExit` is not called for a requested stop. */
	close() {
		if (this.exited) return;
		this.exited = true;
		this.child.kill();
	}

	private receive(chunk: Buffer) {
		let messages: string[];
		try {
			messages = this.reader.push(chunk);
		} catch (err) {
			this.exit(err instanceof Error ? err.message : String(err));
			this.child.kill();
			return;
		}
		for (const message of messages) {
			if (this.answered(message)) continue;
			for (const handler of this.handlers) handler(message);
		}
	}

	/** Replies to a server request that `answer` handles; true if it did. */
	private answered(message: string): boolean {
		const answer = this.opts.answer;
		// Cheap filter: only requests carry both a method and an id.
		if (!answer || !message.includes('"method"') || !message.includes('"id"')) return false;
		let parsed: { id?: unknown; method?: unknown; params?: unknown };
		try {
			parsed = JSON.parse(message) as typeof parsed;
		} catch {
			return false;
		}
		if (parsed.id === undefined || typeof parsed.method !== 'string') return false;
		const reply = answer(parsed.method, parsed.params);
		if (!reply) return false;
		try {
			this.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: reply.result }));
		} catch { /* the process is gone; onExit reports it */ }
		return true;
	}

	private exit(reason: string) {
		if (this.exited) return;
		this.exited = true;
		this.opts.onExit(reason);
	}
}
