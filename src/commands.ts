import { Notice } from 'obsidian';
import type SourceObserverPlugin from './main';
import type { CodeNavigator } from './ui/vault/CodeSurface';
import { isCodeTab } from './ui/vault/codeTabs';
import { CHANGES_VIEW_TYPE } from './ui/vault/ChangesView';
import { OUTLINE_VIEW_TYPE } from './ui/vault/OutlineView';
import type { JumpKind } from './ui/pane/codeIntel';
import { COPY_FORMATS, CopyFormat } from './links/sourceLink';
import { SourceObserverView } from './ui/SourceObserverView';
import { registerCodeNoteCommands } from './ui/notes/noteCommands';

const COPY_COMMANDS: Record<CopyFormat, { id: string; name: string }> = {
	link: { id: 'copy-link', name: 'Copy link to file or selection' },
	embed: { id: 'copy-embed', name: 'Copy embed of file or selection' },
	code: { id: 'copy-code-block', name: 'Copy file or selection as code block' },
};

/** Registers the command palette commands. IDs are stable; do not rename them. */
export function registerCommands(plugin: SourceObserverPlugin) {
	/** For `checkCallback`: runs `action` on the active view when `applies` holds. */
	const onActiveView = (
		checking: boolean,
		applies: (view: SourceObserverView) => boolean,
		action: (view: SourceObserverView) => void,
	): boolean => {
		const view = plugin.app.workspace.getActiveViewOfType(SourceObserverView);
		if (!view || !applies(view)) return false;
		if (!checking) action(view);
		return true;
	};

	/** The active folder view or code tab, for navigation commands. */
	const onNavigator = (checking: boolean, action: (nav: CodeNavigator) => void): boolean => {
		const view = plugin.app.workspace.getMostRecentLeaf()?.view;
		const nav: CodeNavigator | null = view instanceof SourceObserverView ? view : isCodeTab(view) ? view.codeSurface() : null;
		if (!nav?.hasCodeIntel()) return false;
		if (!checking) action(nav);
		return true;
	};

	plugin.addCommand({
		id: 'open',
		name: 'Open',
		callback: () => { void plugin.activateView(); },
	});

	plugin.addCommand({
		id: 'open-folder',
		name: 'Open folder…',
		callback: () => {
			void plugin.activateView().then((view) => view?.promptForFolder());
		},
	});

	plugin.addCommand({
		id: 'find-in-file',
		name: 'Find in file',
		checkCallback: (checking) => onActiveView(checking, (v) => v.hasEditor(), (v) => v.findInFile()),
	});

	plugin.addCommand({
		id: 'go-to-line',
		name: 'Go to line',
		checkCallback: (checking) => onActiveView(checking, (v) => v.hasEditor(), (v) => v.goToLine()),
	});

	plugin.addCommand({
		id: 'search-in-files',
		name: 'Search in files',
		callback: () => {
			void plugin.activateView().then((view) => view?.searchInFiles());
		},
	});

	plugin.addCommand({
		id: 'show-file-history',
		name: 'Show file history',
		checkCallback: (checking) => onActiveView(checking, (v) => v.canShowHistory(), (v) => v.showFileHistory()),
	});

	plugin.addCommand({
		id: 'toggle-blame',
		name: 'Toggle blame',
		checkCallback: (checking) => onActiveView(checking, (v) => v.canToggleBlame(), (v) => v.toggleBlame()),
	});

	plugin.addCommand({
		id: 'toggle-compare-with-base',
		name: 'Toggle changes against base branch',
		checkCallback: (checking) => onActiveView(checking, (v) => v.hasRepo(), (v) => v.toggleBaseComparison()),
	});

	plugin.addCommand({
		id: 'switch-worktree',
		name: 'Switch worktree…',
		checkCallback: (checking) => onActiveView(checking, (v) => v.hasRepo(), (v) => { void v.showWorktrees(); }),
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
			checkCallback: (checking) => onNavigator(checking, (v) => v.goTo(kind)),
		});
	}

	plugin.addCommand({
		id: 'find-references',
		name: 'Find references',
		checkCallback: (checking) => onNavigator(checking, (v) => v.findReferences()),
	});

	plugin.addCommand({
		id: 'go-to-symbol-in-file',
		name: 'Go to symbol in file…',
		checkCallback: (checking) => onNavigator(checking, (v) => v.goToSymbolInFile()),
	});

	plugin.addCommand({
		id: 'go-to-symbol-in-project',
		name: 'Go to symbol in project…',
		checkCallback: (checking) => onNavigator(checking, (v) => v.goToSymbolInProject()),
	});

	plugin.addCommand({
		id: 'go-back',
		name: 'Go back',
		checkCallback: (checking) => onActiveView(checking, (v) => v.canGoBack(), (v) => v.goBack()),
	});

	plugin.addCommand({
		id: 'go-forward',
		name: 'Go forward',
		checkCallback: (checking) => onActiveView(checking, (v) => v.canGoForward(), (v) => v.goForward()),
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

	registerCodeNoteCommands(plugin, plugin.codeNotes);

	for (const { format } of COPY_FORMATS) {
		plugin.addCommand({
			...COPY_COMMANDS[format],
			checkCallback: (checking) => onActiveView(checking, (v) => v.canCopyLink(), (v) => v.copyFromEditor(format)),
		});
	}
}
