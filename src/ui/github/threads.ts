import { App, Component, MarkdownRenderer, setIcon } from 'obsidian';
import type { ReviewThread } from '../../github/types';
import { formatDateTime, formatRelativeTime } from '../../utils/time';

export interface ThreadRenderOptions {
	app: App;
	/** Owns the rendered markdown. */
	component: Component;
	/** Called when the thread's location is selected. */
	onSelect?: (thread: ReviewThread) => void;
	now?: () => number;
}

/** "line 12" or "lines 10–12", with "(old)" for the base side. */
export function threadLocation(thread: ReviewThread): string {
	if (thread.line === null) return 'file';
	const lines = thread.startLine !== null ? `lines ${thread.startLine}–${thread.line}` : `line ${thread.line}`;
	return thread.side === 'LEFT' ? `${lines} (old)` : lines;
}

/** Unresolved threads first, then by line. */
export function sortThreads(threads: ReviewThread[]): ReviewThread[] {
	return [...threads].sort((a, b) => Number(a.resolved) - Number(b.resolved) || (a.line ?? 0) - (b.line ?? 0));
}

/**
 * One review thread: open when unresolved, collapsed when resolved. Each
 * comment shows its author, age and markdown body. Read-only.
 */
export function renderThread(parent: HTMLElement, thread: ReviewThread, opts: ThreadRenderOptions): HTMLDetailsElement {
	const details = parent.createEl('details', { cls: 'heron-thread', attr: { 'data-thread': thread.id } });
	details.toggleClass('is-resolved', thread.resolved);
	details.open = !thread.resolved;
	const summary = details.createEl('summary', { cls: 'heron-thread-summary' });
	const where = summary.createSpan({ cls: 'heron-thread-where', text: threadLocation(thread) });
	if (opts.onSelect && thread.line !== null) {
		where.addClass('is-clickable');
		where.setAttr('aria-label', 'Show in diff');
		const select = opts.onSelect;
		opts.component.registerDomEvent(where, 'click', (evt) => {
			evt.preventDefault();
			select(thread);
		});
	}
	const first = thread.comments[0];
	if (first) summary.createSpan({ cls: 'heron-thread-author', text: first.author });
	if (thread.resolved) summary.createSpan({ cls: 'heron-thread-badge', text: 'Resolved' });
	if (thread.outdated) summary.createSpan({ cls: 'heron-thread-badge', text: 'Outdated' });
	const count = summary.createSpan({ cls: 'heron-thread-count' });
	setIcon(count.createSpan(), 'message-square');
	count.createSpan({ text: String(thread.totalComments) });

	const now = opts.now?.();
	for (const comment of thread.comments) {
		const el = details.createDiv({ cls: 'heron-comment' });
		const head = el.createDiv({ cls: 'heron-comment-head' });
		head.createSpan({ cls: 'heron-comment-author', text: comment.author });
		const time = head.createEl('a', {
			cls: 'heron-comment-time',
			text: formatRelativeTime(comment.createdAt, now),
			attr: { href: comment.url, title: formatDateTime(comment.createdAt) },
		});
		if (!comment.url) time.removeAttribute('href');
		const body = el.createDiv({ cls: 'heron-comment-body markdown-rendered' });
		void MarkdownRenderer.render(opts.app, comment.body, body, '', opts.component);
	}
	if (thread.totalComments > thread.comments.length) {
		const more = thread.totalComments - thread.comments.length;
		details.createDiv({ cls: 'heron-thread-more', text: `${more} more comment${more === 1 ? '' : 's'} on GitHub` });
	}
	return details;
}

/** Threads grouped under their file names, files in path order. */
export function threadsByFile(threads: ReviewThread[]): [string, ReviewThread[]][] {
	const byFile = new Map<string, ReviewThread[]>();
	for (const t of threads) {
		const list = byFile.get(t.path) ?? [];
		list.push(t);
		byFile.set(t.path, list);
	}
	return [...byFile].sort(([a], [b]) => a.localeCompare(b)).map(([file, list]) => [file, sortThreads(list)]);
}
