import { App, Modal, Notice, Setting } from 'obsidian';
import * as path from 'path';
import type HeronPlugin from '../../../main';
import { hookSettings, installHookScript } from '../../../services/rewind/claudeHook';
import type { Moment, MomentFile } from '../../../services/rewind/moments';
import { heronDataDir } from '../../../utils/appData';
import { copyToClipboard } from '../../../utils/system';
import { vaultBasePath } from '../codeTabs';
import { momentTime, RewindActions } from './actions';
import { MAX_COMMITS } from './CommitList';
import { Rewind } from './Rewind';
import { REWIND_DIFF_VIEW_TYPE, RewindDiffState, RewindDiffView } from './RewindDiffView';
import { REWIND_SNAPSHOT_VIEW_TYPE, RewindSnapshotView, SnapshotState } from './RewindSnapshotView';
import { REWIND_VIEW_TYPE, RewindView } from './RewindView';

/** Shows where the hook script was saved and the settings to paste into Claude Code. */
class HookSetupModal extends Modal {
	constructor(app: App, private scriptPath: string) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText('Claude Code hooks for Rewind');
		const json = JSON.stringify(hookSettings(this.scriptPath), null, 2);
		this.contentEl.createEl('p', { text: `The hook script is saved at ${this.scriptPath}. Add these hooks to ~/.claude/settings.json (or a project's .claude/settings.json), merging with any hooks you already have. Claude Code needs Node.js on its PATH to run the script.` });
		this.contentEl.createEl('pre', { cls: 'heron-rewind-hook-json', text: json });
		new Setting(this.contentEl).addButton((b) => b.setButtonText('Copy settings').setCta().onClick(() => {
			void copyToClipboard(json, 'Copied Claude Code hook settings');
		}));
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * Sets up Rewind: the recorder, its panel and tabs, and its commands.
 * Returns null on adapters without a folder on disk.
 */
export function registerRewind(plugin: HeronPlugin): Rewind | null {
	const base = vaultBasePath(plugin);
	const git = plugin.vaultGit;
	if (!base || !git) return null;
	const { app } = plugin;
	const rewind = plugin.addChild(new Rewind(plugin, base, git));
	const actions = new RewindActions(app, rewind);

	const openDiff = async (moment: Moment, file: MomentFile, newTab: boolean) => {
		const state: RewindDiffState = { path: file.path, before: file.before, after: file.after, title: `${moment.label} · ${momentTime(moment.end)}` };
		await app.workspace.getLeaf(newTab ? 'tab' : false).setViewState({ type: REWIND_DIFF_VIEW_TYPE, state: { ...state }, active: true });
	};
	const viewAsOf = async (moment: Moment, file: MomentFile) => {
		const state: SnapshotState = { path: file.path, moment: moment.id };
		await app.workspace.getLeaf('tab').setViewState({ type: REWIND_SNAPSHOT_VIEW_TYPE, state: { ...state }, active: true });
	};
	const openFile = (vaultPath: string) => { void plugin.openVaultFile(vaultPath, false); };

	plugin.registerView(REWIND_VIEW_TYPE, (leaf) => new RewindView(leaf, {
		enabled: () => rewind.enabled,
		moments: () => rewind.moments(),
		repoOf: (p) => rewind.repoOf(p),
		onChange: (l) => rewind.onChange(l),
		openDiff: (m, f, newTab) => { void openDiff(m, f, newTab); },
		viewAsOf: (m, f) => { void viewAsOf(m, f); },
		restoreFile: (m, f, side) => { void actions.restoreFile(m, f, side); },
		undoMoment: (m) => { void actions.undoMoment(m); },
		fileCommits: async (vaultPath) => {
			const at = git.repoAt(vaultPath);
			const repoPath = at?.repo.repoPath(path.join(base, vaultPath));
			return at && repoPath ? at.repo.fileHistory(repoPath, MAX_COMMITS) : null;
		},
		openCommit: (vaultPath, commit, newTab) => {
			const at = git.repoAt(vaultPath);
			// The repository's folder in the vault (its root), so the diff's file opens as a vault file.
			if (at) void plugin.openCommitDiff(at.repo.folder, commit, newTab);
		},
		onGitChange: (l) => git.onChange(l),
	}));
	plugin.registerView(REWIND_DIFF_VIEW_TYPE, (leaf) => new RewindDiffView(leaf, {
		fontSize: () => plugin.settings.fontSize,
		wordWrap: () => plugin.settings.wordWrap,
		layout: () => plugin.settings.diffLayout,
		setLayout: (layout) => {
			plugin.settings.diffLayout = layout;
			void plugin.saveSettings();
		},
		readText: (hash) => rewind.readText(hash),
		openFile,
	}));
	plugin.registerView(REWIND_SNAPSHOT_VIEW_TYPE, (leaf) => new RewindSnapshotView(leaf, {
		fontSize: () => plugin.settings.fontSize,
		wordWrap: () => plugin.settings.wordWrap,
		moments: () => rewind.moments(),
		readText: (hash) => rewind.readText(hash),
		onChange: (l) => rewind.onChange(l),
		openFile,
		restore: (m, f) => { void actions.restoreFile(m, f, 'after'); },
	}));

	app.workspace.onLayoutReady(async () => {
		if (plugin.settings.rewindPanelAdded) return;
		if (!app.workspace.getLeavesOfType(REWIND_VIEW_TYPE).length) {
			await app.workspace.getRightLeaf(false)?.setViewState({ type: REWIND_VIEW_TYPE, active: false });
		}
		plugin.settings.rewindPanelAdded = true;
		await plugin.saveSettings();
	});

	plugin.addCommand({
		id: 'show-rewind',
		name: 'Show Rewind',
		callback: () => { void plugin.revealPanel(REWIND_VIEW_TYPE); },
	});

	plugin.addCommand({
		id: 'undo-last-moment-in-file',
		name: 'Undo last moment in this file',
		checkCallback: (checking) => {
			const file = app.workspace.getActiveFile();
			if (!file || !rewind.enabled || !rewind.repoOf(file.path)) return false;
			if (!checking) void actions.undoLastInFile(file.path);
			return true;
		},
	});

	plugin.addCommand({
		id: 'set-up-claude-code-hooks',
		name: 'Set up Claude Code hooks for Rewind',
		callback: async () => {
			try {
				const script = await installHookScript(heronDataDir());
				new HookSetupModal(app, script).open();
			} catch (err) {
				new Notice(`Cannot save the hook script: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	return rewind;
}
