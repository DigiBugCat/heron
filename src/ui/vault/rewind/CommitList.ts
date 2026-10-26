import { Component, Keymap } from 'obsidian';
import type { FileCommit } from '../../../git/history';
import { formatDateTime, formatShortAge } from '../../../utils/time';

/** Commits listed for a file at most (`git log -n`). */
export const MAX_COMMITS = 300;

export interface CommitListOptions {
	/** Shows the change `commit` made to the file; `newTab` for Mod-click. */
	openCommit(commit: FileCommit, newTab: boolean): void;
	now?: number;
}

/**
 * Renders a file's commits, newest first: subject, short hash, author and
 * age. DOM listeners are registered on `owner`.
 */
export function renderCommits(parent: HTMLElement, owner: Component, commits: readonly FileCommit[], opts: CommitListOptions) {
	const now = (opts.now ?? Date.now()) / 1000;
	for (const commit of commits) {
		const row = parent.createDiv({ cls: 'heron-rewind-commit tree-item-self is-clickable', attr: { role: 'button', tabindex: '0' } });
		row.dataset.hash = commit.hash;
		row.createDiv({ cls: 'heron-rewind-commit-subject', text: commit.subject || '(no message)' });
		const meta = row.createDiv({ cls: 'heron-rewind-commit-meta' });
		meta.createSpan({ cls: 'heron-rewind-commit-hash', text: commit.short });
		meta.createSpan({ text: ` · ${commit.author} · ` });
		meta.createSpan({ cls: 'heron-rewind-time', text: formatShortAge(commit.time, now) });
		const renamed = commit.origPath ? `\nRenamed from ${commit.origPath}` : '';
		row.title = `${commit.subject}\n${commit.short} · ${commit.author} <${commit.email}> · ${formatDateTime(commit.time)}${renamed}`;
		const open = (evt: MouseEvent | KeyboardEvent) => opts.openCommit(commit, Keymap.isModEvent(evt) !== false);
		owner.registerDomEvent(row, 'click', open);
		owner.registerDomEvent(row, 'keydown', (evt) => { if (evt.key === 'Enter') open(evt); });
	}
	if (commits.length >= MAX_COMMITS) {
		parent.createDiv({ cls: 'heron-panel-empty', text: `Showing the latest ${MAX_COMMITS} commits.` });
	}
}
