import { App, Component, Menu, setIcon } from 'obsidian';
import * as path from 'path';
import { lineAt, lineStarts } from '../../utils/textPositions';
import type { AnchoredNote, NotesController } from './NotesController';
import { placeLabel, renderNoteCard } from './noteCard';

/** What the panel asks the plugin to do. */
export interface NotesPanelHost {
	app: App;
	/** Opens the note file at a note's section. */
	openInNote(controller: NotesController, id: string): void;
	edit(controller: NotesController, id: string): void;
	remove(controller: NotesController, id: string): void;
	/** Brings the code tab back into focus after a card was selected. */
	focusCode(controller: NotesController): void;
}

/**
 * The cards of one code tab's margin notes, in file order with orphaned
 * notes last. Selecting a card selects its code; selecting a highlight in
 * the code selects its card.
 */
export class NotesPanel extends Component {
	private controller: NotesController | null = null;
	private unsubscribe: (() => void) | null = null;
	private cards = new Map<string, HTMLElement>();
	/** Owns the markdown rendered in cards; replaced on every render. */
	private content: Component | null = null;

	constructor(private el: HTMLElement, private host: NotesPanelHost) {
		super();
	}

	onunload() {
		this.bind(null);
	}

	/** Shows `controller`'s notes, or an empty state for null. */
	bind(controller: NotesController | null) {
		if (controller === this.controller) return;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.controller = controller;
		if (controller) {
			this.unsubscribe = controller.onChange((change) => {
				if (change === 'selection') this.highlight(true);
				else this.render();
			});
		}
		this.render();
	}

	render() {
		const controller = this.controller;
		this.cards.clear();
		if (this.content) this.removeChild(this.content);
		this.content = this.addChild(new Component());
		this.el.empty();
		const absPath = controller?.surface.absPath;
		if (absPath) this.el.createDiv({ cls: 'heron-panel-title', text: path.basename(absPath) });
		if (!controller || !absPath) {
			this.el.createDiv({ cls: 'heron-panel-empty', text: 'Open a code file to see its notes.' });
			return;
		}
		if (!controller.target) {
			this.el.createDiv({ cls: 'heron-panel-empty', text: 'Only code files in the vault can have notes.' });
			return;
		}
		const entries = controller.notes;
		if (!entries.length) {
			this.el.createDiv({ cls: 'heron-panel-empty', text: 'No notes yet. Select code and choose Comment to add one.' });
			return;
		}
		const starts = lineStarts(controller.surface.text());
		const lineOf = (offset: number) => lineAt(starts, offset);
		let orphanHeading = false;
		for (const entry of entries) {
			if (!entry.range && !orphanHeading) {
				orphanHeading = true;
				this.el.createDiv({ cls: 'heron-notes-orphaned-title', text: 'Orphaned: the quoted code was not found' });
			}
			this.card(controller, entry, lineOf);
		}
		this.highlight(false);
	}

	private card(controller: NotesController, entry: AnchoredNote, lineOf: (offset: number) => number) {
		const { note } = entry;
		// Listeners and rendered markdown belong to this render, not to the panel.
		const owner = this.content ?? this;
		const card = renderNoteCard(this.el, note, {
			app: this.host.app,
			owner,
			sourcePath: controller.notePath ?? '',
			place: placeLabel(entry, lineOf),
		});
		card.addClass('is-clickable');
		card.setAttr('tabindex', '0');
		card.dataset.noteId = note.id;
		const actions = card.createDiv({ cls: 'heron-note-card-actions' });
		const open = actions.createEl('a', { cls: 'heron-note-open', text: 'Open in note', attr: { href: '#' } });
		const more = actions.createEl('button', { cls: 'clickable-icon heron-note-more', attr: { 'aria-label': 'More' } });
		setIcon(more, 'more-horizontal');
		owner.registerDomEvent(open, 'click', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.host.openInNote(controller, note.id);
		});
		owner.registerDomEvent(more, 'click', (evt) => {
			evt.stopPropagation();
			const menu = new Menu();
			menu.addItem((i) => i.setTitle('Edit').setIcon('pencil').onClick(() => this.host.edit(controller, note.id)));
			menu.addItem((i) => i.setTitle('Delete').setIcon('trash').onClick(() => this.host.remove(controller, note.id)));
			menu.showAtMouseEvent(evt);
		});
		const choose = (evt: Event) => {
			// Links in the rendered body work as links.
			if ((evt.target as HTMLElement | null)?.closest('a')) return;
			if (controller.reveal(note.id)) this.host.focusCode(controller);
		};
		owner.registerDomEvent(card, 'click', choose);
		owner.registerDomEvent(card, 'keydown', (evt) => { if (evt.key === 'Enter') choose(evt); });
		this.cards.set(note.id, card);
	}

	/** Marks the selected note's card, scrolling to it when the selection came from the code. */
	private highlight(scroll: boolean) {
		const selected = this.controller?.selected ?? null;
		for (const [id, card] of this.cards) card.toggleClass('is-selected', id === selected);
		const card = selected ? this.cards.get(selected) : undefined;
		if (scroll && card) card.scrollIntoView({ block: 'nearest' });
	}
}
