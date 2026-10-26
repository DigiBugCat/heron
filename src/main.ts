import { Events, Notice, Plugin, sanitizeHTMLToDom, TFile, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import { registerCommands } from './commands';
import { registerLinks } from './links/register';
import { LspManager } from './lsp/LspManager';
import type { SourceLocation } from './links/sourceLink';
import { sanitizeSettings, SourceObserverSettings } from './settings';
import { SourceObserverSettingTab } from './ui/SettingTab';
import { SourceObserverView, VIEW_TYPE } from './ui/SourceObserverView';
import { CODE_EXTENSIONS } from './ui/editor/languages';
import { CODE_VIEW_TYPE, CodeFileView, EXTERNAL_CODE_VIEW_TYPE, ExternalCodeView, isCodeTab, vaultBasePath } from './ui/vault/codeTabs';
import { ExplorerGit } from './ui/vault/ExplorerGit';
import { CHANGES_VIEW_TYPE, ChangesView } from './ui/vault/ChangesView';
import { DIFF_VIEW_TYPE, DiffState, DiffView } from './ui/vault/DiffView';
import { OUTLINE_VIEW_TYPE, OutlineView } from './ui/vault/OutlineView';
import type { ChangeEntry } from './git/status';

/** Root plugin class — registers the view, ribbon icon, commands, links, and settings tab. */
export default class SourceObserverPlugin extends Plugin {
	settings!: SourceObserverSettings;
	/** Fires 'changed' after settings are persisted so open views can re-render. */
	settingsEvents = new Events();
	lsp!: LspManager;
	/** Servers whose failure was already reported, so browsing doesn't repeat the notice. */
	private reportedFailures = new Set<string>();
	private statusBarEl!: HTMLElement;
	/** Git state of the repositories in the vault; null on adapters without a folder. */
	vaultGit: ExplorerGit | null = null;

	async onload() {
		await this.loadSettings();

		this.lsp = new LspManager({
			enabled: () => this.settings.languageServers,
			commands: () => this.settings.serverCommands,
			sanitizeHTML: (html) => {
				const el = activeDocument.createElement('div');
				el.append(sanitizeHTMLToDom(html));
				return el.innerHTML;
			},
			onFailure: (name, message) => {
				if (this.reportedFailures.has(name)) return;
				this.reportedFailures.add(name);
				new Notice(`Heron: ${name} is not available. ${message}`);
			},
		});
		this.register(() => this.lsp.stopAll());
		let lspConfig = this.lspConfigKey();
		this.registerEvent(this.settingsEvents.on('changed', () => {
			const key = this.lspConfigKey();
			if (key === lspConfig) return;
			lspConfig = key;
			this.restartLanguageServers();
		}));

		this.registerView(VIEW_TYPE, (leaf) => new SourceObserverView(leaf, this));
		this.registerView(CODE_VIEW_TYPE, (leaf) => new CodeFileView(leaf, this));
		this.registerView(EXTERNAL_CODE_VIEW_TYPE, (leaf) => new ExternalCodeView(leaf, this));
		this.registerCodeExtensions();

		const base = vaultBasePath(this);
		if (base) this.vaultGit = this.addChild(new ExplorerGit(this.app, base));

		this.registerView(OUTLINE_VIEW_TYPE, (leaf) => new OutlineView(leaf));
		this.registerView(CHANGES_VIEW_TYPE, (leaf) => new ChangesView(leaf, {
			git: () => this.vaultGit,
			openDiff: (repoRel, entry, newTab) => { void this.openDiff(repoRel, entry, newTab); },
			openFile: (vaultPath, newTab) => { void this.openVaultFile(vaultPath, newTab); },
		}));
		this.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf, {
			fontSize: () => this.settings.fontSize,
			wordWrap: () => this.settings.wordWrap,
			layout: () => this.settings.diffLayout,
			setLayout: (layout) => {
				this.settings.diffLayout = layout;
				void this.saveSettings();
			},
			openFile: (absPath) => {
				const rel = path.relative(vaultBasePath(this), absPath).split(path.sep).join('/');
				void this.openVaultFile(rel, false);
			},
			onRepoChange: (listener) => this.vaultGit?.onChange(listener) ?? (() => undefined),
		}));
		this.app.workspace.onLayoutReady(() => { void this.addSidebarPanelsOnce(); });

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('heron-status');
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateStatusBar()));
		this.register(this.lsp.onChange(() => this.updateStatusBar()));

		this.addRibbonIcon('code-2', 'Heron', () => { void this.activateView(); });

		registerCommands(this);
		registerLinks(this);

		this.addSettingTab(new SourceObserverSettingTab(this.app, this));
	}

	/** Opens the Heron tab, reusing an existing leaf if one is already open. */
	async activateView(): Promise<SourceObserverView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | undefined = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf('tab');
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		return leaf.view instanceof SourceObserverView ? leaf.view : null;
	}

	/**
	 * Opens code files in the vault in Heron's code tab. Extensions another
	 * plugin (or Obsidian) already handles are left alone.
	 */
	private registerCodeExtensions() {
		for (const ext of CODE_EXTENSIONS) {
			try {
				this.registerExtensions([ext], CODE_VIEW_TYPE);
			} catch { /* already registered elsewhere */ }
		}
	}

	/** Adds the outline and changes panels to the right sidebar the first time Heron runs. */
	private async addSidebarPanelsOnce() {
		if (this.settings.sidebarPanelsAdded) return;
		for (const type of [OUTLINE_VIEW_TYPE, CHANGES_VIEW_TYPE]) {
			if (!this.app.workspace.getLeavesOfType(type).length) {
				await this.app.workspace.getRightLeaf(false)?.setViewState({ type, active: false });
			}
		}
		this.settings.sidebarPanelsAdded = true;
		await this.saveSettings();
	}

	/** Shows a sidebar panel, adding it to the right sidebar if it was closed. */
	async revealPanel(type: string) {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(type)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? undefined;
			await leaf?.setViewState({ type, active: true });
		}
		if (leaf) await workspace.revealLeaf(leaf);
	}

	/** Opens the diff of `entry` (in the repository at vault path `repoRel`) in a tab. */
	async openDiff(repoRel: string, entry: ChangeEntry, newTab: boolean) {
		const state: DiffState = { root: path.join(vaultBasePath(this), repoRel), file: entry.file.path, group: entry.group };
		const leaf = this.app.workspace.getLeaf(newTab ? 'tab' : false);
		await leaf.setViewState({ type: DIFF_VIEW_TYPE, state: { ...state }, active: true });
	}

	/** Opens a file in the vault by its vault path. */
	async openVaultFile(vaultPath: string, newTab: boolean) {
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (file instanceof TFile) await this.app.workspace.getLeaf(newTab ? 'tab' : false).openFile(file);
	}

	/** Shows the active code tab's language server in the status bar. */
	updateStatusBar() {
		const el = this.statusBarEl;
		if (!el) return;
		const view = this.app.workspace.getMostRecentLeaf()?.view;
		const status = isCodeTab(view) ? view.codeSurface().status : null;
		el.empty();
		el.toggle(!!status);
		if (!status) return;
		el.removeClass('is-starting', 'is-ready', 'is-failed', 'is-busy');
		el.addClass(`is-${status.kind}`);
		const busy = status.kind === 'ready' && status.busy;
		if (busy) el.addClass('is-busy');
		el.createSpan({ cls: 'heron-status-dot' });
		el.createSpan({ text: status.kind === 'starting' ? `${status.name} starting…` : busy ? `${status.name} · ${busy}` : status.name });
		el.title = status.kind === 'failed' ? `${status.name} is not available: ${status.message}` : busy || `${status.name} is running`;
	}

	/** Stops all language servers; they start again, with current settings, when next needed. */
	restartLanguageServers() {
		this.reportedFailures.clear();
		this.lsp.stopAll();
	}

	private lspConfigKey(): string {
		return JSON.stringify([this.settings.languageServers, this.settings.serverCommands]);
	}

	/** Opens a file (and lines) from a link or embed, switching folders if needed. */
	async openLocation(loc: SourceLocation) {
		const view = await this.activateView();
		await view?.openLocation(loc);
	}

	async loadSettings() {
		this.settings = sanitizeSettings(await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.settingsEvents.trigger('changed');
	}
}
