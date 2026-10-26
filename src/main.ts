import { Events, Notice, Plugin, sanitizeHTMLToDom, TFile } from 'obsidian';
import * as path from 'path';
import { registerCommands } from './commands';
import type { ChangeEntry } from './git/status';
import type { FileCommit } from './git/history';
import { registerLinks } from './links/register';
import type { SourceLocation } from './links/sourceLink';
import { LspManager } from './lsp/LspManager';
import { HeronSettings, sanitizeSettings, setBaseBranch, setBaseCompare } from './settings';
import { registerCodeMaps } from './ui/codemap/register';
import { CODE_EXTENSIONS } from './ui/editor/languages';
import { GitHubFeature } from './ui/github/GitHubFeature';
import { CodeNotesFeature } from './ui/notes/CodeNotesFeature';
import { HeronSettingTab } from './ui/SettingTab';
import { CHANGES_VIEW_TYPE, ChangesView } from './ui/vault/ChangesView';
import { CodeSearchModal, hitPath, SearchRepo } from './ui/vault/CodeSearchModal';
import { CODE_VIEW_TYPE, CodeFileView, EXTERNAL_CODE_VIEW_TYPE, ExternalCodeView, isCodeTab, vaultBasePath } from './ui/vault/codeTabs';
import { DIFF_VIEW_TYPE, DiffState, DiffView } from './ui/vault/DiffView';
import { ExplorerGit } from './ui/vault/ExplorerGit';
import { openCodeFile, openSourceLocation } from './ui/vault/openCode';
import { OUTLINE_VIEW_TYPE, OutlineView } from './ui/vault/OutlineView';
import type { Rewind } from './ui/vault/rewind/Rewind';
import { registerRewind } from './ui/vault/rewind/register';
import { REWIND_VIEW_TYPE, RewindView } from './ui/vault/rewind/RewindView';

/**
 * Heron: code inside the vault opens in tabs, with language servers, git
 * panels, Rewind, pull requests, code maps and margin notes. The plugin
 * class only wires features together.
 */
export default class HeronPlugin extends Plugin {
	settings!: HeronSettings;
	/** Fires 'changed' after settings are persisted so open views can re-render. */
	settingsEvents = new Events();
	lsp!: LspManager;
	/** Servers whose failure was already reported, so browsing doesn't repeat the notice. */
	private reportedFailures = new Set<string>();
	private statusBarEl!: HTMLElement;
	/** Git state of the repositories in the vault; null on adapters without a folder. */
	vaultGit: ExplorerGit | null = null;
	/** Rewind's local history of changes; null on adapters without a folder. */
	rewind: Rewind | null = null;
	/** Pull requests from GitHub and GitHub Enterprise. */
	github!: GitHubFeature;
	/** Margin notes and model actions in code tabs. */
	codeNotes!: CodeNotesFeature;

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

		this.registerView(CODE_VIEW_TYPE, (leaf) => new CodeFileView(leaf, this));
		this.registerView(EXTERNAL_CODE_VIEW_TYPE, (leaf) => new ExternalCodeView(leaf, this));
		this.registerCodeExtensions();

		const base = vaultBasePath(this);
		if (base) this.vaultGit = this.addChild(new ExplorerGit(this.app, base));

		this.registerView(OUTLINE_VIEW_TYPE, (leaf) => new OutlineView(leaf));
		this.registerView(CHANGES_VIEW_TYPE, (leaf) => new ChangesView(leaf, {
			git: () => this.vaultGit,
			base: {
				isOn: (repo) => this.settings.baseCompareRepos.includes(repo.commonDir),
				setOn: (repo, on) => {
					this.settings.baseCompareRepos = setBaseCompare(this.settings.baseCompareRepos, repo.commonDir, on);
					void this.saveSettings();
				},
				branch: (repo) => this.settings.baseBranches[repo.commonDir] ?? null,
				setBranch: (repo, branch) => {
					this.settings.baseBranches = setBaseBranch(this.settings.baseBranches, repo.commonDir, branch);
					void this.saveSettings();
				},
				onChange: (listener) => {
					const ref = this.settingsEvents.on('changed', listener);
					return () => this.settingsEvents.offref(ref);
				},
			},
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
			openFile: (absPath) => { void openCodeFile(this.app, vaultBasePath(this), leaf, absPath); },
			onRepoChange: (listener) => this.vaultGit?.onChange(listener) ?? (() => undefined),
		}));
		this.github = new GitHubFeature(this);
		this.github.register();
		this.app.workspace.onLayoutReady(() => { void this.addSidebarPanelsOnce(); });
		this.rewind = registerRewind(this);
		this.codeNotes = this.addChild(new CodeNotesFeature(this));

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('heron-status');
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateStatusBar()));
		this.register(this.lsp.onChange(() => this.updateStatusBar()));

		registerCommands(this);
		registerLinks(this);
		registerCodeMaps(this);

		this.addSettingTab(new HeronSettingTab(this.app, this));
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
	async revealPanel(type: string, state?: Record<string, unknown>) {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(type)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? undefined;
			await leaf?.setViewState({ type, active: true, state });
		} else if (state) {
			await leaf.setViewState({ type, active: true, state });
		}
		if (leaf) await workspace.revealLeaf(leaf);
	}

	/** The repository of the file in the active tab, if it is in one of the vault's repositories. */
	activeRepo() {
		const file = this.app.workspace.getActiveFile();
		return file ? this.vaultGit?.repoAt(file.path) ?? null : null;
	}

	/** Shows the commits of the active file in the Rewind panel. */
	async showFileHistory() {
		await this.revealPanel(REWIND_VIEW_TYPE, { scope: 'commits' });
		const view = this.app.workspace.getLeavesOfType(REWIND_VIEW_TYPE)[0]?.view;
		if (view instanceof RewindView) view.setScope('commits');
	}

	/** Switches the active file's repository between uncommitted changes and changes against its base branch. */
	async toggleBaseComparison() {
		const at = this.activeRepo();
		if (!at) return;
		const on = this.settings.baseCompareRepos.includes(at.repo.commonDir);
		this.settings.baseCompareRepos = setBaseCompare(this.settings.baseCompareRepos, at.repo.commonDir, !on);
		await this.saveSettings();
		await this.revealPanel(CHANGES_VIEW_TYPE);
	}

	/** Opens the diff of `entry` (in the repository at vault path `repoRel`) in a tab. */
	async openDiff(repoRel: string, entry: ChangeEntry, newTab: boolean) {
		const root = path.join(vaultBasePath(this), repoRel);
		const state: DiffState = entry.group === 'base' && entry.base
			? { root, file: entry.file.path, group: 'base', baseRef: entry.base.ref }
			: { root, file: entry.file.path, group: entry.group };
		await this.app.workspace.getLeaf(newTab ? 'tab' : false).setViewState({ type: DIFF_VIEW_TYPE, state: { ...state }, active: true });
	}

	/** Opens the change `commit` made to its file, in the repository at `root`. */
	async openCommitDiff(root: string, commit: FileCommit, newTab: boolean) {
		const state: DiffState = { root, file: commit.path, commit };
		await this.app.workspace.getLeaf(newTab ? 'tab' : false).setViewState({ type: DIFF_VIEW_TYPE, state: { ...state }, active: true });
	}

	/** Opens a file in the vault by its vault path. */
	async openVaultFile(vaultPath: string, newTab: boolean) {
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (file instanceof TFile) await this.app.workspace.getLeaf(newTab ? 'tab' : false).openFile(file);
	}

	/** Opens a link's or embed's file at its lines: a vault file in its tab, anything else read-only. */
	async openLocation(loc: SourceLocation, newTab: boolean) {
		await openSourceLocation(this.app, vaultBasePath(this), loc, newTab);
	}

	/** The vault's repositories to search, the active file's first. */
	searchRepos(): SearchRepo[] {
		const active = this.activeRepo()?.rel;
		const repos = (this.vaultGit?.vaultRepos() ?? [])
			.flatMap(({ rel, snapshot }) => (snapshot.kind === 'repo' ? [{ repo: snapshot.repo, vaultPath: rel }] : []));
		return repos.sort((a, b) => Number(b.vaultPath === active) - Number(a.vaultPath === active));
	}

	/** Opens **Search in code**, filled with the active code tab's selection when it is on one line. */
	searchInCode() {
		const view = this.app.workspace.getMostRecentLeaf()?.view;
		const selected = isCodeTab(view) ? view.codeSurface().selectedText() : '';
		const initial = selected && !selected.includes('\n') ? selected : '';
		new CodeSearchModal(this.app, () => this.searchRepos(), initial, (hit, newTab) => {
			const leaf = this.app.workspace.getLeaf(newTab ? 'tab' : false);
			const line = hit.match.line;
			void openCodeFile(this.app, vaultBasePath(this), leaf, hitPath(hit), { lines: { from: line, to: line } });
		}).open();
	}

	/** Shows the active code tab's language server in the status bar. */
	updateStatusBar() {
		const el = this.statusBarEl;
		if (!el) return;
		const view = this.app.workspace.getMostRecentLeaf()?.view;
		const surface = isCodeTab(view) ? view.codeSurface() : null;
		const status = surface?.status ?? null;
		el.empty();
		el.toggle(!!surface?.absPath);
		if (!surface?.absPath) return;
		const mode = el.createSpan({ cls: 'heron-status-mode' });
		mode.setText(surface.isEditable ? (surface.isDirty ? 'Editing · unsaved' : 'Editing') : 'Reading');
		mode.toggleClass('is-dirty', surface.isDirty);
		if (!status) return;
		el.removeClass('is-starting', 'is-ready', 'is-failed', 'is-busy');
		el.addClass(`is-${status.kind}`);
		const busy = status.kind === 'ready' && status.busy;
		if (busy) el.addClass('is-busy');
		el.createSpan({ cls: 'heron-status-sep', text: '·' });
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

	async loadSettings() {
		this.settings = sanitizeSettings(await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.settingsEvents.trigger('changed');
	}
}
