import { ItemView, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import type { DiffLayout } from '../../../settings';
import { LatestRequest } from '../../../utils/latest';
import { DiffRenderer, MessageRenderer, PaneRenderer } from '../../pane/renderers';

export const REWIND_DIFF_VIEW_TYPE = 'heron-rewind-diff';

/** What a Rewind diff tab shows: one file's change in one moment, by content hash. */
export interface RewindDiffState {
	/** Vault path of the file after the moment. */
	path: string;
	before: string | null;
	after: string | null;
	/** The moment's label and time, shown above the diff. */
	title: string;
}

export interface RewindDiffOptions {
	fontSize: () => number;
	wordWrap: () => boolean;
	layout: () => DiffLayout;
	setLayout: (layout: DiffLayout) => void;
	readText: (hash: string) => Promise<string | null>;
	openFile: (vaultPath: string) => void;
}

function isRewindDiffState(state: unknown): state is RewindDiffState {
	const s = state as Partial<RewindDiffState> | null;
	const hash = (v: unknown) => v === null || typeof v === 'string';
	return !!s && typeof s.path === 'string' && hash(s.before) && hash(s.after) && typeof s.title === 'string';
}

/** A file's change in one Rewind moment, against its content just before. */
export class RewindDiffView extends ItemView {
	navigation = true;
	private state: RewindDiffState | null = null;
	private current: PaneRenderer | null = null;
	private request = new LatestRequest();
	private bannerEl!: HTMLElement;
	private bodyEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private opts: RewindDiffOptions) {
		super(leaf);
	}

	getViewType() { return REWIND_DIFF_VIEW_TYPE; }

	getIcon() { return 'history'; }

	getDisplayText() {
		return this.state ? `${path.posix.basename(this.state.path)} (rewind)` : 'Rewind diff';
	}

	onload() {
		super.onload();
		this.contentEl.addClass('heron-diff-tab', 'heron-rewind-tab');
		this.bannerEl = this.contentEl.createDiv({ cls: 'heron-rewind-banner' });
		this.bodyEl = this.contentEl.createDiv({ cls: 'heron-rewind-body' });
		this.addAction('columns-2', 'Toggle side by side', () => {
			this.opts.setLayout(this.opts.layout() === 'split' ? 'unified' : 'split');
			void this.reload();
		});
		this.addAction('file-text', 'Open file', () => {
			if (this.state) this.opts.openFile(this.state.path);
		});
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), ...(this.state ?? {}) };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (isRewindDiffState(state)) {
			this.state = { path: state.path, before: state.before, after: state.after, title: state.title };
			await this.reload();
		}
		await super.setState(state, result);
	}

	private async reload() {
		const state = this.state;
		if (!state) return;
		const token = this.request.next();
		this.bannerEl.setText(state.title);
		const [before, after] = await Promise.all([
			state.before ? this.opts.readText(state.before) : Promise.resolve(''),
			state.after ? this.opts.readText(state.after) : Promise.resolve(''),
		]);
		if (!this.request.isCurrent(token)) return;
		if (before === null || after === null) {
			this.mount(new MessageRenderer(this.bodyEl, 'history', 'No longer in the history', 'This version was pruned.'));
			return;
		}
		this.mount(new DiffRenderer(this.bodyEl, this.opts.fontSize(), before, after, path.posix.basename(state.path), this.opts.layout(), this.opts.wordWrap()));
	}

	private mount(renderer: PaneRenderer) {
		if (this.current) this.removeChild(this.current);
		this.current = this.addChild(renderer);
	}
}
