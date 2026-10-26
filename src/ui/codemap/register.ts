import { TFolder } from 'obsidian';
import type HeronPlugin from '../../main';
import { isCodeTab, vaultBasePath } from '../vault/codeTabs';
import { CodeMaps } from './CodeMaps';

/** Adds the code map commands and the "Generate code map" item of the file explorer's folder menu. */
export function registerCodeMaps(plugin: HeronPlugin): CodeMaps {
	const { app } = plugin;
	const maps = new CodeMaps({
		app,
		folder: () => plugin.settings.codeMapFolder,
		basePath: () => vaultBasePath(plugin),
		git: () => plugin.vaultGit,
	});
	// Code maps read files from disk, which needs a vault folder (desktop).
	const available = () => !!vaultBasePath(plugin);

	plugin.addCommand({
		id: 'generate-code-map',
		name: 'Generate code map for this repository',
		checkCallback: (checking) => {
			if (!available()) return false;
			if (!checking) maps.generateForRepository(app.workspace.getActiveFile());
			return true;
		},
	});

	plugin.addCommand({
		id: 'generate-code-map-for-folder',
		name: 'Generate code map for folder…',
		checkCallback: (checking) => {
			if (!available()) return false;
			if (!checking) maps.pickFolder();
			return true;
		},
	});

	plugin.addCommand({
		id: 'update-code-map',
		name: 'Update code map',
		checkCallback: (checking) => {
			const file = app.workspace.getActiveFile();
			if (!available() || !file || !maps.isCodeMap(file)) return false;
			if (!checking) void maps.update(file);
			return true;
		},
	});

	plugin.addCommand({
		id: 'show-call-graph',
		// "cursor" is the text cursor, not the Cursor editor the rule knows as a brand.
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		name: 'Show call graph for symbol at cursor',
		checkCallback: (checking) => {
			const view = app.workspace.getMostRecentLeaf()?.view;
			const surface = isCodeTab(view) ? view.codeSurface() : null;
			if (!available() || !surface?.hasCodeIntel()) return false;
			if (!checking) void maps.showCallGraph(() => surface.cursorRequest());
			return true;
		},
	});

	plugin.registerEvent(app.workspace.on('file-menu', (menu, file) => {
		if (!(file instanceof TFolder) || !available()) return;
		menu.addItem((item) => item
			.setTitle('Generate code map')
			.setIcon('map')
			.onClick(() => { void maps.generate(file); }));
	}));

	plugin.registerEvent(app.workspace.on('file-open', (file) => { void maps.noticeOpened(file); }));
	return maps;
}
