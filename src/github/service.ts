import { GitRepo } from '../git/GitRepo';
import type { TokenResolver, TokenSource } from './auth';
import { GitHubClient, GitHubError, Transport } from './client';
import { GitHubRepoRef, parseRemoteUrl } from './remote';

/** Result of "Test connection". */
export type ConnectionResult =
	| { ok: true; login: string; source: TokenSource }
	| { ok: false; message: string; source: TokenSource };

/**
 * Clients per host and GitHub repositories per local repository. Nothing
 * here contacts GitHub until a view asks for data.
 */
export class GitHubService {
	private clients = new Map<string, { token: string; client: GitHubClient }>();
	private remotes = new Map<string, Promise<GitHubRepoRef | null>>();

	constructor(
		readonly tokens: TokenResolver,
		private transport: Transport,
		/** Reads the `origin` URL of the repository at `root`; injectable for tests. */
		private readRemote: (root: string) => Promise<string | null> = readOriginUrl,
	) {}

	/** The GitHub repository `origin` points to, or null for other remotes. Cached per root. */
	repoFor(root: string): Promise<GitHubRepoRef | null> {
		let pending = this.remotes.get(root);
		if (!pending) {
			pending = this.readRemote(root).then((url) => (url ? parseRemoteUrl(url) : null)).catch(() => null);
			this.remotes.set(root, pending);
		}
		return pending;
	}

	/** Forgets cached remotes, e.g. after repositories were added or removed. */
	forgetRemotes() {
		this.remotes.clear();
	}

	/** A client for `host`, or null when there is no token for it. */
	async client(host: string): Promise<GitHubClient | null> {
		const { token } = await this.tokens.resolve(host);
		if (!token) {
			this.clients.delete(host);
			return null;
		}
		const existing = this.clients.get(host);
		if (existing && existing.token === token) return existing.client;
		const client = new GitHubClient({ host, token, transport: this.transport });
		this.clients.set(host, { token, client });
		return client;
	}

	/** A client for `host`, or an error explaining how to connect. */
	async requireClient(host: string): Promise<GitHubClient> {
		const client = await this.client(host);
		if (!client) {
			throw new GitHubError('auth', `Heron has no token for ${host}. Paste one in Settings → Heron → GitHub, or run "gh auth login --hostname ${host}" in a terminal.`);
		}
		return client;
	}

	/** Drops cached clients and CLI tokens so the next request resolves the token again. */
	reset(host?: string) {
		this.tokens.forget(host);
		if (host) this.clients.delete(host);
		else this.clients.clear();
	}

	/** Checks the token for `host` by asking GitHub who it belongs to (`GET /user`). */
	async testConnection(host: string): Promise<ConnectionResult> {
		this.reset(host);
		const { source } = await this.tokens.resolve(host);
		try {
			const client = await this.requireClient(host);
			return { ok: true, login: await client.viewer(), source };
		} catch (err) {
			return { ok: false, message: err instanceof Error ? err.message : String(err), source };
		}
	}
}

/** `git remote get-url origin` for the repository at `root` (read-only). */
async function readOriginUrl(root: string): Promise<string | null> {
	const opened = await GitRepo.open(root);
	if (opened.kind !== 'repo') return null;
	return opened.repo.remoteUrl('origin');
}
