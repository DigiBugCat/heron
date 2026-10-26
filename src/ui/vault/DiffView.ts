import { ItemView, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import { DiffSides, loadCommitSides, loadDiffSides } from '../../git/diffSources';
import { GitRepo } from '../../git/GitRepo';
import type { FileCommit } from '../../git/history';
import { ChangeEntry, ChangeGroup, groupChanges } from '../../git/status';
import { compareWithBase } from '../../services/BaseComparison';
import type { DiffLayout } from '../../settings';
import { LatestRequest } from '../../utils/latest';
import { copyToClipboard } from '../../utils/system';
import { DiffRenderer, MessageRenderer, PaneRenderer } from '../pane/renderers';

export const DIFF_VIEW_TYPE = 'heron-diff';

/** Which change a diff tab shows. */
export type DiffState =
	/** An uncommitted change; for `base`, everything since the merge base with `baseRef`. */
	| { root: string; file: string; group: ChangeGroup; baseRef?: string }
	/** The change `commit` made to the file. */
	| { root: string; file: string; commit: FileCommit };

export interface DiffViewOptions {
	fontSize: () => number;
	wordWrap: () => boolean;
	layout: () => DiffLayout;
	setLayout: (layout: DiffLayout) => void;
	/** Opens the file itself (vault path) in this tab. */
	openFile: (absPath: string) => void;
	/** Subscribes to repository changes so the diff stays current. */
	onRepoChange: (listener: () => void) => () => void;
}

const GROUP_LABEL: Record<ChangeGroup, string> = {
	staged: 'staged',
	unstaged: 'changes',
	conflicts: 'conflict',
	base: 'against base',
};

function isCommit(value: unknown): value is FileCommit {
	const c = value as Partial<FileCommit> | null;
	return !!c && typeof c.hash === 'string' && typeof c.short === 'string' && typeof c.path === 'string';
}

/** Reads a diff tab's state back from the workspace, or null when it is not one. */
export function diffStateFrom(state: unknown): DiffState | null {
	const s = state as { root?: unknown; file?: unknown; group?: unknown; baseRef?: unknown; commit?: unknown } | null;
	if (!s || typeof s.root !== 'string' || typeof s.file !== 'string') return null;
	if (isCommit(s.commit)) return { root: s.root, file: s.file, commit: s.commit };
	if (s.group !== 'staged' && s.group !== 'unstaged' && s.group !== 'conflicts' && s.group !== 'base') return null;
	if (s.group === 'base') return typeof s.baseRef === 'string' ? { root: s.root, file: s.file, group: 'base', baseRef: s.baseRef } : null;
	return { root: s.root, file: s.file, group: s.group };
}

/** The tab title for `state`. */
export function diffTitle(state: DiffState | null): string {
	if (!state) return 'Diff';
	const name = path.posix.basename(state.file);
	if ('commit' in state) return `${name} @ ${state.commit.short}`;
	return `${name} (${state.group === 'base' && state.baseRef ? `against ${state.baseRef}` : GROUP_LABEL[state.group]})`;
}

type Loaded = { sides: DiffSides } | { message: string; detail: string };

/** Loads the two sides `state` compares, or explains why there is nothing to show. */
export async function loadDiffState(repo: GitRepo, state: DiffState): Promise<Loaded> {
	if ('commit' in state) return { sides: await loadCommitSides(repo, state.commit) };
	const status = await repo.status();
	let entry: ChangeEntry | undefined;
	if (state.group === 'base') {
		const base = await compareWithBase(repo, state.baseRef ?? null, status);
		if (base.kind === 'error') return { message: 'Cannot compare with the base branch', detail: base.message };
		entry = base.entries.find((e) => e.file.path === state.file);
		if (!entry) return { message: 'No changes', detail: `${state.file} matches ${base.ref}` };
	} else {
		entry = groupChanges(status.files).find((e) => e.file.path === state.file && e.group === state.group);
		if (!entry) return { message: 'No changes', detail: `${state.file} matches the last commit` };
	}
	return { sides: await loadDiffSides(repo, entry) };
}

/**
 * One file's change as a tab, unified or side by side: an uncommitted
 * change (the working tree or index against HEAD), the change since the
 * merge base with a base branch, or the change one commit made.
 * Uncommitted and base diffs follow the file as it changes.
 */
export class DiffView extends ItemView {
	navigation = true;
	private state: DiffState | null = null;
	private current: PaneRenderer | null = null;
	private request = new LatestRequest();
	/** Content last rendered, to skip re-rendering when nothing changed. */
	private shown = '';
	private layoutButton: HTMLElement | null = null;
	private hashButton: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private opts: DiffViewOptions) {
		super(leaf);
	}

	getViewType() { return DIFF_VIEW_TYPE; }

	getIcon() { return 'git-compare'; }

	getDisplayText() { return diffTitle(this.state); }

	onload() {
		super.onload();
		this.contentEl.addClass('heron-diff-tab');
		this.layoutButton = this.addAction('columns-2', 'Show side by side', () => {
			this.opts.setLayout(this.opts.layout() === 'split' ? 'unified' : 'split');
			this.shown = '';
			void this.reload();
		});
		this.addAction('file-text', 'Open file', () => {
			if (this.state) this.opts.openFile(path.join(this.state.root, this.state.file));
		});
		this.hashButton = this.addAction('copy', 'Copy commit hash', () => {
			const state = this.state;
			if (state && 'commit' in state) void copyToClipboard(state.commit.hash, `Copied commit hash ${state.commit.short}`);
		});
		this.hashButton.hide();
		this.register(this.opts.onRepoChange(() => {
			if (this.state && !('commit' in this.state)) void this.reload();
		}));
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), ...(this.state ?? {}) };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const next = diffStateFrom(state);
		if (next) {
			this.state = next;
			this.shown = '';
			this.hashButton?.toggle('commit' in next);
			await this.reload();
		}
		await super.setState(state, result);
	}

	private async reload() {
		const state = this.state;
		if (!state) return;
		const token = this.request.next();
		const opened = await GitRepo.open(state.root);
		if (opened.kind !== 'repo') return this.message('Not a git repository', state.root);
		let loaded: Loaded;
		try {
			loaded = await loadDiffState(opened.repo, state);
		} catch (err) {
			loaded = { message: 'Cannot show this change', detail: err instanceof Error ? err.message : String(err) };
		}
		if (!this.request.isCurrent(token)) return;
		if ('message' in loaded) return this.message(loaded.message, loaded.detail);
		const { original, modified } = loaded.sides;
		if (original.kind !== 'text' && original.kind !== 'missing') return this.message('Cannot show this change', original.kind);
		if (modified.kind !== 'text' && modified.kind !== 'missing') return this.message('Cannot show this change', modified.kind);
		const before = original.kind === 'text' ? original.text : '';
		const after = modified.kind === 'text' ? modified.text : '';
		if ('commit' in state && before === after) {
			return this.message('No textual changes', state.commit.origPath ? `Renamed from ${state.commit.origPath}` : 'The file content did not change in this commit');
		}
		const layout = this.opts.layout();
		const key = `${layout}\0${before}\0${after}`;
		if (key === this.shown) return;
		this.shown = key;
		this.mount(new DiffRenderer(this.contentEl, this.opts.fontSize(), before, after, path.posix.basename(state.file), layout, this.opts.wordWrap()));
		this.layoutButton?.setAttr('aria-label', layout === 'split' ? 'Show unified' : 'Show side by side');
	}

	private message(text: string, detail: string) {
		this.shown = '';
		this.mount(new MessageRenderer(this.contentEl, 'git-compare', text, detail));
	}

	private mount(renderer: PaneRenderer) {
		if (this.current) this.removeChild(this.current);
		this.current = this.addChild(renderer);
	}
}
