import { Events, Notice, Plugin, sanitizeHTMLToDom, WorkspaceLeaf } from 'obsidian';
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

/** Root plugin class — registers the view, ribbon icon, commands, links, and settings tab. */
export default class SourceObserverPlugin extends Plugin {
	settings!: SourceObserverSettings;
	/** Fires 'changed' after settings are persisted so open views can re-render. */
	settingsEvents = new Events();
	lsp!: LspManager;
	/** Servers whose failure was already reported, so browsing doesn't repeat the notice. */
	private reportedFailures = new Set<string>();
	private statusBarEl!: HTMLElement;

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
		if (base) this.addChild(new ExplorerGit(this.app, base));

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
