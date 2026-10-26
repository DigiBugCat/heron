import { App, Component, Notice } from 'obsidian';
import * as path from 'path';
import { GitRepo } from '../../git/GitRepo';
import { FileLocation, OutlineNode, outlineTree, Position } from '../../lsp/locations';
import type { LspManager, LspStatus } from '../../lsp/LspManager';
import type { ServerAccess } from '../../lsp/requests';
import { findRepoRoot } from '../../utils/paths';
import { CodeIntel, CursorRequest, JumpKind } from '../pane/codeIntel';
import { CodeRenderer } from '../pane/renderers';

export type SurfaceChange = 'content' | 'cursor' | 'dirty';

export interface CodeSurfaceHost {
	app: App;
	lsp: LspManager;
	fontSize: number;
	wordWrap: boolean;
	/** Shows `loc` in the same tab and returns the surface showing it. */
	open(loc: FileLocation): Promise<CodeSurface | null>;
	/** Short name for a file in pickers. */
	label(absPath: string): string;
	/** The language server status of this surface changed. */
	onStatus(): void;
}

/** What code navigation commands act on; the folder view and code tabs both provide it. */
export interface CodeNavigator {
	hasCodeIntel(): boolean;
	goTo(kind: JumpKind): void;
	findReferences(): void;
	goToSymbolInFile(): void;
	goToSymbolInProject(): void;
}

/**
 * One read-only code editor with language server features, as shown in a
 * Heron code tab. The tab decides which file to show; the surface finds the
 * file's repository (the language server's root) and wires up navigation.
 */
export class CodeSurface extends Component implements CodeNavigator {
	readonly code: CodeRenderer;
	private intel: CodeIntel;
	private messageEl: HTMLElement;
	private shown: string | null = null;
	private root: string | null = null;
	private blameOn = false;
	private listeners = new Set<(change: SurfaceChange) => void>();
	private dirty = false;
	status: LspStatus | null = null;

	constructor(private parent: HTMLElement, private host: CodeSurfaceHost) {
		super();
		parent.addClass('heron-reading');
		this.messageEl = parent.createDiv({ cls: 'so-message heron-code-message' });
		this.messageEl.hide();
		this.code = this.addChild(new CodeRenderer(parent, host.fontSize, host.wordWrap));
		this.intel = this.addChild(new CodeIntel(host.lsp, {
			app: host.app,
			current: () => (this.shown ? { absPath: this.shown, code: this.code } : null),
			open: async (loc) => (await this.host.open(loc))?.code ?? null,
			root: () => this.root,
			label: (absPath) => this.host.label(absPath),
			onStatus: (status) => {
				this.status = status;
				this.host.onStatus();
				this.emit('content');
			},
			onHistoryChange: () => undefined,
		}));
	}

	onload() {
		this.register(this.code.onCursorMove(() => this.emit('cursor')));
		this.register(this.code.onEdit(() => {
			if (this.dirty) return;
			this.dirty = true;
			this.emit('dirty');
		}));
	}

	/** True while there are edits that have not been saved. */
	get isDirty(): boolean { return this.dirty; }

	get isEditable(): boolean { return this.code.isEditable(); }

	/** Switches between reading (read-only, no error marks) and editing. */
	setEditable(editable: boolean) {
		this.code.setEditable(editable);
		this.parent.toggleClass('heron-reading', !editable);
		this.parent.toggleClass('heron-editing', editable);
		this.emit('dirty');
	}

	/** The current text, including unsaved edits. */
	text(): string { return this.code.text(); }

	/** Records that the current text has been saved. */
	markSaved() {
		if (!this.dirty) return;
		this.dirty = false;
		this.emit('dirty');
	}

	/**
	 * Calls `listener` when the shown file or its language server changes
	 * ('content') or the cursor moves ('cursor'); returns an unsubscribe function.
	 */
	onChange(listener: (change: SurfaceChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The shown file's symbols, or null without a language server. */
	async outline(): Promise<OutlineNode[] | null> {
		const response = await this.intel.documentSymbols();
		return response === null ? null : outlineTree(response);
	}

	/** The shown file's language server for custom requests, or null without one. */
	server(): Promise<ServerAccess | null> {
		return this.intel.server();
	}

	/** The file shown, as an absolute path. */
	get absPath(): string | null { return this.shown; }

	/**
	 * Shows `text` as the content of `absPath`, with the cursor at `cursor` if
	 * given. `keepScroll` reloads in place, e.g. after the file changed on disk.
	 * Unsaved edits are discarded; the caller saves first if it wants them.
	 */
	async show(absPath: string, text: string, cursor: Position | null, keepScroll = false) {
		this.messageEl.hide();
		this.shown = absPath;
		const dir = path.dirname(absPath);
		this.root = (await findRepoRoot(dir)) ?? dir;
		if (this.shown !== absPath) return;
		this.code.setDocument(text, path.basename(absPath), keepScroll, null, cursor);
		this.markSaved();
		this.emit('content');
		void this.intel.attach(this.code, absPath);
		if (this.blameOn) void this.loadBlame(false);
	}

	/** Shows a message instead of the code, e.g. for a binary or oversized file. */
	showMessage(text: string) {
		this.clear();
		this.messageEl.setText(text);
		this.messageEl.show();
	}

	/** Shows nothing; the language server forgets the file. */
	clear() {
		this.shown = null;
		this.intel.detach();
		this.code.setDocument('', '', false);
		this.emit('content');
	}

	private emit(change: SurfaceChange) {
		for (const listener of this.listeners) listener(change);
	}

	moveCursor(pos: Position) {
		if (this.shown) this.code.moveCursor(pos);
	}

	hasCodeIntel(): boolean { return this.intel.isAvailable(); }

	goTo(kind: JumpKind) { void this.intel.goTo(kind); }

	findReferences() { void this.intel.findReferences(); }

	goToSymbolInFile() { void this.intel.goToSymbolInFile(); }

	goToSymbolInProject() { void this.intel.goToSymbolInProject(); }

	/** For asking the language server about the symbol at the cursor, e.g. its call graph. */
	cursorRequest(): Promise<CursorRequest | null> { return this.intel.cursorRequest(); }

	/** Shows or hides who last changed each line. */
	toggleBlame() {
		this.blameOn = !this.blameOn;
		if (this.blameOn) void this.loadBlame(true);
		else this.code.setBlame(null);
		return this.blameOn;
	}

	private async loadBlame(explicit: boolean) {
		const absPath = this.shown;
		if (!absPath || !this.root) return;
		const opened = await GitRepo.open(this.root);
		const repoPath = opened.kind === 'repo' ? opened.repo.repoPath(absPath) : null;
		if (opened.kind !== 'repo' || !repoPath) {
			if (explicit) new Notice('This file is not in a Git repository');
			return;
		}
		try {
			const lines = await opened.repo.blame(repoPath);
			if (this.shown === absPath && this.blameOn) this.code.setBlame(lines);
		} catch (err) {
			if (explicit) new Notice(`Cannot show blame: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
