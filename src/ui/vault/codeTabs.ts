import { FileSystemAdapter, FileView, ItemView, Menu, Notice, TFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import type SourceObserverPlugin from '../../main';
import type { FileLocation, Position } from '../../lsp/locations';
import { formatBytes, MAX_VIEW_BYTES, readViewableFile } from '../../utils/content';
import { displayPath } from '../../utils/paths';
import { copyToClipboard } from '../../utils/system';
import { CODE_EXTENSIONS } from '../editor/languages';
import { CodeSurface, CodeSurfaceHost } from './CodeSurface';

export const CODE_VIEW_TYPE = 'heron-code';
export const EXTERNAL_CODE_VIEW_TYPE = 'heron-external-code';

const CODE_EXTENSION_SET = new Set(CODE_EXTENSIONS);

/** Ephemeral state that places the cursor; `line` is what Obsidian's search uses. */
interface CursorState {
	heronCursor?: Position;
	line?: number;
}

function cursorFrom(state: unknown): Position | null {
	if (!state || typeof state !== 'object') return null;
	const s = state as CursorState;
	if (s.heronCursor && typeof s.heronCursor.line === 'number') return s.heronCursor;
	if (typeof s.line === 'number') return { line: s.line, character: 0 };
	return null;
}

/** A tab showing code, so commands and the status bar can find its surface. */
export interface CodeTab {
	codeSurface(): CodeSurface;
}

export function isCodeTab(view: unknown): view is CodeTab {
	return !!view && typeof (view as Partial<CodeTab>).codeSurface === 'function';
}

/** The vault's folder on disk, or '' on adapters without one (mobile). */
export function vaultBasePath(plugin: SourceObserverPlugin): string {
	const adapter = plugin.app.vault.adapter;
	return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
}

/**
 * Shows `loc` in `leaf`: a vault file through Obsidian (so it joins the
 * tab's history), anything else in an external code tab.
 */
async function openLocation(plugin: SourceObserverPlugin, leaf: WorkspaceLeaf, loc: FileLocation): Promise<CodeSurface | null> {
	const base = vaultBasePath(plugin);
	const rel = base ? path.relative(base, loc.absPath) : '';
	const vaultFile = rel && !rel.startsWith('..') && !path.isAbsolute(rel)
		? plugin.app.vault.getAbstractFileByPath(rel.split(path.sep).join('/'))
		: null;
	if (vaultFile instanceof TFile) {
		await leaf.openFile(vaultFile, { eState: { heronCursor: loc.position } });
	} else {
		await leaf.setViewState({ type: EXTERNAL_CODE_VIEW_TYPE, state: { absPath: loc.absPath }, active: true }, { heronCursor: loc.position });
	}
	return isCodeTab(leaf.view) ? leaf.view.codeSurface() : null;
}

function surfaceHost(plugin: SourceObserverPlugin, leaf: WorkspaceLeaf): CodeSurfaceHost {
	return {
		app: plugin.app,
		lsp: plugin.lsp,
		fontSize: plugin.settings.fontSize,
		wordWrap: plugin.settings.wordWrap,
		open: (loc) => openLocation(plugin, leaf, loc),
		label: (absPath) => displayPath(absPath, vaultBasePath(plugin)),
		onStatus: () => plugin.updateStatusBar(),
	};
}

/** Keeps a surface's font size and wrapping in line with the settings. */
function followSettings(view: ItemView, surface: () => CodeSurface, plugin: SourceObserverPlugin) {
	view.registerEvent(plugin.settingsEvents.on('changed', () => {
		surface().code.setFontSize(plugin.settings.fontSize);
		surface().code.setWordWrap(plugin.settings.wordWrap);
	}));
}

/** Header buttons shared by both code tabs. */
function addActions(view: ItemView, surface: () => CodeSurface, plugin: SourceObserverPlugin, file: () => TFile | null) {
	const blame = view.addAction('user', 'Show blame', () => {
		const on = surface().toggleBlame();
		blame.toggleClass('is-active', on);
		blame.setAttr('aria-label', on ? 'Hide blame' : 'Show blame');
	});
	view.addAction('compass', 'Code navigation', (evt) => {
		const s = surface();
		const menu = new Menu();
		menu.addItem((i) => i.setTitle('Go to definition').setIcon('arrow-right').onClick(() => s.goTo('definition')));
		menu.addItem((i) => i.setTitle('Find references').setIcon('list').onClick(() => s.findReferences()));
		menu.addItem((i) => i.setTitle('Go to symbol in file…').setIcon('hash').onClick(() => s.goToSymbolInFile()));
		menu.addItem((i) => i.setTitle('Go to symbol in project…').setIcon('search').onClick(() => s.goToSymbolInProject()));
		menu.showAtMouseEvent(evt);
	});
	view.addAction('link', 'Copy link to file', () => {
		const f = file();
		if (f) void copyToClipboard(plugin.app.fileManager.generateMarkdownLink(f, ''), `Copied link to ${f.name}`);
		else new Notice('Only files in the vault can be linked');
	});
}

/**
 * Code files in the vault open here, the way PDFs open in Obsidian's PDF
 * viewer: one tab per file, read-only, with language server navigation.
 */
export class CodeFileView extends FileView implements CodeTab {
	private surface!: CodeSurface;
	private pendingCursor: Position | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: SourceObserverPlugin) {
		super(leaf);
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
		addActions(this, () => this.surface, this.plugin, () => this.file);
		followSettings(this, () => this.surface, this.plugin);
		this.registerEvent(this.app.vault.on('modify', (f) => {
			if (f instanceof TFile && f === this.file) void this.loadContent(f, this.surface.code.cursor());
		}));
	}

	async onLoadFile(file: TFile): Promise<void> {
		const cursor = this.pendingCursor;
		this.pendingCursor = null;
		await this.loadContent(file, cursor);
	}

	async onUnloadFile(): Promise<void> {
		this.surface.clear();
	}

	setEphemeralState(state: unknown): void {
		super.setEphemeralState(state);
		const cursor = cursorFrom(state);
		if (!cursor) return;
		if (this.surface.absPath) this.surface.moveCursor(cursor);
		else this.pendingCursor = cursor;
	}

	getEphemeralState(): Record<string, unknown> {
		const cursor = this.surface.absPath ? this.surface.code.cursor() : null;
		return { ...super.getEphemeralState(), ...(cursor ? { heronCursor: cursor } : {}) };
	}

	private async loadContent(file: TFile, cursor: Position | null) {
		if (file.stat.size > MAX_VIEW_BYTES) {
			this.surface.showMessage(`${file.name} is too large to display (${formatBytes(file.stat.size)})`);
			return;
		}
		const text = await this.app.vault.cachedRead(file);
		if (this.file !== file) return;
		if (text.includes('\0')) {
			this.surface.showMessage(`${file.name} is a binary file`);
			return;
		}
		await this.surface.show(path.join(vaultBasePath(this.plugin), file.path), text, cursor);
	}
}

/**
 * Read-only code from outside the vault, e.g. a library's type stubs that a
 * definition led to. Navigable like a file tab.
 */
export class ExternalCodeView extends ItemView implements CodeTab {
	navigation = true;
	private surface!: CodeSurface;
	private absPath = '';

	constructor(leaf: WorkspaceLeaf, private plugin: SourceObserverPlugin) {
		super(leaf);
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
			if (content.kind === 'text') await this.surface.show(absPath, content.text, null);
			else this.surface.showMessage(`Cannot show ${path.basename(absPath)} (${content.kind})`);
		}
		await super.setState(state, result);
	}

	setEphemeralState(state: unknown): void {
		super.setEphemeralState(state);
		const cursor = cursorFrom(state);
		if (cursor) this.surface.moveCursor(cursor);
	}
}
