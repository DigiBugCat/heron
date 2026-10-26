import { Component, Keymap, setIcon } from 'obsidian';
import type { CheckState, PullRequest, PullSummary } from '../../github/types';
import { formatDateTime, formatShortAge } from '../../utils/time';

/** Icon and label for each combined check state. */
export const CHECK_ICONS: Record<CheckState, { icon: string; label: string } | null> = {
	success: { icon: 'check', label: 'Checks passed' },
	failure: { icon: 'x', label: 'Checks failed' },
	pending: { icon: 'clock', label: 'Checks running' },
	neutral: { icon: 'minus', label: 'Checks skipped or neutral' },
	none: null,
};

export interface PullGroup {
	id: 'requested' | 'yours' | 'others';
	title: string;
	items: PullSummary[];
}

/**
 * Splits pull requests into those waiting for your review, your own, and
 * everyone else's. Your own pull requests are never in the first group.
 */
export function groupPulls(viewer: string, summaries: PullSummary[]): PullGroup[] {
	const me = viewer.toLowerCase();
	const groups: PullGroup[] = [
		{ id: 'requested', title: 'Review requested', items: [] },
		{ id: 'yours', title: 'Yours', items: [] },
		{ id: 'others', title: 'Others', items: [] },
	];
	for (const s of summaries) {
		const mine = s.pull.author.toLowerCase() === me;
		const group = mine ? groups[1] : s.reviewRequested ? groups[0] : groups[2];
		group?.items.push(s);
	}
	return groups;
}

export type ListContent =
	| { kind: 'loading' }
	| { kind: 'message'; text: string; detail?: string; retry?: () => void }
	| { kind: 'pulls'; viewer: string; summaries: PullSummary[]; truncated: boolean };

export interface PullRequestListOptions {
	onOpen: (pull: PullRequest, newTab: boolean) => void;
	/** Current time in seconds, for tests. */
	now?: () => number;
}

/** The pull request list of the **Pull requests** panel, grouped and collapsible. */
export class PullRequestList extends Component {
	readonly el: HTMLElement;
	private collapsed = new Set<PullGroup['id']>();
	private content: ListContent = { kind: 'loading' };
	/** Owns the listeners of the current rendering; replaced on every render. */
	private scope: Component | null = null;

	constructor(parent: HTMLElement, private opts: PullRequestListOptions) {
		super();
		this.el = parent.createDiv({ cls: 'heron-prs' });
	}

	onunload() {
		this.el.remove();
	}

	show(content: ListContent) {
		this.content = content;
		this.render();
	}

	private render() {
		const content = this.content;
		if (this.scope) this.removeChild(this.scope);
		this.scope = this.addChild(new Component());
		this.el.empty();
		if (content.kind === 'loading') {
			this.el.createDiv({ cls: 'heron-panel-empty', text: 'Loading pull requests…' });
			return;
		}
		if (content.kind === 'message') {
			const box = this.el.createDiv({ cls: 'heron-prs-message' });
			box.createDiv({ cls: 'heron-prs-message-text', text: content.text });
			if (content.detail) box.createDiv({ cls: 'heron-prs-message-detail', text: content.detail });
			if (content.retry) {
				const retry = content.retry;
				const button = box.createEl('button', { text: 'Try again' });
				this.scope?.registerDomEvent(button, 'click', () => retry());
			}
			return;
		}
		if (!content.summaries.length) {
			this.el.createDiv({ cls: 'heron-panel-empty', text: 'No open pull requests.' });
			return;
		}
		for (const group of groupPulls(content.viewer, content.summaries)) {
			if (group.items.length) this.renderGroup(group);
		}
		if (content.truncated) {
			this.el.createDiv({ cls: 'heron-panel-empty', text: `Showing the ${content.summaries.length} most recently updated.` });
		}
	}

	private renderGroup(group: PullGroup) {
		const collapsed = this.collapsed.has(group.id);
		const header = this.el.createDiv({
			cls: 'heron-prs-group tree-item-self is-clickable',
			attr: { role: 'button', tabindex: '0', 'aria-expanded': String(!collapsed), 'data-group': group.id },
		});
		setIcon(header.createSpan({ cls: 'heron-changes-chevron' }), collapsed ? 'chevron-right' : 'chevron-down');
		header.createSpan({ text: group.title });
		header.createSpan({ cls: 'heron-changes-count', text: String(group.items.length) });
		const toggle = () => {
			if (collapsed) this.collapsed.delete(group.id);
			else this.collapsed.add(group.id);
			this.render();
		};
		this.scope?.registerDomEvent(header, 'click', toggle);
		this.scope?.registerDomEvent(header, 'keydown', (evt) => { if (evt.key === 'Enter') toggle(); });
		if (collapsed) return;
		for (const summary of group.items) this.renderPull(summary);
	}

	private renderPull({ pull, checks, unresolvedThreads }: PullSummary) {
		const row = this.el.createDiv({
			cls: 'heron-pr tree-item-self is-clickable',
			attr: { role: 'button', tabindex: '0', 'data-number': String(pull.number) },
		});
		row.toggleClass('is-draft', pull.draft);
		const check = row.createSpan({ cls: `heron-pr-check is-${checks}` });
		const checkInfo = CHECK_ICONS[checks];
		if (checkInfo) {
			setIcon(check, checkInfo.icon);
			check.setAttr('aria-label', checkInfo.label);
		}
		const main = row.createDiv({ cls: 'heron-pr-main' });
		main.createDiv({ cls: 'heron-pr-title', text: pull.title });
		const meta = main.createDiv({ cls: 'heron-pr-meta' });
		meta.createSpan({ cls: 'heron-pr-number', text: `#${pull.number}` });
		meta.createSpan({ cls: 'heron-pr-author', text: pull.author });
		if (pull.draft) meta.createSpan({ cls: 'heron-pr-draft', text: 'Draft' });
		const now = this.opts.now?.();
		const age = meta.createSpan({ cls: 'heron-pr-age', text: formatShortAge(pull.updatedAt, now) });
		age.setAttr('aria-label', `Updated ${formatDateTime(pull.updatedAt)}`);
		if (unresolvedThreads > 0) {
			const threads = row.createSpan({ cls: 'heron-pr-threads' });
			setIcon(threads.createSpan(), 'message-square');
			threads.createSpan({ text: String(unresolvedThreads) });
			threads.setAttr('aria-label', `${unresolvedThreads} unresolved thread${unresolvedThreads === 1 ? '' : 's'}`);
		}
		row.title = `${pull.title}\n${pull.headRef} → ${pull.baseRef}`;
		const open = (evt: MouseEvent | KeyboardEvent) => this.opts.onOpen(pull, Keymap.isModEvent(evt) !== false);
		this.scope?.registerDomEvent(row, 'click', open);
		this.scope?.registerDomEvent(row, 'keydown', (evt) => { if (evt.key === 'Enter') open(evt); });
	}
}
