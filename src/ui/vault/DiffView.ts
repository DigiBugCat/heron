import { ItemView, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import { loadDiffSides } from '../../git/diffSources';
import { GitRepo } from '../../git/GitRepo';
import { ChangeGroup, groupChanges } from '../../git/status';
import type { DiffLayout } from '../../settings';
import { LatestRequest } from '../../utils/latest';
import { DiffRenderer, MessageRenderer, PaneRenderer } from '../pane/renderers';

export const DIFF_VIEW_TYPE = 'heron-diff';

/** Which change a diff tab shows. */
export interface DiffState {
	/** Repository root on disk. */
	root: string;
	/** Path relative to the repository root. */
	file: string;
	group: ChangeGroup;
}

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

function isDiffState(state: unknown): state is DiffState {
	const s = state as Partial<DiffState> | null;
	return !!s && typeof s.root === 'string' && typeof s.file === 'string' && typeof s.group === 'string';
}

/**
 * One file's uncommitted change as a tab: the working tree (or index)
 * against HEAD, unified or side by side. Follows the file as it changes.
 */
export class DiffView extends ItemView {
	navigation = true;
	private state: DiffState | null = null;
	private current: PaneRenderer | null = null;
	private request = new LatestRequest();
	/** Content last rendered, to skip re-rendering when nothing changed. */
	private shown = '';
	private layoutButton: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private opts: DiffViewOptions) {
		super(leaf);
	}

	getViewType() { return DIFF_VIEW_TYPE; }

	getIcon() { return 'git-compare'; }

	getDisplayText() {
		if (!this.state) return 'Diff';
		const where = this.state.group === 'staged' ? 'staged' : 'changes';
		return `${path.posix.basename(this.state.file)} (${where})`;
	}

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
		this.register(this.opts.onRepoChange(() => { void this.reload(); }));
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), ...(this.state ?? {}) };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (isDiffState(state)) {
			this.state = { root: state.root, file: state.file, group: state.group };
			this.shown = '';
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
		const repo = opened.repo;
		const entry = groupChanges((await repo.status()).files).find((e) => e.file.path === state.file && e.group === state.group);
		if (!this.request.isCurrent(token)) return;
		if (!entry) return this.message('No changes', `${state.file} matches the last commit`);
		const { original, modified } = await loadDiffSides(repo, entry);
		if (!this.request.isCurrent(token)) return;
		if (original.kind !== 'text' && original.kind !== 'missing') return this.message('Cannot show this change', original.kind);
		if (modified.kind !== 'text' && modified.kind !== 'missing') return this.message('Cannot show this change', modified.kind);
		const before = original.kind === 'text' ? original.text : '';
		const after = modified.kind === 'text' ? modified.text : '';
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
