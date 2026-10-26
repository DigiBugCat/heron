import { Notice } from 'obsidian';
import type HeronPlugin from './main';
import { COPY_FORMATS, CopyFormat } from './links/sourceLink';
import type { JumpKind } from './ui/pane/codeIntel';
import { registerGitHubCommands } from './ui/github/commands';
import { registerCodeNoteCommands } from './ui/notes/noteCommands';
import { CHANGES_VIEW_TYPE } from './ui/vault/ChangesView';
import type { CodeSurface } from './ui/vault/CodeSurface';
import { copyFromSurface, isCodeTab } from './ui/vault/codeTabs';
import { OUTLINE_VIEW_TYPE } from './ui/vault/OutlineView';

const COPY_COMMANDS: Record<CopyFormat, { id: string; name: string }> = {
	link: { id: 'copy-link', name: 'Copy link to file or selection' },
	embed: { id: 'copy-embed', name: 'Copy embed of file or selection' },
	code: { id: 'copy-code-block', name: 'Copy file or selection as code block' },
};

/** Registers the command palette commands. IDs are stable; do not rename them. */
export function registerCommands(plugin: HeronPlugin) {
	/** The active code tab's surface while it shows a file. */
	const activeSurface = (): CodeSurface | null => {
		const view = plugin.app.workspace.getMostRecentLeaf()?.view;
		const surface = isCodeTab(view) ? view.codeSurface() : null;
		return surface?.absPath ? surface : null;
	};

	/** For `checkCallback`: runs `action` on the active code tab when `applies` holds. */
	const onSurface = (
		checking: boolean,
		applies: (surface: CodeSurface) => boolean,
		action: (surface: CodeSurface) => void,
	): boolean => {
		const surface = activeSurface();
		if (!surface || !applies(surface)) return false;
		if (!checking) action(surface);
		return true;
	};

	/** Navigation commands apply while the active code tab has a language server. */
	const onNavigator = (checking: boolean, action: (surface: CodeSurface) => void) =>
		onSurface(checking, (s) => s.hasCodeIntel(), action);

	/** Commands about the active file's repository apply while it is in one. */
	const inRepo = (checking: boolean, action: () => void): boolean => {
		if (!plugin.activeRepo()) return false;
		if (!checking) action();
		return true;
	};

	plugin.addCommand({
		id: 'find-in-file',
		name: 'Find in file',
		checkCallback: (checking) => onSurface(checking, () => true, (s) => { s.openSearch(); }),
	});

	plugin.addCommand({
		id: 'go-to-line',
		name: 'Go to line',
		checkCallback: (checking) => onSurface(checking, () => true, (s) => { s.goToLine(); }),
	});

	plugin.addCommand({
		id: 'search-in-files',
		name: 'Search in code',
		checkCallback: (checking) => {
			if (!plugin.vaultGit) return false;
			if (!checking) plugin.searchInCode();
			return true;
		},
	});

	plugin.addCommand({
		id: 'show-file-history',
		name: 'Show file history',
		checkCallback: (checking) => inRepo(checking, () => { void plugin.showFileHistory(); }),
	});

	plugin.addCommand({
		id: 'toggle-blame',
		name: 'Toggle blame',
		checkCallback: (checking) => onSurface(checking, () => true, (s) => { s.toggleBlame(); }),
	});

	plugin.addCommand({
		id: 'toggle-compare-with-base',
		name: 'Toggle changes against base branch',
		checkCallback: (checking) => inRepo(checking, () => { void plugin.toggleBaseComparison(); }),
	});

	const jumps: { id: string; name: string; kind: JumpKind }[] = [
		{ id: 'go-to-definition', name: 'Go to definition', kind: 'definition' },
		{ id: 'go-to-type-definition', name: 'Go to type definition', kind: 'typeDefinition' },
		{ id: 'go-to-implementation', name: 'Go to implementation', kind: 'implementation' },
		{ id: 'go-to-declaration', name: 'Go to declaration', kind: 'declaration' },
	];
	for (const { id, name, kind } of jumps) {
		plugin.addCommand({
			id,
			name,
			checkCallback: (checking) => onNavigator(checking, (s) => s.goTo(kind)),
		});
	}

	plugin.addCommand({
		id: 'find-references',
		name: 'Find references',
		checkCallback: (checking) => onNavigator(checking, (s) => s.findReferences()),
	});

	plugin.addCommand({
		id: 'go-to-symbol-in-file',
		name: 'Go to symbol in file…',
		checkCallback: (checking) => onNavigator(checking, (s) => s.goToSymbolInFile()),
	});

	plugin.addCommand({
		id: 'go-to-symbol-in-project',
		name: 'Go to symbol in project…',
		checkCallback: (checking) => onNavigator(checking, (s) => s.goToSymbolInProject()),
	});

	plugin.addCommand({
		id: 'show-code-outline',
		name: 'Show code outline',
		callback: () => { void plugin.revealPanel(OUTLINE_VIEW_TYPE); },
	});

	plugin.addCommand({
		id: 'show-code-changes',
		name: 'Show code changes',
		callback: () => { void plugin.revealPanel(CHANGES_VIEW_TYPE); },
	});

	plugin.addCommand({
		id: 'restart-language-servers',
		name: 'Restart language servers',
		callback: () => {
			plugin.restartLanguageServers();
			new Notice('Language servers will restart when needed');
		},
	});

	registerGitHubCommands(plugin, plugin.github);
	registerCodeNoteCommands(plugin, plugin.codeNotes);

	for (const { format } of COPY_FORMATS) {
		plugin.addCommand({
			...COPY_COMMANDS[format],
			checkCallback: (checking) => onSurface(checking, (s) => !!s.projectRoot, (s) => copyFromSurface(s, format)),
		});
	}
}
