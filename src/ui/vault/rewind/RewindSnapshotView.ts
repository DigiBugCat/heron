import { ItemView, setIcon, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import { fileInMoment, Moment, MomentFile, momentsForFile } from '../../../services/rewind/moments';
import { LatestRequest } from '../../../utils/latest';
import { CodeRenderer, MessageRenderer, PaneRenderer } from '../../pane/renderers';
import { momentTime } from './actions';

export const REWIND_SNAPSHOT_VIEW_TYPE = 'heron-rewind-snapshot';

/** A file as it was right after one moment. */
export interface SnapshotState {
	path: string;
	/** The moment's id. */
	moment: string;
}

export interface SnapshotOptions {
	fontSize: () => number;
	wordWrap: () => boolean;
	moments: () => Moment[];
	readText: (hash: string) => Promise<string | null>;
	onChange: (listener: () => void) => () => void;
	openFile: (vaultPath: string) => void;
	restore: (moment: Moment, file: MomentFile) => void;
}

/**
 * Read-only view of a file as it was after a moment, with a banner to step
 * to the previous or next moment that changed it, or restore this version.
 */
export class RewindSnapshotView extends ItemView {
	navigation = true;
	private state: SnapshotState | null = null;
	private current: PaneRenderer | null = null;
	private request = new LatestRequest();
	private bannerEl!: HTMLElement;
	private bodyEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private opts: SnapshotOptions) {
		super(leaf);
	}

	getViewType() { return REWIND_SNAPSHOT_VIEW_TYPE; }

	getIcon() { return 'history'; }

	getDisplayText() {
		return this.state ? `${path.posix.basename(this.state.path)} (as of)` : 'Rewind';
	}

	onload() {
		super.onload();
		this.contentEl.addClass('heron-code-tab', 'heron-rewind-tab');
		this.bannerEl = this.contentEl.createDiv({ cls: 'heron-rewind-banner' });
		this.bodyEl = this.contentEl.createDiv({ cls: 'heron-rewind-body' });
		this.register(this.opts.onChange(() => this.renderBanner()));
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), ...(this.state ?? {}) };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = state as Partial<SnapshotState> | null;
		if (s && typeof s.path === 'string' && typeof s.moment === 'string') {
			this.state = { path: s.path, moment: s.moment };
			await this.reload();
		}
		await super.setState(state, result);
	}

	/** This file's moments, newest first, and the index of the one shown. */
	private timeline(): { moments: Moment[]; index: number } {
		const moments = this.state ? momentsForFile(this.opts.moments(), this.state.path) : [];
		return { moments, index: moments.findIndex((m) => m.id === this.state?.moment) };
	}

	private go(moment: Moment) {
		if (!this.state) return;
		this.state = { ...this.state, moment: moment.id };
		this.app.workspace.requestSaveLayout();
		void this.reload();
	}

	private renderBanner() {
		const state = this.state;
		this.bannerEl.empty();
		if (!state) return;
		const { moments, index } = this.timeline();
		const moment = moments[index];
		const file = moment ? fileInMoment(moment, state.path) : undefined;
		const text = this.bannerEl.createSpan({ cls: 'heron-rewind-banner-text' });
		text.setText(moment ? `As of ${momentTime(moment.end)} · ${moment.label}` : 'This moment is no longer in the history');
		const button = (icon: string, label: string, enabled: boolean, action: () => void) => {
			const el = this.bannerEl.createEl('button', { cls: 'heron-rewind-banner-button', attr: { 'aria-label': label } });
			setIcon(el, icon);
			el.toggleClass('is-disabled', !enabled);
			if (enabled) this.registerDomEvent(el, 'click', action);
		};
		const older = moments[index + 1];
		const newer = index > 0 ? moments[index - 1] : undefined;
		button('chevron-left', 'Previous moment', index >= 0 && !!older, () => { if (older) this.go(older); });
		button('chevron-right', 'Next moment', !!newer, () => { if (newer) this.go(newer); });
		button('rotate-ccw', 'Restore this version', !!(moment && file), () => { if (moment && file) this.opts.restore(moment, file); });
		button('file-text', 'Open current file', true, () => this.opts.openFile(state.path));
	}

	private async reload() {
		const state = this.state;
		if (!state) return;
		const token = this.request.next();
		this.renderBanner();
		const { moments, index } = this.timeline();
		const moment = moments[index];
		const file = moment ? fileInMoment(moment, state.path) : undefined;
		const hash = file?.path === state.path ? file.after : null;
		const text = hash ? await this.opts.readText(hash) : null;
		if (!this.request.isCurrent(token)) return;
		if (text === null) {
			this.mount(new MessageRenderer(this.bodyEl, 'history', 'Not available', 'The file did not exist after this moment, or this version was pruned.'));
			return;
		}
		const code = this.current instanceof CodeRenderer ? this.current : this.mount(new CodeRenderer(this.bodyEl, this.opts.fontSize(), this.opts.wordWrap()));
		code.setDocument(text, path.posix.basename(state.path), false);
	}

	private mount<T extends PaneRenderer>(renderer: T): T {
		if (this.current) this.removeChild(this.current);
		this.current = this.addChild(renderer);
		return renderer;
	}
}
