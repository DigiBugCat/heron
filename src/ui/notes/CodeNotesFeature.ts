import { Component, ItemView, Menu, Modal, Notice, Setting, TAbstractFile, WorkspaceLeaf } from 'obsidian';
import type HeronPlugin from '../../main';
import { CodeNotesStore } from '../../services/CodeNotesStore';
import { copyToClipboard } from '../../utils/system';
import { CODE_VIEW_TYPE, CodeTab, isCodeTab, openLocation, vaultBasePath } from '../vault/codeTabs';
import { CODE_NOTES_VIEW_TYPE, CodeNotesView } from './CodeNotesView';
import { CommentModal } from './CommentModal';
import { ModelActionsUi } from './modelActionsUi';
import { ModelRuns } from './ModelRuns';
import { placeLabel, renderNoteCard } from './noteCard';
import { NotesController, NotesHost } from './NotesController';
import { codeTarget, noteOrigin, vaultNotes } from './vaultNotes';
import { lineAt, lineStarts } from '../../utils/textPositions';

interface Attached {
	controller: NotesController;
	leaf: WorkspaceLeaf;
	modelButton: HTMLElement;
}

/**
 * Margin notes and the model actions, wired into Heron: a notes controller
 * for every code tab, the header buttons and editor menu, the Code notes
 * panel, and reloading when a note file changes.
 */
export class CodeNotesFeature extends Component {
	readonly store: CodeNotesStore;
	readonly runs: ModelRuns;
	readonly model: ModelActionsUi;
	private attached = new Map<ItemView, Attached>();
	private listeners = new Set<() => void>();

	constructor(private plugin: HeronPlugin) {
		super();
		this.store = new CodeNotesStore(vaultNotes(plugin.app), () => plugin.settings.codeNotes.folder);
		this.runs = this.addChild(new ModelRuns(() => plugin.addStatusBarItem()));
		this.model = new ModelActionsUi({
			app: plugin.app,
			settings: () => plugin.settings.model,
			notesFolder: () => plugin.settings.codeNotes.folder,
			base: () => vaultBasePath(plugin),
			runs: this.runs,
			open: (controller, loc) => {
				const leaf = this.leafOf(controller);
				if (leaf) void openLocation(plugin, leaf, loc);
			},
			showPanel: () => { void this.showPanel(false); },
		});
	}

	onload() {
		const { app } = this.plugin;
		this.plugin.registerView(CODE_NOTES_VIEW_TYPE, (leaf) => new CodeNotesView(leaf, {
			app,
			activeController: () => this.activeController(),
			onControllersChange: (listener) => {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			},
			openInNote: (controller, id) => this.openInNote(controller, id),
			edit: (controller, id) => this.edit(controller, id),
			remove: (controller, id) => this.remove(controller, id),
			focusCode: (controller) => {
				const leaf = this.leafOf(controller);
				if (leaf) app.workspace.setActiveLeaf(leaf, { focus: true });
			},
		}));
		const attachAll = () => this.attachAll();
		this.registerEvent(app.workspace.on('layout-change', attachAll));
		this.registerEvent(app.workspace.on('active-leaf-change', attachAll));
		this.registerEvent(app.workspace.on('file-open', attachAll));
		app.workspace.onLayoutReady(() => {
			attachAll();
			void this.addPanelOnce();
		});
		const noteChanged = (file: TAbstractFile, oldPath?: string) => {
			for (const { controller } of this.attached.values()) {
				if (controller.isNoteFile(file.path) || (oldPath && controller.isNoteFile(oldPath))) void controller.reload();
			}
		};
		this.registerEvent(app.vault.on('modify', (f) => noteChanged(f)));
		this.registerEvent(app.vault.on('create', (f) => noteChanged(f)));
		this.registerEvent(app.vault.on('delete', (f) => noteChanged(f)));
		this.registerEvent(app.vault.on('rename', (f, oldPath) => noteChanged(f, oldPath)));
		let folder = this.plugin.settings.codeNotes.folder;
		this.registerEvent(this.plugin.settingsEvents.on('changed', () => {
			for (const a of this.attached.values()) a.modelButton.toggle(this.plugin.settings.model.enabled);
			if (folder === this.plugin.settings.codeNotes.folder) return;
			folder = this.plugin.settings.codeNotes.folder;
			for (const a of this.attached.values()) void a.controller.reload();
		}));
	}

	onunload() {
		for (const { controller } of this.attached.values()) controller.unload();
		this.attached.clear();
	}

	/** The notes of the code tab most recently used in the main area. */
	activeController(): NotesController | null {
		const view = this.plugin.app.workspace.getMostRecentLeaf()?.view;
		return view instanceof ItemView ? this.attached.get(view)?.controller ?? null : null;
	}

	/** Shows the Code notes panel in the right sidebar. */
	async showPanel(focus = true) {
		const { workspace } = this.plugin.app;
		let leaf = workspace.getLeavesOfType(CODE_NOTES_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? undefined;
			await leaf?.setViewState({ type: CODE_NOTES_VIEW_TYPE, active: focus });
		}
		if (leaf) await workspace.revealLeaf(leaf);
	}

	/** Asks for a note on the selection in `controller`'s tab and saves it. */
	comment(controller: NotesController) {
		const range = controller.selection();
		if (!range) {
			new Notice('Select code to comment on');
			return;
		}
		if (!controller.target) {
			new Notice('Only code files in the vault can have notes');
			return;
		}
		const anchor = controller.anchorFor(range);
		new CommentModal(this.plugin.app, anchor.quote, (values) => {
			void controller.addAnchored(anchor, { ...values, author: 'you' }).catch((err: unknown) => {
				new Notice(`Cannot save the note: ${err instanceof Error ? err.message : String(err)}`);
			});
		}).open();
	}

	private edit(controller: NotesController, id: string) {
		const note = controller.find(id);
		if (!note) return;
		new CommentModal(this.plugin.app, note.anchor.quote, (values) => {
			void controller.update(id, values);
		}, note, 'Edit note').open();
	}

	private remove(controller: NotesController, id: string) {
		const note = controller.find(id);
		if (!note) return;
		const confirm = new Modal(this.plugin.app);
		confirm.titleEl.setText('Delete note?');
		confirm.contentEl.createEl('p', { text: 'The note is removed from its Markdown file.' });
		new Setting(confirm.contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => confirm.close()))
			.addButton((b) => b.setButtonText('Delete').setWarning().onClick(() => {
				confirm.close();
				void controller.remove(id);
			}));
		confirm.open();
	}

	private openInNote(controller: NotesController, id: string) {
		const notePath = controller.notePath;
		if (notePath) void this.plugin.app.workspace.openLinkText(`${notePath}#Note ${id}`, '', 'tab');
	}

	private leafOf(controller: NotesController): WorkspaceLeaf | null {
		for (const a of this.attached.values()) if (a.controller === controller) return a.leaf;
		return null;
	}

	/** Gives every vault code tab its notes, header buttons and editor menu, once. */
	private attachAll() {
		let added = false;
		for (const leaf of this.plugin.app.workspace.getLeavesOfType(CODE_VIEW_TYPE)) {
			const view = leaf.view;
			if (!(view instanceof ItemView) || !isCodeTab(view) || this.attached.has(view)) continue;
			this.attach(view, leaf);
			added = true;
		}
		if (added) for (const listener of this.listeners) listener();
	}

	private attach(view: ItemView & CodeTab, leaf: WorkspaceLeaf) {
		const host: NotesHost = {
			store: this.store,
			target: (absPath) => codeTarget(vaultBasePath(this.plugin), absPath),
			origin: (target) => noteOrigin(this.plugin.app, vaultBasePath(this.plugin), target, this.store.pathFor(target)),
			renderCard: (controller, entry, el) => {
				const owner = new Component();
				owner.load();
				const starts = lineStarts(controller.surface.text());
				renderNoteCard(el, entry.note, {
					app: this.plugin.app,
					owner,
					sourcePath: controller.notePath ?? '',
					place: placeLabel(entry, (offset) => lineAt(starts, offset)),
				});
				return () => owner.unload();
			},
			contextMenu: (controller, event) => this.contextMenu(controller, event),
		};
		const controller = new NotesController(view.codeSurface(), host);
		const modelButton = view.addAction('sparkles', 'Model actions', (evt) => this.modelMenu(controller, evt));
		modelButton.toggle(this.plugin.settings.model.enabled);
		view.addAction('message-square', 'Comment', () => this.comment(controller));
		this.attached.set(view, { controller, leaf, modelButton });
		controller.register(() => {
			this.attached.delete(view);
			for (const listener of this.listeners) listener();
		});
		controller.register(controller.onChange(() => {
			if (this.activeController() === controller) for (const listener of this.listeners) listener();
		}));
		view.addChild(controller);
	}

	private modelMenu(controller: NotesController, evt: MouseEvent) {
		const menu = new Menu();
		this.addModelItems(menu, controller);
		menu.showAtMouseEvent(evt);
	}

	private addModelItems(menu: Menu, controller: NotesController) {
		menu.addItem((i) => i.setTitle('Explain selection').setIcon('message-circle').onClick(() => { void this.model.explain(controller); }));
		menu.addItem((i) => i.setTitle('Find similar code').setIcon('search').onClick(() => { void this.model.findSimilar(controller); }));
		menu.addItem((i) => i.setTitle('Diagram this symbol').setIcon('git-fork').onClick(() => { void this.model.diagram(controller, true); }));
		menu.addItem((i) => i.setTitle('Diagram this file').setIcon('git-fork').onClick(() => { void this.model.diagram(controller, false); }));
	}

	/** The editor's right-click menu: copy, comment, code navigation and the model actions. */
	private contextMenu(controller: NotesController, event: MouseEvent): boolean {
		const surface = controller.surface;
		const selected = surface.code.selectedText();
		const menu = new Menu();
		if (selected) menu.addItem((i) => i.setTitle('Copy').setIcon('copy').onClick(() => { void copyToClipboard(selected); }));
		menu.addItem((i) => i.setTitle('Comment').setIcon('message-square').setDisabled(!selected.trim()).onClick(() => this.comment(controller)));
		if (surface.hasCodeIntel()) {
			menu.addSeparator();
			menu.addItem((i) => i.setTitle('Go to definition').setIcon('arrow-right').onClick(() => surface.goTo('definition')));
			menu.addItem((i) => i.setTitle('Find references').setIcon('list').onClick(() => surface.findReferences()));
		}
		if (this.plugin.settings.model.enabled) {
			menu.addSeparator();
			this.addModelItems(menu, controller);
		}
		menu.showAtMouseEvent(event);
		return true;
	}

	/** Adds the Code notes panel to the right sidebar the first time Heron runs with it. */
	private async addPanelOnce() {
		const settings = this.plugin.settings.codeNotes;
		if (settings.panelAdded) return;
		if (!this.plugin.app.workspace.getLeavesOfType(CODE_NOTES_VIEW_TYPE).length) {
			await this.plugin.app.workspace.getRightLeaf(false)?.setViewState({ type: CODE_NOTES_VIEW_TYPE, active: false });
		}
		settings.panelAdded = true;
		await this.plugin.saveSettings();
	}
}
