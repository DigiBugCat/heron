import { ItemView, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { pullRequestUrl } from '../../github/remote';
import type { PullRequest } from '../../github/types';
import { LatestRequest } from '../../utils/latest';
import { MessageRenderer } from '../pane/renderers';
import { GitHubViewContext, isPullRef, PullRef, repoOf } from './context';
import { PullRequestOverview, Section } from './PullRequestOverview';

export const PULL_REQUEST_VIEW_TYPE = 'heron-pull-request';

async function settle<T>(promise: Promise<T>): Promise<Section<T>> {
	try {
		return { ok: true, value: await promise };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * A pull request as a tab: title, state, branches, description, checks,
 * changed files and review threads. Selecting a file opens its diff.
 */
export class PullRequestView extends ItemView {
	navigation = true;
	private ref: PullRef | null = null;
	private pull: PullRequest | null = null;
	private request = new LatestRequest();
	private overview: PullRequestOverview | null = null;
	private message: MessageRenderer | null = null;

	constructor(leaf: WorkspaceLeaf, private ctx: GitHubViewContext) {
		super(leaf);
	}

	getViewType() { return PULL_REQUEST_VIEW_TYPE; }

	getIcon() { return 'git-pull-request'; }

	getDisplayText() {
		if (!this.ref) return 'Pull request';
		return this.pull ? `#${this.ref.number} ${this.pull.title}` : `#${this.ref.number}`;
	}

	onload() {
		super.onload();
		this.contentEl.addClass('heron-pr-tab');
		this.addAction('refresh-cw', 'Refresh', () => { void this.reload(); });
		this.addAction('external-link', 'Open on GitHub', () => {
			const url = this.webUrl();
			if (url) activeWindow.open(url);
		});
	}

	/** The pull request's page on GitHub. */
	webUrl(): string | null {
		if (!this.ref) return null;
		return this.pull?.url || pullRequestUrl(repoOf(this.ref), this.ref.number);
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), ...(this.ref ?? {}) };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (isPullRef(state)) {
			const { host, owner, name, number } = state;
			const same = this.ref && this.ref.host === host && this.ref.owner === owner && this.ref.name === name && this.ref.number === number;
			this.ref = { host, owner, name, number };
			if (!same) {
				this.pull = null;
				await this.reload();
			}
		}
		await super.setState(state, result);
	}

	private async reload() {
		const ref = this.ref;
		if (!ref) return;
		const token = this.request.next();
		if (!this.overview) this.showMessage('git-pull-request', 'Loading pull request…');
		const repo = repoOf(ref);
		try {
			const client = await this.ctx.service.requireClient(ref.host);
			// Files and threads don't need the head commit; start them right away.
			const files = settle(client.pullFiles(repo, ref.number));
			const threads = settle(client.reviewThreads(repo, ref.number));
			const pull = await client.pull(repo, ref.number);
			const checks = settle(client.checks(repo, pull.headSha));
			const data = { pull, files: await files, threads: await threads, checks: await checks };
			if (!this.request.isCurrent(token)) return;
			this.pull = pull;
			this.clearMessage();
			this.overview ??= this.addChild(new PullRequestOverview(this.contentEl, {
				app: this.app,
				onOpenFile: (file, newTab, line) => {
					if (this.ref) this.ctx.openPullFile(this.ref, file, newTab, line);
				},
			}));
			this.overview.render(data);
		} catch (err) {
			if (!this.request.isCurrent(token)) return;
			this.showMessage('alert-circle', 'Cannot load pull request', err instanceof Error ? err.message : String(err));
		}
	}

	private showMessage(icon: string, text: string, detail?: string) {
		if (this.overview) {
			this.removeChild(this.overview);
			this.overview = null;
		}
		this.clearMessage();
		this.message = this.addChild(new MessageRenderer(this.contentEl, icon, text, detail));
	}

	private clearMessage() {
		if (this.message) this.removeChild(this.message);
		this.message = null;
	}
}
