import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { NotesController } from './NotesController';
import { NotesPanel, NotesPanelHost } from './NotesPanel';

export const CODE_NOTES_VIEW_TYPE = 'heron-code-notes';

export interface CodeNotesViewHost extends NotesPanelHost {
	/** The notes of the code tab most recently used in the main area, if any. */
	activeController(): NotesController | null;
	/** Calls `listener` when a code tab gets or loses its notes. */
	onControllersChange(listener: () => void): () => void;
}

/**
 * Right-sidebar panel with the margin notes of the active code file, like
 * the code outline: it follows whichever code tab was used last.
 */
export class CodeNotesView extends ItemView {
	private panel!: NotesPanel;

	constructor(leaf: WorkspaceLeaf, private host: CodeNotesViewHost) {
		super(leaf);
	}

	getViewType() { return CODE_NOTES_VIEW_TYPE; }

	getDisplayText() { return 'Code notes'; }

	getIcon() { return 'message-square'; }

	onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('heron-panel');
		this.panel = this.addChild(new NotesPanel(this.contentEl.createDiv({ cls: 'heron-notes' }), this.host));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.follow()));
		this.register(this.host.onControllersChange(() => this.follow()));
		this.app.workspace.onLayoutReady(() => this.follow());
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.panel.bind(null);
		return Promise.resolve();
	}

	private follow() {
		this.panel.bind(this.host.activeController());
	}
}
