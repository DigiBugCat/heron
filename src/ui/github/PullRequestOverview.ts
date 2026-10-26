import { App, Component, Keymap, MarkdownRenderer, setIcon } from 'obsidian';
import * as path from 'path';
import { combineChecks } from '../../github/parse';
import type { CheckItem, FileStatus, PullFile, PullRequest, ReviewThread } from '../../github/types';
import { formatDateTime, formatRelativeTime } from '../../utils/time';
import { CHECK_ICONS } from './PullRequestList';
import { renderThread, threadsByFile } from './threads';

/** A section's data, or why it could not be loaded. */
export type Section<T> = { ok: true; value: T } | { ok: false; error: string };

export interface OverviewData {
	pull: PullRequest;
	files: Section<{ items: PullFile[]; truncated: boolean }>;
	checks: Section<CheckItem[]>;
	threads: Section<ReviewThread[]>;
}

export interface OverviewOptions {
	app: App;
	/** Opens a changed file's diff; `line` scrolls to a line on the head side. */
	onOpenFile: (file: string, newTab: boolean, line?: number) => void;
	now?: () => number;
}

const STATUS_LETTER: Record<FileStatus, string> = {
	added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M', unchanged: ' ',
};

const STATE_LABEL = { open: 'Open', closed: 'Closed', merged: 'Merged' } as const;

/**
 * The body of a pull request tab: header, description, checks, changed
 * files and review threads. Read-only.
 */
export class PullRequestOverview extends Component {
	readonly el: HTMLElement;
	private scope: Component | null = null;

	constructor(parent: HTMLElement, private opts: OverviewOptions) {
		super();
		this.el = parent.createDiv({ cls: 'heron-pr-overview' });
	}

	onunload() {
		this.el.remove();
	}

	render(data: OverviewData) {
		if (this.scope) this.removeChild(this.scope);
		const scope = this.scope = this.addChild(new Component());
		this.el.empty();
		this.renderHeader(data.pull);

		const description = this.section('Description');
		if (data.pull.body.trim()) {
			void MarkdownRenderer.render(this.opts.app, data.pull.body, description.createDiv({ cls: 'markdown-rendered heron-pr-body' }), '', scope);
		} else {
			description.createDiv({ cls: 'heron-panel-empty', text: 'No description.' });
		}

		this.renderChecks(data.checks);
		this.renderFiles(data.files, data.threads.ok ? data.threads.value : []);
		this.renderThreads(data.threads);
	}

	private section(title: string, count?: string): HTMLElement {
		const el = this.el.createDiv({ cls: 'heron-pr-section' });
		const h = el.createEl('h4', { cls: 'heron-pr-section-title', text: title });
		if (count) h.createSpan({ cls: 'heron-changes-count', text: count });
		return el;
	}

	private renderHeader(pull: PullRequest) {
		const header = this.el.createDiv({ cls: 'heron-pr-header' });
		const title = header.createEl('h2', { cls: 'heron-pr-heading' });
		title.createSpan({ text: pull.title });
		title.createSpan({ cls: 'heron-pr-heading-number', text: ` #${pull.number}` });
		const meta = header.createDiv({ cls: 'heron-pr-meta' });
		const state = pull.draft && pull.state === 'open' ? 'Draft' : STATE_LABEL[pull.state];
		meta.createSpan({ cls: `heron-pr-state is-${pull.draft && pull.state === 'open' ? 'draft' : pull.state}`, text: state });
		meta.createSpan({ cls: 'heron-pr-author', text: pull.author });
		const branches = meta.createSpan({ cls: 'heron-pr-branches' });
		branches.createSpan({ cls: 'heron-pr-branch', text: pull.baseRef });
		branches.appendText(' ← ');
		// Branches from forks are shown with the fork's name.
		const head = pull.headRepo && pull.headRepo !== pull.baseRepo ? `${pull.headRepo}:${pull.headRef}` : pull.headRef;
		branches.createSpan({ cls: 'heron-pr-branch', text: head });
		const updated = meta.createSpan({ cls: 'heron-pr-age', text: `updated ${formatRelativeTime(pull.updatedAt, this.opts.now?.())}` });
		updated.setAttr('title', formatDateTime(pull.updatedAt));
		if (pull.url) {
			const link = meta.createEl('a', { cls: 'heron-pr-link', text: 'Open on GitHub', attr: { href: pull.url } });
			setIcon(link.createSpan({ cls: 'heron-pr-link-icon' }), 'external-link');
		}
	}

	private renderChecks(checks: Section<CheckItem[]>) {
		if (!checks.ok) {
			this.section('Checks').createDiv({ cls: 'heron-panel-empty', text: checks.error });
			return;
		}
		const items = checks.value;
		const overall = combineChecks(items.map((c) => c.state));
		const failing = items.filter((c) => c.state === 'failure').length;
		const summary = !items.length ? undefined : failing ? `${failing} failing` : overall === 'pending' ? 'running' : `${items.length}`;
		const el = this.section('Checks', summary);
		if (!items.length) {
			el.createDiv({ cls: 'heron-panel-empty', text: 'No checks.' });
			return;
		}
		const order = { failure: 0, pending: 1, neutral: 2, success: 3, none: 4 };
		for (const check of [...items].sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name))) {
			const row = el.createDiv({ cls: 'heron-check' });
			const icon = row.createSpan({ cls: `heron-pr-check is-${check.state}` });
			const info = CHECK_ICONS[check.state];
			if (info) setIcon(icon, info.icon);
			const name = check.url
				? row.createEl('a', { cls: 'heron-check-name', text: check.name, attr: { href: check.url } })
				: row.createSpan({ cls: 'heron-check-name', text: check.name });
			name.title = check.name;
			if (check.description) row.createSpan({ cls: 'heron-check-detail', text: check.description });
		}
	}

	private renderFiles(files: Section<{ items: PullFile[]; truncated: boolean }>, threads: ReviewThread[]) {
		if (!files.ok) {
			this.section('Files changed').createDiv({ cls: 'heron-panel-empty', text: files.error });
			return;
		}
		const { items, truncated } = files.value;
		const el = this.section('Files changed', String(items.length));
		const unresolved = new Map<string, number>();
		for (const t of threads) if (!t.resolved) unresolved.set(t.path, (unresolved.get(t.path) ?? 0) + 1);
		for (const file of items) {
			const row = el.createDiv({
				cls: `heron-pr-file tree-item-self is-clickable is-${file.status}`,
				attr: { role: 'button', tabindex: '0', 'data-path': file.path },
			});
			row.createSpan({ cls: 'heron-change-letter', text: STATUS_LETTER[file.status] });
			row.createSpan({ cls: 'heron-change-name', text: path.posix.basename(file.path) });
			const dir = path.posix.dirname(file.path);
			if (dir !== '.') row.createSpan({ cls: 'heron-change-dir', text: dir });
			const count = unresolved.get(file.path);
			if (count) {
				const t = row.createSpan({ cls: 'heron-pr-threads' });
				setIcon(t.createSpan(), 'message-square');
				t.createSpan({ text: String(count) });
			}
			const stats = row.createSpan({ cls: 'heron-pr-file-stats' });
			stats.createSpan({ cls: 'heron-added', text: `+${file.additions}` });
			stats.createSpan({ cls: 'heron-removed', text: `−${file.deletions}` });
			row.title = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
			const open = (evt: MouseEvent | KeyboardEvent) => this.opts.onOpenFile(file.path, Keymap.isModEvent(evt) !== false);
			this.scope?.registerDomEvent(row, 'click', open);
			this.scope?.registerDomEvent(row, 'keydown', (evt) => { if (evt.key === 'Enter') open(evt); });
		}
		if (truncated) el.createDiv({ cls: 'heron-panel-empty', text: 'GitHub lists at most 3,000 files.' });
	}

	private renderThreads(threads: Section<ReviewThread[]>) {
		if (!threads.ok) {
			this.section('Review threads').createDiv({ cls: 'heron-panel-empty', text: threads.error });
			return;
		}
		const open = threads.value.filter((t) => !t.resolved).length;
		const el = this.section('Review threads', threads.value.length ? `${open} unresolved` : undefined);
		if (!threads.value.length) {
			el.createDiv({ cls: 'heron-panel-empty', text: 'No review threads.' });
			return;
		}
		const scope = this.scope;
		if (!scope) return;
		for (const [file, list] of threadsByFile(threads.value)) {
			const group = el.createDiv({ cls: 'heron-thread-file' });
			const name = group.createDiv({ cls: 'heron-thread-file-name is-clickable', text: file, attr: { role: 'button', tabindex: '0' } });
			this.scope?.registerDomEvent(name, 'click', (evt) => this.opts.onOpenFile(file, Keymap.isModEvent(evt) !== false));
			for (const thread of list) {
				renderThread(group, thread, {
					app: this.opts.app,
					component: scope,
					now: this.opts.now,
					onSelect: (t) => this.opts.onOpenFile(t.path, false, t.side === 'RIGHT' && t.line !== null ? t.line : undefined),
				});
			}
		}
	}
}
