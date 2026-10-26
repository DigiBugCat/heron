import * as path from 'path';
import { pathToFileURL } from 'url';
import { LSPClient, serverDiagnostics } from '@codemirror/lsp-client';
import { ServerChoice, serverForFile } from './servers';
import { serverPath } from './shellEnv';
import { StdioTransport } from './transport';
import { ViewerWorkspace } from './workspace';

/** Requests slower than this fail; first requests on a large project can be slow. */
const REQUEST_TIMEOUT_MS = 20000;
/** How long to wait for a polite shutdown before killing a server. */
const SHUTDOWN_TIMEOUT_MS = 1500;
/**
 * Servers start loading the project when the first file opens, and only
 * report that progress a little later; until then they may look idle.
 */
const STARTUP_GRACE_MS = 1000;
/** A server that failed is not started again for this long, unless restarted by the user. */
const RETRY_AFTER_MS = 30000;

export type LspStatus =
	| { kind: 'starting'; name: string }
	/** `busy` is what the server reports it is doing, e.g. loading the project. */
	| { kind: 'ready'; name: string; busy?: string }
	| { kind: 'failed'; name: string; message: string };

/** A running (or failed) language server for one project root. */
export interface LspSession {
	readonly name: string;
	readonly root: string;
	readonly client: LSPClient;
	readonly workspace: ViewerWorkspace;
	status: LspStatus;
}

interface SessionState extends LspSession {
	key: string;
	transport: StdioTransport | null;
	ready: Promise<boolean>;
	failedAt: number;
	/** When initialization finished, for the startup grace period. */
	readyAt: number;
	/** Work in progress reported by the server, by progress token. */
	progress: Map<string, string>;
	/** Called when `progress` becomes empty. */
	idleWaiters: (() => void)[];
}

interface ProgressParams {
	token?: unknown;
	value?: { kind?: string; title?: string; message?: string };
}

/**
 * Requests from the server that Heron answers itself: progress reporting,
 * dynamic registration and settings. Anything else gets "not implemented".
 */
export function answerServerRequest(method: string, params: unknown): { result: unknown } | null {
	switch (method) {
		case 'window/workDoneProgress/create':
		case 'client/registerCapability':
		case 'client/unregisterCapability':
		case 'window/showMessageRequest':
			return { result: null };
		case 'workspace/configuration': {
			const items = (params as { items?: unknown[] } | null)?.items;
			return { result: Array.isArray(items) ? items.map(() => null) : [] };
		}
		default:
			return null;
	}
}

export interface LspManagerConfig {
	/** Whether language servers are turned on. */
	enabled: () => boolean;
	/** The user's command overrides by server ID. */
	commands: () => Record<string, string>;
	/** Strips unsafe HTML from rendered hover documentation. */
	sanitizeHTML?: (html: string) => string;
	/** Called when a server fails to start or stops unexpectedly. */
	onFailure?: (name: string, message: string) => void;
	/** Overrides the PATH servers are started with (tests). */
	path?: () => Promise<string>;
}

export interface LspTarget {
	session: LspSession;
	choice: ServerChoice;
}

/**
 * Starts language servers on demand, one per server type and project root,
 * and stops them when asked. Servers are external programs; Heron only
 * talks to them over standard input and output.
 */
export class LspManager {
	private sessions = new Map<string, SessionState>();
	private listeners = new Set<() => void>();

	constructor(private config: LspManagerConfig) {}

	/** The server that would handle `absPath`, if any is configured and enabled. */
	choose(absPath: string): ServerChoice | null {
		if (!this.config.enabled()) return null;
		return serverForFile(path.basename(absPath), this.config.commands());
	}

	/**
	 * The session for `absPath` under `root`, started if needed and ready for
	 * requests; null when no server applies or it could not start.
	 */
	async connect(absPath: string, root: string): Promise<LspTarget | null> {
		const choice = this.choose(absPath);
		if (!choice) return null;
		const key = sessionKey(choice, root);
		let session = this.sessions.get(key);
		if (session?.status.kind === 'failed') {
			if (Date.now() - session.failedAt < RETRY_AFTER_MS) return null;
			this.sessions.delete(key);
			session = undefined;
		}
		session ??= await this.start(key, choice, root);
		const ok = await session.ready;
		return ok && this.sessions.get(key) === session ? { session, choice } : null;
	}

	/** Status of the server for `absPath` under `root`, or null if none has been started. */
	status(absPath: string, root: string): LspStatus | null {
		const choice = this.choose(absPath);
		return choice ? this.sessions.get(sessionKey(choice, root))?.status ?? null : null;
	}

	/** True while `session` is running and has not been stopped or replaced. */
	isLive(session: LspSession): boolean {
		const state = session as SessionState;
		return this.sessions.get(state.key) === state && state.status.kind === 'ready';
	}

	/**
	 * Resolves once `session` reports no work in progress, or after `maxMs`.
	 * Servers loading a project may answer with partial results until then.
	 */
	async whenIdle(session: LspSession, maxMs: number): Promise<void> {
		const state = session as SessionState;
		const grace = state.readyAt + STARTUP_GRACE_MS - Date.now();
		if (grace > 0) await new Promise((resolve) => window.setTimeout(resolve, Math.min(grace, maxMs)));
		if (!state.progress.size) return;
		return new Promise((resolve) => {
			const timer = window.setTimeout(resolve, maxMs);
			state.idleWaiters.push(() => {
				window.clearTimeout(timer);
				resolve();
			});
		});
	}

	/** Calls `listener` whenever a server starts, becomes ready, fails or stops. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Stops every server. They start again when next needed. */
	stopAll() {
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		for (const session of sessions) void this.shutdown(session);
		if (sessions.length) this.changed();
	}

	private async start(key: string, choice: ServerChoice, root: string): Promise<SessionState> {
		const name = path.basename(choice.argv[0] ?? choice.spec.name);
		let workspace!: ViewerWorkspace;
		let session!: SessionState;
		const client = new LSPClient({
			rootUri: pathToFileURL(root).href,
			workspace: (c) => (workspace = new ViewerWorkspace(c)),
			timeout: REQUEST_TIMEOUT_MS,
			initializationOptions: choice.spec.initializationOptions,
			sanitizeHTML: this.config.sanitizeHTML,
			extensions: [{ clientCapabilities: { window: { workDoneProgress: true } } }, serverDiagnostics()],
			notificationHandlers: {
				'$/progress': (_client, params: ProgressParams) => {
					this.progress(session, params);
					return true;
				},
			},
		});
		let resolveExit!: () => void;
		const exited = new Promise<boolean>((resolve) => { resolveExit = () => resolve(false); });
		session = {
			key, name, root, client, workspace,
			status: { kind: 'starting', name },
			transport: null,
			ready: exited,
			failedAt: 0,
			readyAt: 0,
			progress: new Map(),
			idleWaiters: [],
		};
		this.sessions.set(key, session);
		this.changed();

		const env = { ...process.env, PATH: await (this.config.path ?? serverPath)() };
		try {
			session.transport = new StdioTransport({
				argv: choice.argv,
				cwd: root,
				env,
				answer: answerServerRequest,
				onExit: (reason) => {
					resolveExit();
					this.fail(session, reason);
				},
			});
		} catch (err) {
			this.fail(session, err instanceof Error ? err.message : String(err));
			session.ready = Promise.resolve(false);
			return session;
		}
		client.connect(session.transport);
		const initialized = client.initializing.then(
			() => {
				if (session.status.kind !== 'starting') return false;
				session.readyAt = Date.now();
				session.status = this.readyStatus(session);
				this.changed();
				return true;
			},
			(err: unknown) => {
				this.fail(session, `initialization failed: ${err instanceof Error ? err.message : String(err)}`);
				session.transport?.close();
				return false;
			},
		);
		session.ready = Promise.race([initialized, exited]);
		return session;
	}

	private progress(session: SessionState, params: ProgressParams) {
		const token = String(params.token);
		const value = params.value;
		if (value?.kind === 'begin') session.progress.set(token, value.title ?? value.message ?? 'Working');
		else if (value?.kind === 'end') session.progress.delete(token);
		else return;
		if (!session.progress.size) for (const resolve of session.idleWaiters.splice(0)) resolve();
		if (session.status.kind === 'ready') {
			session.status = this.readyStatus(session);
			this.changed();
		}
	}

	private readyStatus(session: SessionState): LspStatus {
		const busy = [...session.progress.values()][0];
		return busy ? { kind: 'ready', name: session.name, busy } : { kind: 'ready', name: session.name };
	}

	private fail(session: SessionState, message: string) {
		if (session.status.kind === 'failed' || this.sessions.get(session.key) !== session) return;
		session.status = { kind: 'failed', name: session.name, message };
		session.failedAt = Date.now();
		for (const resolve of session.idleWaiters.splice(0)) resolve();
		session.client.disconnect();
		this.changed();
		this.config.onFailure?.(session.name, message);
	}

	private async shutdown(session: SessionState) {
		const transport = session.transport;
		if (!transport?.running) return;
		const timeout = new Promise((resolve) => window.setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
		try {
			await Promise.race([session.client.request('shutdown', null), timeout]);
			session.client.notification('exit', null);
		} catch { /* the process is killed below either way */ }
		session.client.disconnect();
		window.setTimeout(() => transport.close(), 200);
	}

	private changed() {
		for (const listener of this.listeners) listener();
	}
}

function sessionKey(choice: ServerChoice, root: string): string {
	return `${choice.spec.id}\0${root}\0${choice.argv.join('\0')}`;
}
