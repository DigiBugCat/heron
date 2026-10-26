import { ItemView, setIcon, WorkspaceLeaf } from 'obsidian';
import { GitHubError } from '../../github/client';
import { repoSlug } from '../../github/remote';
import type { PullSummary } from '../../github/types';
import { LatestRequest } from '../../utils/latest';
import type { GitHubViewContext, VaultGitHubRepo } from './context';
import { PullRequestList } from './PullRequestList';

export const PULL_REQUESTS_VIEW_TYPE = 'heron-pull-requests';

/** Focus refreshes are skipped while the list is younger than this. */
const FOCUS_REFRESH_MS = 60_000;

interface Loaded {
	viewer: string;
	summaries: PullSummary[];
	truncated: boolean;
	at: number;
}

function repoKey(repo: VaultGitHubRepo): string {
	return `${repo.ref.host}/${repoSlug(repo.ref)}`;
}

/**
 * Right-sidebar list of open pull requests for the repository of the active
 * file, or one picked from the menu. Loads when shown, when Obsidian regains
 * focus (at most once a minute) and on demand — it never polls.
 */
export class PullRequestsView extends ItemView {
	private repos: VaultGitHubRepo[] = [];
	private current: VaultGitHubRepo | null = null;
	private cache = new Map<string, Loaded>();
	private request = new LatestRequest();
	private list!: PullRequestList;
	private pickerEl!: HTMLSelectElement;
	private titleEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private ctx: GitHubViewContext) {
		super(leaf);
	}

	getViewType() { return PULL_REQUESTS_VIEW_TYPE; }

	getDisplayText() { return 'Pull requests'; }

	getIcon() { return 'git-pull-request'; }

	onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('heron-panel');
		const header = this.contentEl.createDiv({ cls: 'heron-prs-header' });
		this.titleEl = header.createSpan({ cls: 'heron-prs-repo' });
		this.pickerEl = header.createEl('select', { cls: 'dropdown heron-prs-picker', attr: { 'aria-label': 'Repository' } });
		const refresh = header.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'Refresh' } });
		setIcon(refresh, 'refresh-cw');
		this.registerDomEvent(refresh, 'click', () => { void this.loadPulls(true); });
		this.registerDomEvent(this.pickerEl, 'change', () => {
			const picked = this.repos.find((r) => repoKey(r) === this.pickerEl.value);
			if (picked) this.select(picked);
		});
		this.list = this.addChild(new PullRequestList(this.contentEl, {
			onOpen: (pull, newTab) => {
				if (this.current) this.ctx.openPull({ ...this.current.ref, number: pull.number }, newTab);
			},
		}));

		this.app.workspace.onLayoutReady(() => {
			this.register(this.ctx.onReposChange(() => { void this.updateRepos(); }));
			void this.updateRepos();
		});
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
			if (leaf === this.leaf) void this.loadPulls(false, FOCUS_REFRESH_MS);
			else void this.followActiveFile();
		}));
		this.registerDomEvent(activeWindow, 'focus', () => {
			if (this.isVisible()) void this.loadPulls(false, FOCUS_REFRESH_MS);
		});
		return Promise.resolve();
	}

	/** The repository whose pull requests are shown. */
	currentRepo(): VaultGitHubRepo | null {
		return this.current;
	}

	/** Reloads the list now. */
	refresh() {
		void this.loadPulls(true);
	}

	private isVisible(): boolean {
		return this.contentEl.isShown();
	}

	private async updateRepos() {
		const repos = await this.ctx.repos();
		this.repos = repos;
		this.pickerEl.empty();
		for (const repo of repos) this.pickerEl.createEl('option', { text: repoSlug(repo.ref), attr: { value: repoKey(repo) } });
		this.pickerEl.toggle(repos.length > 1);
		// Keep the shown repository (refreshed, e.g. for a new branch) so git activity
		// never undoes a pick from the menu; switching follows the active file instead.
		const shown = this.current && repos.find((r) => repoKey(r) === repoKey(this.current as VaultGitHubRepo));
		const next = shown ?? await this.ctx.repoOfActiveFile() ?? repos[0] ?? null;
		if (!next) {
			this.current = null;
			this.titleEl.setText('');
			this.list.show({
				kind: 'message',
				text: 'No GitHub repositories in this vault.',
				detail: 'Pull requests appear for repositories in the vault whose origin remote is on GitHub or GitHub Enterprise.',
			});
			return;
		}
		this.select(next);
	}

	private async followActiveFile() {
		const active = await this.ctx.repoOfActiveFile();
		if (active && (!this.current || repoKey(active) !== repoKey(this.current))) this.select(active);
	}

	private select(repo: VaultGitHubRepo) {
		const changed = !this.current || repoKey(repo) !== repoKey(this.current);
		this.current = repo;
		this.titleEl.setText(repoSlug(repo.ref));
		this.titleEl.title = `${repo.ref.host}/${repoSlug(repo.ref)}`;
		this.pickerEl.value = repoKey(repo);
		if (!changed) return;
		const cached = this.cache.get(repoKey(repo));
		if (cached) this.list.show({ kind: 'pulls', ...cached });
		// Only contact GitHub while the panel is on screen.
		if (this.isVisible()) void this.loadPulls(false, FOCUS_REFRESH_MS);
		else if (!cached) this.list.show({ kind: 'loading' });
	}

	/** Shown again (e.g. its sidebar tab was selected): load if the list is stale. */
	onResize() {
		if (this.current && this.isVisible()) void this.loadPulls(false, FOCUS_REFRESH_MS);
	}

	/**
	 * Loads the current repository's pull requests. Without `force`, a list
	 * younger than `maxAge` ms is kept.
	 */
	private async loadPulls(force: boolean, maxAge = 0) {
		const repo = this.current;
		if (!repo) return;
		const key = repoKey(repo);
		const cached = this.cache.get(key);
		if (!force && cached && Date.now() - cached.at < maxAge) return;
		const token = this.request.next();
		if (!cached) this.list.show({ kind: 'loading' });
		const retry = () => { void this.loadPulls(true); };
		try {
			const client = await this.ctx.service.client(repo.ref.host);
			if (!this.request.isCurrent(token)) return;
			if (!client) {
				this.list.show({
					kind: 'message',
					text: `Connect to ${repo.ref.host}`,
					detail: `Run "gh auth login --hostname ${repo.ref.host}" in a terminal, or paste a token in Settings → Heron → GitHub.`,
					retry,
				});
				return;
			}
			const result = await client.pullSummaries(repo.ref);
			if (!this.request.isCurrent(token)) return;
			const loaded: Loaded = { ...result, at: Date.now() };
			this.cache.set(key, loaded);
			this.list.show({ kind: 'pulls', ...loaded });
		} catch (err) {
			if (!this.request.isCurrent(token)) return;
			const text = err instanceof GitHubError && err.kind === 'rate-limit' ? 'Rate limit reached' : 'Cannot load pull requests';
			this.list.show({ kind: 'message', text, detail: err instanceof Error ? err.message : String(err), retry });
		}
	}
}
