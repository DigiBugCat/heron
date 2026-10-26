/**
 * Recognising GitHub repositories from git remote URLs, and where each
 * host's API lives. Pure functions: no I/O, no Obsidian.
 */

/** A repository on github.com or a GitHub Enterprise host. */
export interface GitHubRepoRef {
	/** Lower-case host name, with the port for HTTPS remotes on a non-default port. */
	host: string;
	owner: string;
	name: string;
}

/** Where a host's REST and GraphQL APIs and its web pages are. */
export interface HostEndpoints {
	rest: string;
	graphql: string;
	web: string;
}

export const GITHUB_COM = 'github.com';

/** Hosts that serve git but are not GitHub. */
const NOT_GITHUB = new Set([
	'gitlab.com', 'bitbucket.org', 'codeberg.org', 'dev.azure.com', 'ssh.dev.azure.com',
	'vs-ssh.visualstudio.com', 'git.sr.ht', 'gitee.com', 'sourceforge.net', 'huggingface.co',
]);

/** First labels of self-hosted forges that are not GitHub, e.g. `gitlab.example.com`. */
const NOT_GITHUB_PREFIXES = ['gitlab', 'bitbucket', 'gitea', 'forgejo', 'gogs'];

/** Aliases of github.com that appear in remotes. */
const GITHUB_ALIASES = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

/**
 * Parses a remote URL in any of git's forms: `https://host/owner/name(.git)`,
 * `ssh://[user@]host[:port]/owner/name(.git)`, `git://…`, and the scp-like
 * `[user@]host:owner/name(.git)`. Returns null for local paths, URLs with
 * no owner/name pair, and hosts known not to be GitHub.
 */
export function parseRemoteUrl(url: string): GitHubRepoRef | null {
	const raw = url.trim();
	if (!raw) return null;
	let host: string;
	let repoPath: string;

	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
	if (scheme) {
		const protocol = (scheme[1] ?? '').toLowerCase();
		if (protocol === 'file') return null;
		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch {
			return null;
		}
		const isHttp = protocol === 'http' || protocol === 'https';
		// The SSH port says nothing about where the API is; an HTTPS port does.
		host = isHttp && parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
		repoPath = decodeURIComponent(parsed.pathname);
	} else {
		// scp-like syntax: [user@]host:path, where path does not start with '/'
		// (that would be a local path such as C:/repo or /srv/repo.git).
		const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(raw);
		if (!scp) return null;
		host = scp[1] ?? '';
		repoPath = scp[2] ?? '';
		// A single letter before ':' is a Windows drive, not a host.
		if (host.length === 1) return null;
	}

	host = normalizeHost(host);
	if (!host || !isPossiblyGitHub(host)) return null;
	const parts = repoPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
	// GitHub repositories are exactly owner/name; GHE may serve under a path prefix
	// for git, but its API addresses repositories by the last two segments.
	if (parts.length < 2) return null;
	const owner = parts[parts.length - 2] ?? '';
	const name = parts[parts.length - 1] ?? '';
	if (!isValidSegment(owner) || !isValidSegment(name)) return null;
	return { host, owner, name };
}

function normalizeHost(host: string): string {
	const lower = host.toLowerCase().replace(/\.$/, '');
	// `github.com-work` is a common ~/.ssh/config alias for a second account.
	return GITHUB_ALIASES.has(lower) || /^github\.com[-_]/.test(lower) ? GITHUB_COM : lower;
}

function isValidSegment(s: string): boolean {
	return /^[A-Za-z0-9_.-]+$/.test(s) && s !== '.' && s !== '..';
}

/**
 * Whether `host` may be a GitHub host: github.com, or any host not known to
 * run another forge (a GitHub Enterprise server can have any name). Heron
 * only talks to an Enterprise host once it has a token for it.
 */
export function isPossiblyGitHub(host: string): boolean {
	const bare = host.replace(/:\d+$/, '');
	if (bare === GITHUB_COM) return true;
	if (NOT_GITHUB.has(bare)) return false;
	const first = bare.split('.')[0] ?? '';
	if (NOT_GITHUB_PREFIXES.includes(first)) return false;
	// Single-label names are usually SSH aliases from ~/.ssh/config, not hosts.
	return bare.includes('.') || bare === 'localhost';
}

/** True for github.com; false for GitHub Enterprise Server and Cloud hosts. */
export function isGitHubCom(host: string): boolean {
	return host === GITHUB_COM;
}

/**
 * API and web bases for `host`: `api.github.com` for github.com,
 * `api.<host>` for GitHub Enterprise Cloud with data residency (`*.ghe.com`),
 * and `https://<host>/api/v3` and `/api/graphql` for GitHub Enterprise Server.
 */
export function endpointsFor(host: string): HostEndpoints {
	const web = `https://${host}`;
	if (host === GITHUB_COM) return { rest: 'https://api.github.com', graphql: 'https://api.github.com/graphql', web };
	if (host.endsWith('.ghe.com')) return { rest: `https://api.${host}`, graphql: `https://api.${host}/graphql`, web };
	return { rest: `${web}/api/v3`, graphql: `${web}/api/graphql`, web };
}

/** `owner/name`, for display and keys. */
export function repoSlug(ref: GitHubRepoRef): string {
	return `${ref.owner}/${ref.name}`;
}

/** The web page of pull request `number`. */
export function pullRequestUrl(ref: GitHubRepoRef, number: number): string {
	return `${endpointsFor(ref.host).web}/${ref.owner}/${ref.name}/pull/${number}`;
}
