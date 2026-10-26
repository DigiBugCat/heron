import type SourceObserverPlugin from '../../main';
import type { CodeNotesFeature } from './CodeNotesFeature';
import type { NotesController } from './NotesController';

/** Command palette commands for margin notes and model actions. IDs are stable; do not rename them. */
export function registerCodeNoteCommands(plugin: SourceObserverPlugin, feature: CodeNotesFeature) {
	const onNotes = (checking: boolean, action: (controller: NotesController) => void, needsModel = false): boolean => {
		const controller = feature.activeController();
		if (!controller || (needsModel && !plugin.settings.model.enabled)) return false;
		if (!checking) action(controller);
		return true;
	};

	plugin.addCommand({
		id: 'comment-on-selection',
		name: 'Comment on selection',
		checkCallback: (checking) => onNotes(checking, (c) => feature.comment(c)),
	});

	plugin.addCommand({
		id: 'show-code-notes',
		name: 'Show code notes',
		callback: () => { void feature.showPanel(); },
	});

	plugin.addCommand({
		id: 'explain-selection',
		name: 'Explain selection',
		checkCallback: (checking) => onNotes(checking, (c) => { void feature.model.explain(c); }, true),
	});

	plugin.addCommand({
		id: 'find-similar-code',
		name: 'Find similar code',
		checkCallback: (checking) => onNotes(checking, (c) => { void feature.model.findSimilar(c); }, true),
	});

	plugin.addCommand({
		id: 'diagram-symbol',
		name: 'Diagram this symbol',
		checkCallback: (checking) => onNotes(checking, (c) => { void feature.model.diagram(c, true); }, true),
	});

	plugin.addCommand({
		id: 'diagram-file',
		name: 'Diagram this file',
		checkCallback: (checking) => onNotes(checking, (c) => { void feature.model.diagram(c, false); }, true),
	});

	plugin.addCommand({
		id: 'cancel-model-actions',
		name: 'Cancel model actions',
		checkCallback: (checking) => {
			if (!feature.runs.active) return false;
			if (!checking) feature.runs.cancelAll();
			return true;
		},
	});
}
