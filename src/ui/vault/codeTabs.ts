import { FileSystemAdapter, FileView, ItemView, Menu, Notice, Scope, setIcon, TFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import type HeronPlugin from '../../main';
import type { CodeMode } from '../../settings';
import type { FileLocation } from '../../lsp/locations';
import { COPY_FORMATS, CopyFormat, describeLocation, formatForCopy } from '../../links/sourceLink';
import { formatBytes, MAX_VIEW_BYTES, readViewableFile } from '../../utils/content';
import { displayPath } from '../../utils/paths';
import { copyToClipboard } from '../../utils/system';
import { CODE_EXTENSIONS } from '../editor/languages';
import { CodeSurface, CodeSurfaceHost } from './CodeSurface';
import { CODE_VIEW_TYPE, CodeTarget, EXTERNAL_CODE_VIEW_TYPE, openCodeFile, targetFrom } from './openCode';

export { CODE_VIEW_TYPE, EXTERNAL_CODE_VIEW_TYPE } from './openCode';

const CODE_EXTENSION_SET = new Set(CODE_EXTENSIONS);

/** The link menu's entries; without a selection they cover the whole file. */
const COPY_MENU: Record<CopyFormat, string> = {
	link: 'Copy link to selection',
	embed: 'Copy embed of selection',
	code: 'Copy selection as code block',
};

const COPIED_NOTICE: Record<CopyFormat, string> = {
	link: 'Copied link to',
	embed: 'Copied embed of',
	code: 'Copied code block from',
};

/** A tab showing code, so commands and the status bar can find its surface. */
export interface CodeTab {
	codeSurface(): CodeSurface;
}

export function isCodeTab(view: unknown): view is CodeTab {
	return !!view && typeof (view as Partial<CodeTab>).codeSurface === 'function';
}

/** The vault's folder on disk, or '' on adapters without one (mobile). */
export function vaultBasePath(plugin: HeronPlugin): string {
	const adapter = plugin.app.vault.adapter;
	return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
}

/**
 * Shows `loc` in `leaf`: a vault file through Obsidian (so it joins the
 * tab's history), anything else in an external code tab.
 */
export async function openLocation(plugin: HeronPlugin, leaf: WorkspaceLeaf, loc: FileLocation): Promise<CodeSurface | null> {
	await openCodeFile(plugin.app, vaultBasePath(plugin), leaf, loc.absPath, { cursor: loc.position });
	return isCodeTab(leaf.view) ? leaf.view.codeSurface() : null;
}

/** Copies a link, embed or code block for the shown file, limited to the selected lines. */
export function copyFromSurface(surface: CodeSurface, format: CopyFormat) {
	const at = surface.linkLocation();
	if (!at) return;
	void copyToClipboard(formatForCopy(format, at.loc, at.text), `${COPIED_NOTICE[format]} ${describeLocation(at.loc)}`);
}

function surfaceHost(plugin: HeronPlugin, leaf: WorkspaceLeaf): CodeSurfaceHost {
	return {
		app: plugin.app,
		lsp: plugin.lsp,
		fontSize: plugin.settings.fontSize,
		wordWrap: plugin.settings.wordWrap,
		open: (loc) => openLocation(plugin, leaf, loc),
		label: (absPath) => displayPath(absPath, vaultBasePath(plugin)),
		onStatus: () => plugin.updateStatusBar(),
		openCommit: (root, commit) => { void plugin.openCommitDiff(root, commit, true); },
	};
}

/** Keeps a surface's font size and wrapping in line with the settings. */
function followSettings(view: ItemView, surface: () => CodeSurface, plugin: HeronPlugin) {
	view.registerEvent(plugin.settingsEvents.on('changed', () => {
		surface().code.setFontSize(plugin.settings.fontSize);
		surface().code.setWordWrap(plugin.settings.wordWrap);
	}));
}

/**
 * Keys that apply while a code tab is focused, even before clicking into
 * the editor: Mod+F finds in the file, Mod+Shift+F searches all code.
 */
function registerKeys(scope: Scope, surface: () => CodeSurface, plugin: HeronPlugin) {
	scope.register(['Mod'], 'F', () => (surface().openSearch() ? false : undefined));
	scope.register(['Mod', 'Shift'], 'F', () => {
		plugin.searchInCode();
		return false;
	});
}

/** Header buttons shared by both code tabs. */
function addActions(view: ItemView, surface: () => CodeSurface, plugin: HeronPlugin, file: () => TFile | null) {
	const blame = view.addAction('user', 'Show blame', () => { surface().toggleBlame(); });
	view.register(surface().onChange((change) => {
		if (change !== 'blame') return;
		const on = surface().blameShown;
		blame.toggleClass('is-active', on);
		blame.setAttr('aria-label', on ? 'Hide blame' : 'Show blame');
	}));
	view.addAction('compass', 'Code navigation', (evt) => {
		const s = surface();
		const menu = new Menu();
		menu.addItem((i) => i.setTitle('Go to definition').setIcon('arrow-right').onClick(() => s.goTo('definition')));
		menu.addItem((i) => i.setTitle('Find references').setIcon('list').onClick(() => s.findReferences()));
		menu.addItem((i) => i.setTitle('Go to symbol in file…').setIcon('hash').onClick(() => s.goToSymbolInFile()));
		menu.addItem((i) => i.setTitle('Go to symbol in project…').setIcon('search').onClick(() => s.goToSymbolInProject()));
		menu.showAtMouseEvent(evt);
	});
	view.addAction('link', 'Copy link', (evt) => {
		const menu = new Menu();
		const f = file();
		if (f) {
			menu.addItem((i) => i.setTitle('Copy link to file').setIcon('file-symlink').onClick(() => {
				void copyToClipboard(plugin.app.fileManager.generateMarkdownLink(f, ''), `Copied link to ${f.name}`);
			}));
			menu.addSeparator();
		}
		for (const { format, icon } of COPY_FORMATS) {
			menu.addItem((i) => i.setTitle(COPY_MENU[format]).setIcon(icon).onClick(() => copyFromSurface(surface(), format)));
		}
		menu.showAtMouseEvent(evt);
	});
}

/** Applies a cursor or line target to `surface`; false when it shows no file yet. */
function applyTarget(surface: CodeSurface, target: CodeTarget): boolean {
	if (!surface.absPath) return false;
	if (target.lines) surface.showLines(target.lines);
	else if (target.cursor) surface.moveCursor(target.cursor);
	return true;
}

/**
 * Code files in the vault open here, the way PDFs open in Obsidian's PDF
 * viewer: one tab per file, read-only, with language server navigation.
 */
export class CodeFileView extends FileView implements CodeTab {
	private surface!: CodeSurface;
	private pendingTarget: CodeTarget | null = null;
	/** 'edit' or 'read'; kept in the tab's state so it survives restarts. */
	private mode: CodeMode;
	private modeButton: HTMLElement | null = null;
	/** Text this tab last wrote, so its own save doesn't look like an outside change. */
	private lastSaved: string | null = null;
	private warnedOutsideChange = false;

	constructor(leaf: WorkspaceLeaf, private plugin: HeronPlugin) {
		super(leaf);
		this.mode = plugin.settings.codeMode;
		this.scope = new Scope(this.app.scope);
		this.scope.register(['Mod'], 'S', () => {
			void this.save();
			return false;
		});
		this.scope.register(['Mod'], 'E', () => {
			this.setMode(this.mode === 'edit' ? 'read' : 'edit');
			return false;
		});
		registerKeys(this.scope, () => this.surface, plugin);
	}

	getViewType() { return CODE_VIEW_TYPE; }

	getIcon() { return 'code-2'; }

	canAcceptExtension(extension: string): boolean {
		return CODE_EXTENSION_SET.has(extension);
	}

	codeSurface(): CodeSurface { return this.surface; }

	onload() {
		super.onload();
		this.contentEl.addClass('heron-code-tab');
		this.surface = this.addChild(new CodeSurface(this.contentEl, surfaceHost(this.plugin, this.leaf)));
		this.modeButton = this.addAction('pencil', 'Edit', () => this.setMode(this.mode === 'edit' ? 'read' : 'edit'));
		addActions(this, () => this.surface, this.plugin, () => this.file);
		followSettings(this, () => this.surface, this.plugin);
		this.applyMode();
		this.register(this.surface.onChange((change) => { if (change === 'dirty') this.plugin.updateStatusBar(); }));
		this.registerEvent(this.app.vault.on('modify', (f) => {
			if (f instanceof TFile && f === this.file) void this.changedOnDisk(f);
		}));
		// Leaving the tab saves it, like switching away from a note.
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
			if (leaf !== this.leaf && this.surface.isDirty) void this.save();
		}));
		this.registerEvent(this.app.workspace.on('quit', () => { void this.save(); }));
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), mode: this.mode };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const mode = (state as { mode?: unknown } | null)?.mode;
		if (mode === 'edit' || mode === 'read') {
			this.mode = mode;
			this.applyMode();
		}
		await super.setState(state, result);
	}

	async onLoadFile(file: TFile): Promise<void> {
		const target = this.pendingTarget;
		this.pendingTarget = null;
		this.warnedOutsideChange = false;
		await this.loadContent(file, target?.cursor ?? null, false);
		if (target?.lines) this.surface.showLines(target.lines);
	}

	async onUnloadFile(file: TFile): Promise<void> {
		await this.save(file);
		this.surface.clear();
	}

	setEphemeralState(state: unknown): void {
		super.setEphemeralState(state);
		const target = targetFrom(state);
		if (target && !applyTarget(this.surface, target)) this.pendingTarget = target;
	}

	getEphemeralState(): Record<string, unknown> {
		const cursor = this.surface.absPath ? this.surface.code.cursor() : null;
		return { ...super.getEphemeralState(), ...(cursor ? { heronCursor: cursor } : {}) };
	}

	/** True while the tab shows its file editable. */
	isEditing(): boolean { return this.mode === 'edit'; }

	/** Switches between reading and editing; leaving editing saves first. */
	setMode(mode: CodeMode) {
		if (mode === this.mode) return;
		if (mode === 'read') void this.save();
		this.mode = mode;
		this.applyMode();
		this.app.workspace.requestSaveLayout();
		this.plugin.updateStatusBar();
		if (mode === 'edit') this.surface.code.editor()?.focus();
	}

	/** Writes unsaved edits to the file. */
	async save(file: TFile | null = this.file) {
		if (!file || !this.surface.isDirty) return;
		const text = this.surface.text();
		this.lastSaved = text;
		this.plugin.rewind?.expectWrite(file.path, text);
		await this.app.vault.modify(file, text);
		if (this.surface.text() === text) this.surface.markSaved();
		this.warnedOutsideChange = false;
	}

	/** Shows the file as it is on disk, dropping unsaved edits (after a restore replaced them). */
	async reloadFromDisk() {
		if (!this.file) return;
		this.surface.markSaved();
		this.warnedOutsideChange = false;
		await this.loadContent(this.file, this.surface.code.cursor(), true);
	}

	private applyMode() {
		const editing = this.mode === 'edit';
		this.surface?.setEditable(editing);
		if (this.modeButton) {
			setIcon(this.modeButton, editing ? 'book-open' : 'pencil');
			this.modeButton.setAttr('aria-label', editing ? 'Stop editing (Mod+E)' : 'Edit (Mod+E)');
		}
	}

	/**
	 * The file changed on disk. Our own saves are ignored; otherwise reload,
	 * unless there are unsaved edits, which are kept until saved.
	 */
	private async changedOnDisk(file: TFile) {
		const disk = await this.app.vault.read(file);
		if (disk === this.lastSaved || disk === this.surface.text()) return;
		if (this.surface.isDirty) {
			if (!this.warnedOutsideChange) new Notice(`${file.name} changed outside Obsidian. Your unsaved edits are kept; saving will overwrite the other change.`);
			this.warnedOutsideChange = true;
			return;
		}
		await this.loadContent(file, this.surface.code.cursor(), true);
	}

	private async loadContent(file: TFile, cursor: CodeTarget['cursor'], keepScroll: boolean) {
		if (file.stat.size > MAX_VIEW_BYTES) {
			this.surface.showMessage(`${file.name} is too large to display (${formatBytes(file.stat.size)})`);
			return;
		}
		const text = await this.app.vault.read(file);
		if (this.file !== file) return;
		if (text.includes('\0')) {
			this.surface.showMessage(`${file.name} is a binary file`);
			return;
		}
		this.lastSaved = text;
		await this.surface.show(path.join(vaultBasePath(this.plugin), file.path), text, cursor ?? null, keepScroll);
	}
}

/**
 * Read-only code from outside the vault (or in folders Obsidian does not
 * list), e.g. a library's type stubs that a definition led to, or the
 * target of a link. Navigable like a file tab.
 */
export class ExternalCodeView extends ItemView implements CodeTab {
	navigation = true;
	private surface!: CodeSurface;
	private absPath = '';
	private pendingTarget: CodeTarget | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: HeronPlugin) {
		super(leaf);
		this.scope = new Scope(this.app.scope);
		registerKeys(this.scope, () => this.surface, plugin);
	}

	getViewType() { return EXTERNAL_CODE_VIEW_TYPE; }

	getIcon() { return 'code-2'; }

	getDisplayText() { return this.absPath ? path.basename(this.absPath) : 'Code'; }

	codeSurface(): CodeSurface { return this.surface; }

	onload() {
		super.onload();
		this.contentEl.addClass('heron-code-tab');
		this.surface = this.addChild(new CodeSurface(this.contentEl, surfaceHost(this.plugin, this.leaf)));
		addActions(this, () => this.surface, this.plugin, () => null);
		followSettings(this, () => this.surface, this.plugin);
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), absPath: this.absPath };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const absPath = (state as { absPath?: unknown } | null)?.absPath;
		if (typeof absPath === 'string' && absPath !== this.absPath) {
			this.absPath = absPath;
			const content = await readViewableFile(absPath);
			if (this.absPath !== absPath) return;
			const target = this.pendingTarget;
			this.pendingTarget = null;
			if (content.kind === 'text') {
				await this.surface.show(absPath, content.text, target?.cursor ?? null);
				if (target?.lines) this.surface.showLines(target.lines);
			} else {
				this.surface.showMessage(content.kind === 'missing' ? `${path.basename(absPath)} was not found` : `Cannot show ${path.basename(absPath)} (${content.kind})`);
			}
		}
		await super.setState(state, result);
	}

	setEphemeralState(state: unknown): void {
		super.setEphemeralState(state);
		const target = targetFrom(state);
		if (target && !applyTarget(this.surface, target)) this.pendingTarget = target;
	}

	getEphemeralState(): Record<string, unknown> {
		const cursor = this.surface.absPath ? this.surface.code.cursor() : null;
		return { ...super.getEphemeralState(), ...(cursor ? { heronCursor: cursor } : {}) };
	}
}
