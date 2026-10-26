import { Component, ItemView, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import { EditorView } from '@codemirror/view';
import { pullRequestUrl } from '../../github/remote';
import type { PullFile, PullRequest, ReviewThread } from '../../github/types';
import type { LoadedContent } from '../../utils/content';
import { formatBytes } from '../../utils/content';
import { LatestRequest } from '../../utils/latest';
import { DiffRenderer, MessageRenderer, PaneRenderer } from '../pane/renderers';
import { GitHubViewContext, isPullRef, PullRef, repoOf } from './context';
import { threadGutter } from './threadGutter';
import { renderThread, sortThreads } from './threads';

export const PULL_REQUEST_FILE_VIEW_TYPE = 'heron-pull-request-file';

export interface PullFileState extends PullRef {
	/** Path on the head side. */
	path: string;
	/** Head-side line to scroll to once loaded. */
	line?: number;
}

function isPullFileState(state: unknown): state is PullFileState {
	return isPullRef(state) && typeof (state as Partial<PullFileState>).path === 'string';
}

interface Loaded {
	pull: PullRequest;
	file: PullFile;
	before: string;
	after: string;
	threads: ReviewThread[];
	threadError: string | null;
}

/** Why a side can't be shown, or null when it is text (or absent). */
function unreadable(content: LoadedContent): string | null {
	switch (content.kind) {
		case 'binary': return `Binary file (${formatBytes(content.size)})`;
		case 'too-large': return `Too large to show (${formatBytes(content.size)})`;
		case 'error': return content.message;
		default: return null;
	}
}

/**
 * One file of a pull request as a diff tab: the merge base against the
 * head commit, both fetched from GitHub (nothing is checked out). Review
 * threads show as gutter markers and in a list below the diff.
 */
export class PullRequestFileView extends ItemView {
	navigation = true;
	private state: PullFileState | null = null;
	private loaded: Loaded | null = null;
	private request = new LatestRequest();
	private barEl!: HTMLElement;
	private diffHost!: HTMLElement;
	private threadsEl!: HTMLElement;
	private renderer: PaneRenderer | null = null;
	private threadScope: Component | null = null;
	private layoutButton: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private ctx: GitHubViewContext) {
		super(leaf);
	}

	getViewType() { return PULL_REQUEST_FILE_VIEW_TYPE; }

	getIcon() { return 'git-pull-request'; }

	getDisplayText() {
		if (!this.state) return 'Pull request file';
		return `${path.posix.basename(this.state.path)} (#${this.state.number})`;
	}

	onload() {
		super.onload();
		this.contentEl.addClass('heron-diff-tab', 'heron-pr-file-tab');
		this.barEl = this.contentEl.createDiv({ cls: 'heron-pr-file-bar' });
		this.diffHost = this.contentEl.createDiv({ cls: 'heron-pr-file-diff' });
		this.threadsEl = this.contentEl.createDiv({ cls: 'heron-pr-file-threads' });
		this.layoutButton = this.addAction('columns-2', 'Show side by side', () => {
			this.ctx.setLayout(this.ctx.layout() === 'split' ? 'unified' : 'split');
			this.renderDiff();
		});
		this.addAction('refresh-cw', 'Refresh', () => { void this.reload(); });
		this.addAction('git-pull-request', 'Show pull request', () => {
			if (this.state) this.ctx.openPull(this.state, false);
		});
	}

	/** The pull request's page on GitHub. */
	webUrl(): string | null {
		if (!this.state) return null;
		return this.loaded?.pull.url || pullRequestUrl(repoOf(this.state), this.state.number);
	}

	getState(): Record<string, unknown> {
		if (!this.state) return super.getState();
		const { host, owner, name, number, path: file } = this.state;
		return { ...super.getState(), host, owner, name, number, path: file };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (isPullFileState(state)) {
			const prev = this.state;
			const same = prev && prev.host === state.host && prev.owner === state.owner && prev.name === state.name
				&& prev.number === state.number && prev.path === state.path;
			this.state = { host: state.host, owner: state.owner, name: state.name, number: state.number, path: state.path };
			if (typeof state.line === 'number') this.state.line = state.line;
			if (!same) await this.reload();
			else if (this.state.line) this.scrollTo('RIGHT', this.state.line);
		}
		await super.setState(state, result);
	}

	private async reload() {
		const state = this.state;
		if (!state) return;
		const token = this.request.next();
		if (!this.loaded) this.showMessage('git-pull-request', 'Loading…');
		const repo = repoOf(state);
		try {
			const client = await this.ctx.service.requireClient(state.host);
			const threadsPromise = client.reviewThreads(repo, state.number).then(
				(all) => ({ threads: all.filter((t) => t.path === state.path), error: null }),
				(err: unknown) => ({ threads: [] as ReviewThread[], error: err instanceof Error ? err.message : String(err) }),
			);
			const [pull, files] = await Promise.all([client.pull(repo, state.number), client.pullFiles(repo, state.number)]);
			const file = files.items.find((f) => f.path === state.path);
			if (!file) {
				if (this.request.isCurrent(token)) this.showMessage('file-x', 'Not in this pull request', `${state.path} is not changed by #${state.number}.`);
				return;
			}
			// GitHub shows changes since the merge base, not since the base branch's tip.
			const base = await client.mergeBase(repo, pull.baseSha, pull.headSha).catch(() => pull.baseSha);
			const missing: LoadedContent = { kind: 'missing' };
			const [before, after, threads] = await Promise.all([
				file.status === 'added' ? missing : client.fileAt(repo, file.previousPath ?? file.path, base),
				file.status === 'removed' ? missing : client.fileAt(repo, file.path, pull.headSha),
				threadsPromise,
			]);
			if (!this.request.isCurrent(token)) return;
			const problem = unreadable(before) ?? unreadable(after);
			if (problem) {
				this.loaded = null;
				this.showMessage('file-x', 'Cannot show this change', problem);
				return;
			}
			this.loaded = {
				pull,
				file,
				before: before.kind === 'text' ? before.text : '',
				after: after.kind === 'text' ? after.text : '',
				threads: sortThreads(threads.threads),
				threadError: threads.error,
			};
			this.renderBar();
			this.renderDiff();
			this.renderThreads();
			if (state.line) this.scrollTo('RIGHT', state.line);
		} catch (err) {
			if (!this.request.isCurrent(token)) return;
			this.loaded = null;
			this.showMessage('alert-circle', 'Cannot load this file', err instanceof Error ? err.message : String(err));
		}
	}

	private renderBar() {
		const loaded = this.loaded;
		this.barEl.empty();
		if (!loaded) return;
		const { pull, file } = loaded;
		this.barEl.createSpan({ cls: 'heron-pr-file-path', text: file.previousPath ? `${file.previousPath} → ${file.path}` : file.path });
		const stats = this.barEl.createSpan({ cls: 'heron-pr-file-stats' });
		stats.createSpan({ cls: 'heron-added', text: `+${file.additions}` });
		stats.createSpan({ cls: 'heron-removed', text: `−${file.deletions}` });
		this.barEl.createSpan({ cls: 'heron-pr-file-pull', text: `#${pull.number} ${pull.title}` });
		if (pull.url) this.barEl.createEl('a', { cls: 'heron-pr-link', text: 'Open on GitHub', attr: { href: `${pull.url}/files` } });
	}

	private renderDiff() {
		const loaded = this.loaded;
		const state = this.state;
		if (!loaded || !state) return;
		const layout = this.ctx.layout();
		const onSelect = (threads: ReviewThread[]) => this.revealThread(threads[0]);
		const left = loaded.threads.filter((t) => t.side === 'LEFT');
		const right = loaded.threads.filter((t) => t.side === 'RIGHT');
		this.mount(new DiffRenderer(this.diffHost, this.ctx.fontSize(), loaded.before, loaded.after, path.posix.basename(state.path), layout, this.ctx.wordWrap(), {
			original: layout === 'split' ? threadGutter(left, onSelect) : [],
			modified: threadGutter(right, onSelect),
		}));
		this.layoutButton?.setAttr('aria-label', layout === 'split' ? 'Show unified' : 'Show side by side');
	}

	private renderThreads() {
		const loaded = this.loaded;
		if (this.threadScope) this.removeChild(this.threadScope);
		const scope = this.threadScope = this.addChild(new Component());
		this.threadsEl.empty();
		if (!loaded) return;
		this.threadsEl.toggle(loaded.threads.length > 0 || !!loaded.threadError);
		if (loaded.threadError) {
			this.threadsEl.createDiv({ cls: 'heron-panel-empty', text: loaded.threadError });
			return;
		}
		const open = loaded.threads.filter((t) => !t.resolved).length;
		this.threadsEl.createDiv({ cls: 'heron-pr-file-threads-title', text: `Review threads · ${open} unresolved` });
		for (const thread of loaded.threads) {
			renderThread(this.threadsEl, thread, {
				app: this.app,
				component: scope,
				onSelect: (t) => { if (t.line !== null) this.scrollTo(t.side, t.line); },
			});
		}
	}

	/** Opens a thread in the list and scrolls it into view. */
	private revealThread(thread: ReviewThread | undefined) {
		if (!thread) return;
		const el = this.threadsEl.querySelector<HTMLDetailsElement>(`[data-thread="${CSS.escape(thread.id)}"]`);
		if (!el) return;
		el.open = true;
		el.scrollIntoView({ block: 'nearest' });
		el.addClass('is-flashing');
		window.setTimeout(() => el.removeClass('is-flashing'), 1200);
	}

	/** Scrolls the editor for `side` to `line`, when that side has an editor. */
	private scrollTo(side: ReviewThread['side'], line: number) {
		const renderer = this.renderer;
		if (!(renderer instanceof DiffRenderer)) return;
		const view = renderer.editorFor(side === 'LEFT' ? 'original' : 'modified');
		if (!view) return;
		const n = Math.min(Math.max(line, 1), view.state.doc.lines);
		view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(n).from, { y: 'center' }) });
	}

	private showMessage(icon: string, text: string, detail?: string) {
		this.barEl.empty();
		this.threadsEl.empty();
		this.threadsEl.hide();
		this.mount(new MessageRenderer(this.diffHost, icon, text, detail));
	}

	private mount(renderer: PaneRenderer) {
		if (this.renderer) this.removeChild(this.renderer);
		this.renderer = this.addChild(renderer);
	}
}
