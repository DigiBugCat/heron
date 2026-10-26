import { ItemView, Menu, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import type { FileCommit } from '../../../git/history';
import { Moment, MomentFile, momentsForFile, momentsForRepo } from '../../../services/rewind/moments';
import { LatestRequest } from '../../../utils/latest';
import { renderCommits } from './CommitList';
import { primaryFile, renderMoments } from './MomentList';

export const REWIND_VIEW_TYPE = 'heron-rewind';

/** Re-render this often so ages ("5m") stay current, in ms. */
const AGE_REFRESH_MS = 60_000;

/** The active file's moments, its repository's moments, or the file's git commits. */
export type RewindScope = 'file' | 'repo' | 'commits';

const SCOPES: { scope: RewindScope; text: string }[] = [
	{ scope: 'file', text: 'This file' },
	{ scope: 'repo', text: 'Repository' },
	{ scope: 'commits', text: 'Commits' },
];

export function isRewindScope(value: unknown): value is RewindScope {
	return value === 'file' || value === 'repo' || value === 'commits';
}

export interface RewindViewOptions {
	enabled(): boolean;
	moments(): Moment[];
	repoOf(vaultPath: string): string | null;
	onChange(listener: () => void): () => void;
	openDiff(moment: Moment, file: MomentFile, newTab: boolean): void;
	viewAsOf(moment: Moment, file: MomentFile): void;
	restoreFile(moment: Moment, file: MomentFile, side: 'before' | 'after'): void;
	undoMoment(moment: Moment): void;
	/** The commits that changed `vaultPath` (`git log --follow`), or null outside the vault's repositories. */
	fileCommits(vaultPath: string): Promise<FileCommit[] | null>;
	/** Shows the change `commit` made to `vaultPath`; `newTab` for Mod-click. */
	openCommit(vaultPath: string, commit: FileCommit, newTab: boolean): void;
	/** Subscribes to changes in the vault's repositories, e.g. a new commit. */
	onGitChange(listener: () => void): () => void;
}

/**
 * Right-sidebar timeline of the active file's moments (or its whole
 * repository's), newest first: who changed what and when. Selecting a
 * moment or file shows its diff; its menu restores or undoes it. The
 * Commits scope lists the file's git history instead; selecting a commit
 * shows the change it made.
 */
export class RewindView extends ItemView {
	private range: RewindScope = 'file';
	private followPath: string | null = null;
	private headerEl!: HTMLElement;
	private listEl!: HTMLElement;
	/** Commits of the followed file, once loaded; dropped when a repository changes. */
	private commits: { path: string; list: FileCommit[] | null } | null = null;
	private commitRequest = new LatestRequest();

	constructor(leaf: WorkspaceLeaf, private opts: RewindViewOptions) {
		super(leaf);
	}

	getViewType() { return REWIND_VIEW_TYPE; }

	getDisplayText() { return 'Rewind'; }

	getIcon() { return 'history'; }

	getState(): Record<string, unknown> {
		return { ...super.getState(), scope: this.range };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const scope = (state as { scope?: unknown } | null)?.scope;
		if (isRewindScope(scope)) {
			this.range = scope;
			this.render();
		}
		await super.setState(state, result);
	}

	onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('heron-panel', 'heron-rewind');
		this.headerEl = this.contentEl.createDiv({ cls: 'heron-rewind-header' });
		this.listEl = this.contentEl.createDiv({ cls: 'heron-rewind-list' });
		this.register(this.opts.onChange(() => this.render()));
		this.register(this.opts.onGitChange(() => {
			this.commits = null;
			if (this.range === 'commits') this.render();
		}));
		this.registerEvent(this.app.workspace.on('file-open', () => this.render()));
		this.registerInterval(window.setInterval(() => this.render(), AGE_REFRESH_MS));
		this.app.workspace.onLayoutReady(() => this.render());
		return Promise.resolve();
	}

	/** The scope shown: this file's moments, the repository's, or this file's commits. */
	shownScope(): RewindScope { return this.range; }

	setScope(scope: RewindScope) {
		if (scope === this.range) return;
		this.range = scope;
		this.app.workspace.requestSaveLayout();
		this.render();
	}

	private render() {
		if (!this.listEl) return;
		// Keep following the last file while a diff or other non-file tab is active.
		this.followPath = this.app.workspace.getActiveFile()?.path ?? this.followPath;
		const activePath = this.followPath;
		const repo = activePath ? this.opts.repoOf(activePath) : null;
		this.renderHeader(activePath, repo);
		this.listEl.empty();
		if (this.range === 'commits') {
			this.renderCommits(activePath);
			return;
		}
		if (!this.opts.enabled()) {
			this.empty('Rewind is off. Turn it on in Settings → Heron.');
			return;
		}
		if (!activePath || !repo) {
			this.empty('Open a file in one of the vault’s repositories to see its history.');
			return;
		}
		const all = this.opts.moments();
		const moments = this.range === 'file' ? momentsForFile(all, activePath) : momentsForRepo(all, repo);
		if (!moments.length) {
			this.empty(this.range === 'file' ? 'No changes recorded for this file yet.' : 'No changes recorded in this repository yet.');
			return;
		}
		renderMoments(this.listEl, this, moments, {
			activePath,
			openDiff: (m, f, newTab) => this.opts.openDiff(m, f, newTab),
			openMenu: (evt, m, f) => this.showMenu(evt, m, f ?? primaryFile(m, activePath)),
		});
	}

	private renderHeader(activePath: string | null, repo: string | null) {
		this.headerEl.empty();
		const title = this.headerEl.createDiv({ cls: 'heron-panel-title heron-rewind-title' });
		const target = this.range === 'repo' ? repo : activePath;
		title.setText(target ? path.posix.basename(target) : 'Rewind');
		const toggle = this.headerEl.createDiv({ cls: 'heron-rewind-scope' });
		for (const { scope, text } of SCOPES) {
			const button = toggle.createEl('button', { cls: `heron-rewind-scope-button${this.range === scope ? ' is-active' : ''}`, text });
			button.setAttr('aria-pressed', String(this.range === scope));
			this.registerDomEvent(button, 'click', () => this.setScope(scope));
		}
	}

	/** The followed file's commits, loading them first when needed. */
	private renderCommits(activePath: string | null) {
		if (!activePath) {
			this.empty('Open a file in one of the vault’s repositories to see its commits.');
			return;
		}
		const loaded = this.commits?.path === activePath ? this.commits.list : undefined;
		if (loaded === undefined) {
			this.empty('Loading commits…');
			void this.loadCommits(activePath);
			return;
		}
		if (loaded === null) {
			this.empty('This file is not in one of the vault’s repositories.');
			return;
		}
		if (!loaded.length) {
			this.empty('No commits for this file yet.');
			return;
		}
		renderCommits(this.listEl, this, loaded, {
			openCommit: (commit, newTab) => this.opts.openCommit(activePath, commit, newTab),
		});
	}

	private async loadCommits(vaultPath: string) {
		const token = this.commitRequest.next();
		const list = await this.opts.fileCommits(vaultPath).catch(() => null);
		if (!this.commitRequest.isCurrent(token)) return;
		this.commits = { path: vaultPath, list };
		this.render();
	}

	private empty(text: string) {
		this.listEl.createDiv({ cls: 'heron-panel-empty', text });
	}

	private showMenu(evt: MouseEvent, moment: Moment, file: MomentFile | null) {
		const menu = new Menu();
		if (file) {
			const name = path.posix.basename(file.path);
			menu.addItem((i) => i.setTitle(`Show changes to ${name}`).setIcon('git-compare').onClick(() => this.opts.openDiff(moment, file, false)));
			if (file.after !== null) {
				menu.addItem((i) => i.setTitle('View file as of this moment').setIcon('eye').onClick(() => this.opts.viewAsOf(moment, file)));
			}
			menu.addSeparator();
			menu.addItem((i) => i.setTitle('Restore file to this moment').setIcon('rotate-ccw').onClick(() => this.opts.restoreFile(moment, file, 'after')));
			menu.addItem((i) => i.setTitle('Restore file to before this moment').setIcon('rotate-ccw').onClick(() => this.opts.restoreFile(moment, file, 'before')));
		}
		const count = moment.files.length;
		menu.addItem((i) => i
			.setTitle(count === 1 ? 'Undo this moment' : `Undo this moment (${count} files)`)
			.setIcon('undo')
			.onClick(() => this.opts.undoMoment(moment)));
		menu.showAtMouseEvent(evt);
	}
}
