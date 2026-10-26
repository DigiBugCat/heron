import { App, requestUrl } from 'obsidian';
import type HeronPlugin from '../../main';
import { ghTokenReader, SecretStorageLike, TokenResolver, tokenStoreFor } from '../../github/auth';
import type { HttpRequest, HttpResponse, Transport } from '../../github/client';
import { GitHubService } from '../../github/service';
import type { DiffLayout } from '../../settings';
import type { GitHubViewContext, PullRef, VaultGitHubRepo } from './context';
import { PULL_REQUEST_FILE_VIEW_TYPE, PullRequestFileView } from './PullRequestFileView';
import { PULL_REQUESTS_VIEW_TYPE, PullRequestsView } from './PullRequestsView';
import { PULL_REQUEST_VIEW_TYPE, PullRequestView } from './PullRequestView';

/** Sends GitHub API requests with Obsidian's `requestUrl` (no CORS limits, works for Enterprise hosts). */
export const obsidianTransport: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
	const headers = { ...req.headers };
	const contentType = headers['Content-Type'];
	delete headers['Content-Type'];
	const res = await requestUrl({ url: req.url, method: req.method, headers, body: req.body, contentType, throw: false });
	return { status: res.status, headers: res.headers, text: res.text, arrayBuffer: res.arrayBuffer };
};

/**
 * Pull requests from GitHub and GitHub Enterprise: the **Pull requests**
 * panel, pull request and file diff tabs, and the views' access to the
 * vault's repositories. GitHub is only contacted while these are in use.
 */
export class GitHubFeature implements GitHubViewContext {
	readonly service: GitHubService;
	private lastRepoKey = '';

	constructor(private plugin: HeronPlugin) {
		// Obsidian before 1.11.4 has no secret storage; the store then falls back to a private file.
		const app = plugin.app as unknown as { secretStorage?: SecretStorageLike };
		this.service = new GitHubService(new TokenResolver(tokenStoreFor(app), ghTokenReader()), obsidianTransport);
	}

	get app(): App {
		return this.plugin.app;
	}

	/** Registers the panel and tab views. */
	register() {
		this.plugin.registerView(PULL_REQUESTS_VIEW_TYPE, (leaf) => new PullRequestsView(leaf, this));
		this.plugin.registerView(PULL_REQUEST_VIEW_TYPE, (leaf) => new PullRequestView(leaf, this));
		this.plugin.registerView(PULL_REQUEST_FILE_VIEW_TYPE, (leaf) => new PullRequestFileView(leaf, this));
	}

	async repos(): Promise<VaultGitHubRepo[]> {
		const loaded = (this.plugin.vaultGit?.vaultRepos() ?? []).flatMap(({ rel, snapshot }) => (snapshot.kind === 'repo' ? [{ rel, snapshot }] : []));
		// Re-read remotes when repositories come or go.
		const key = loaded.map((r) => r.snapshot.repo.root).join('\n');
		if (key !== this.lastRepoKey) {
			this.lastRepoKey = key;
			this.service.forgetRemotes();
		}
		const repos = await Promise.all(loaded.map(async ({ rel, snapshot }) => {
			const ref = await this.service.repoFor(snapshot.repo.root);
			return ref ? { rel, ref, branch: snapshot.status.branch.head ?? null } : null;
		}));
		return repos.filter((r): r is VaultGitHubRepo => r !== null);
	}

	async repoOfActiveFile(): Promise<VaultGitHubRepo | null> {
		const file = this.app.workspace.getActiveFile()?.path;
		if (!file) return null;
		const matches = (await this.repos()).filter((r) => file.startsWith(`${r.rel}/`));
		// The innermost repository wins for nested ones.
		return matches.sort((a, b) => b.rel.length - a.rel.length)[0] ?? null;
	}

	onReposChange(listener: () => void): () => void {
		return this.plugin.vaultGit?.onChange(listener) ?? (() => undefined);
	}

	openPull(pull: PullRef, newTab: boolean) {
		const { host, owner, name, number } = pull;
		void this.app.workspace.getLeaf(newTab ? 'tab' : false)
			.setViewState({ type: PULL_REQUEST_VIEW_TYPE, state: { host, owner, name, number }, active: true });
	}

	openPullFile(pull: PullRef, file: string, newTab: boolean, line?: number) {
		const { host, owner, name, number } = pull;
		const state: Record<string, unknown> = { host, owner, name, number, path: file };
		if (line) state.line = line;
		void this.app.workspace.getLeaf(newTab ? 'tab' : false).setViewState({ type: PULL_REQUEST_FILE_VIEW_TYPE, state, active: true });
	}

	fontSize() { return this.plugin.settings.fontSize; }

	wordWrap() { return this.plugin.settings.wordWrap; }

	layout() { return this.plugin.settings.diffLayout; }

	setLayout(layout: DiffLayout) {
		this.plugin.settings.diffLayout = layout;
		void this.plugin.saveSettings();
	}

	/** The open **Pull requests** panel, if any. */
	panel(): PullRequestsView | null {
		const view = this.app.workspace.getLeavesOfType(PULL_REQUESTS_VIEW_TYPE)[0]?.view;
		return view instanceof PullRequestsView ? view : null;
	}
}
