import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { serverPath } from '../lsp/shellEnv';

/**
 * GitHub tokens, per host. A token pasted in settings wins; otherwise Heron
 * asks the GitHub CLI (`gh auth token`). Pasted tokens go to Obsidian's
 * secret storage (the system keychain) when the app has it, else to a
 * private file in the user's config folder — never to the vault or
 * `data.json`. Tokens are never logged or shown.
 */

export type TokenSource = 'settings' | 'gh' | 'none';

export interface ResolvedToken {
	token: string | null;
	source: TokenSource;
}

/** Where pasted tokens are kept. */
export interface TokenStore {
	/** 'keychain' for Obsidian's secret storage, 'file' for the fallback file. */
	readonly kind: 'keychain' | 'file';
	get(host: string): Promise<string | null>;
	/** Saves `token`; an empty string removes it. */
	set(host: string, token: string): Promise<void>;
}

/** The part of Obsidian's `SecretStorage` (1.11.4+) Heron uses. */
export interface SecretStorageLike {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
}

/** Secret storage IDs are lower-case letters, digits and dashes. */
export function secretId(host: string): string {
	return `heron-github-${host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

/** Keeps tokens in Obsidian's secret storage. */
export function secretStorageStore(storage: SecretStorageLike): TokenStore {
	return {
		kind: 'keychain',
		get: (host) => Promise.resolve(storage.getSecret(secretId(host)) || null),
		set: (host, token) => {
			// SecretStorage has no delete; an empty secret means none.
			storage.setSecret(secretId(host), token);
			return Promise.resolve();
		},
	};
}

/** The fallback token file: `~/.config/heron/github-tokens.json` (or `%APPDATA%\heron\…` on Windows). */
export function defaultTokenFile(): string {
	const configDir = process.platform === 'win32'
		? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
		: process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
	return path.join(configDir, 'heron', 'github-tokens.json');
}

/** Keeps tokens in a JSON file readable only by the user, outside the vault. */
export function fileTokenStore(file = defaultTokenFile()): TokenStore {
	const read = async (): Promise<Record<string, string>> => {
		try {
			const data = JSON.parse(await fsp.readFile(file, 'utf-8')) as unknown;
			if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
			return Object.fromEntries(Object.entries(data as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
		} catch {
			return {};
		}
	};
	return {
		kind: 'file',
		get: async (host) => (await read())[host] || null,
		set: async (host, token) => {
			const tokens = await read();
			if (token) tokens[host] = token;
			else delete tokens[host];
			await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
			await fsp.writeFile(file, JSON.stringify(tokens, null, '\t'), { mode: 0o600 });
			// writeFile keeps the mode of an existing file; make sure it is private.
			await fsp.chmod(file, 0o600).catch(() => undefined);
		},
	};
}

/** Picks secret storage when Obsidian has it (1.11.4+), else the private file. */
export function tokenStoreFor(app: { secretStorage?: SecretStorageLike }): TokenStore {
	const storage = app.secretStorage;
	if (storage && typeof storage.getSecret === 'function' && typeof storage.setSecret === 'function') {
		return secretStorageStore(storage);
	}
	return fileTokenStore();
}

/** Asks for the GitHub CLI's token for a host; resolves null when there is none. */
export type GhTokenReader = (host: string) => Promise<string | null>;

type ExecFn = (
	file: string,
	args: string[],
	options: { env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean },
	callback: (err: Error | null, stdout: string) => void,
) => void;

const GH_TIMEOUT_MS = 10000;

/**
 * Runs `gh auth token --hostname <host>` with the login shell's PATH, since
 * Obsidian started from the Dock has a minimal one. Missing `gh`, no login
 * for the host, or a timeout all resolve to null.
 */
export function ghTokenReader(
	exec: ExecFn = (file, args, options, cb) => { execFile(file, args, { ...options, encoding: 'utf-8' }, (err, stdout) => cb(err, stdout)); },
	pathFor: () => Promise<string> = serverPath,
): GhTokenReader {
	return async (host) => {
		const PATH = await pathFor();
		return new Promise((resolve) => {
			exec('gh', ['auth', 'token', '--hostname', host], { env: { ...process.env, PATH }, timeout: GH_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
				const token = err ? '' : stdout.trim();
				resolve(token && !/\s/.test(token) ? token : null);
			});
		});
	};
}

/**
 * Resolves the token for each host: a pasted one first, then the GitHub
 * CLI's. The CLI is asked once per host until `forget` is called.
 */
export class TokenResolver {
	private ghCache = new Map<string, Promise<string | null>>();

	constructor(private store: TokenStore, private gh: GhTokenReader) {}

	get storeKind(): TokenStore['kind'] { return this.store.kind; }

	async resolve(host: string): Promise<ResolvedToken> {
		const pasted = await this.store.get(host).catch(() => null);
		if (pasted) return { token: pasted, source: 'settings' };
		let pending = this.ghCache.get(host);
		if (!pending) {
			pending = this.gh(host).catch(() => null);
			this.ghCache.set(host, pending);
		}
		const fromGh = await pending;
		if (fromGh) return { token: fromGh, source: 'gh' };
		return { token: null, source: 'none' };
	}

	/** Saves a pasted token for `host`; an empty string removes it. */
	async save(host: string, token: string) {
		await this.store.set(host, token.trim());
		this.forget(host);
	}

	/** Asks the GitHub CLI again next time (all hosts when `host` is omitted). */
	forget(host?: string) {
		if (host) this.ghCache.delete(host);
		else this.ghCache.clear();
	}
}
