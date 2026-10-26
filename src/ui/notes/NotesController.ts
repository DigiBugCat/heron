import { Component } from 'obsidian';
import * as path from 'path';
import { EditorSelection, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { AnchorQuality, AnchorText, makeAnchor, resolveAnchor, TextAnchor } from '../../notes/anchor';
import type { MarginNote } from '../../notes/noteFormat';
import type { CodeTarget } from '../../notes/notePaths';
import type { CodeNotesStore, NoteOrigin } from '../../services/CodeNotesStore';
import { LatestRequest } from '../../utils/latest';
import type { CodeSurface } from '../vault/CodeSurface';
import { NoteMark, noteDecorations, noteMarks, setNoteMarks } from './noteDecorations';

/** A note and where its quote is in the file now; `range` is null for an orphaned note. */
export interface AnchoredNote {
	note: MarginNote;
	range: { from: number; to: number; quality: AnchorQuality } | null;
}

/** What a controller needs from the plugin. */
export interface NotesHost {
	store: CodeNotesStore;
	/** The vault file and repository of a code file, or null outside the vault. */
	target(absPath: string): Promise<CodeTarget | null>;
	/** Commit and link recorded when a file gets its first note. */
	origin(target: CodeTarget): Promise<NoteOrigin>;
	/** Fills a hover card for a note; returns a cleanup for when it closes. */
	renderCard(controller: NotesController, entry: AnchoredNote, el: HTMLElement): () => void;
	/** Shows the context menu for the editor; return true when shown. */
	contextMenu?(controller: NotesController, event: MouseEvent): boolean;
}

export type NotesChange = 'notes' | 'selection';

/** What the user (or the model) writes in a note. */
export type NoteFields = Pick<MarginNote, 'colour' | 'author' | 'tags' | 'body'>;

/** Today as `YYYY-MM-DD`. */
export function today(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Margin notes for one code tab: loads the code file's notes, anchors them
 * in its text, shows them in the editor, and adds, edits and removes them.
 * Re-anchors whenever the file's text or its note file changes.
 */
export class NotesController extends Component {
	private targetPath: string | null = null;
	private current: CodeTarget | null = null;
	private all: MarginNote[] = [];
	private orphaned = new Set<string>();
	private qualities = new Map<string, AnchorQuality>();
	private anchoredText: string | null = null;
	private selectedId: string | null = null;
	private listeners = new Set<(change: NotesChange) => void>();
	private request = new LatestRequest();

	constructor(readonly surface: CodeSurface, private host: NotesHost) {
		super();
	}

	onload() {
		const view = this.editor();
		view?.dispatch({
			effects: StateEffect.appendConfig.of(noteDecorations({
				select: (id) => this.select(id),
				renderCard: (id, el) => {
					const entry = this.notes.find((n) => n.note.id === id);
					return entry ? this.host.renderCard(this, entry, el) : undefined;
				},
				contextMenu: (event) => this.host.contextMenu?.(this, event) ?? false,
			})),
		});
		this.register(this.surface.onChange((change) => {
			if (change === 'content') void this.refresh();
		}));
		// Positions move as the user types; tell the panel now and then.
		let pending = 0;
		this.register(() => window.clearTimeout(pending));
		if (view) {
			view.dispatch({
				effects: StateEffect.appendConfig.of(EditorView.updateListener.of((update) => {
					if (!update.docChanged || !this.all.length) return;
					window.clearTimeout(pending);
					pending = window.setTimeout(() => this.emit('notes'), 300);
				})),
			});
		}
		void this.refresh();
	}

	onunload() {
		this.editor()?.dispatch({ effects: setNoteMarks.of([]) });
		this.listeners.clear();
	}

	/** Calls `listener` when notes or the selected note change; returns an unsubscribe function. */
	onChange(listener: (change: NotesChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The code file's vault target, once known. */
	get target(): CodeTarget | null { return this.current; }

	/** Vault path of the note file, once the target is known. */
	get notePath(): string | null { return this.current ? this.host.store.pathFor(this.current) : null; }

	get selected(): string | null { return this.selectedId; }

	/** Notes in file order, orphaned ones last. */
	get notes(): AnchoredNote[] {
		const view = this.editor();
		const positions = new Map((view ? noteMarks(view.state) : []).map((m) => [m.id, m]));
		const anchored: AnchoredNote[] = [];
		const orphans: AnchoredNote[] = [];
		for (const note of this.all) {
			const mark = positions.get(note.id);
			if (mark && !this.orphaned.has(note.id)) {
				anchored.push({ note, range: { from: mark.from, to: mark.to, quality: this.qualities.get(note.id) ?? 'exact' } });
			} else {
				orphans.push({ note, range: null });
			}
		}
		anchored.sort((a, b) => (a.range?.from ?? 0) - (b.range?.from ?? 0) || (a.range?.to ?? 0) - (b.range?.to ?? 0));
		return [...anchored, ...orphans];
	}

	find(id: string): MarginNote | undefined {
		return this.all.find((n) => n.id === id);
	}

	/** True when `vaultPath` is this tab's note file, so its changes matter here. */
	isNoteFile(vaultPath: string): boolean {
		return this.notePath === vaultPath;
	}

	/** Reloads the notes from the vault and anchors them again. */
	async reload() {
		this.anchoredText = null;
		await this.refresh(true);
	}

	/**
	 * Loads notes for the shown file (when it or its note file changed) and
	 * anchors them in the current text (when that changed).
	 */
	private async refresh(force = false) {
		const absPath = this.surface.absPath;
		if (!absPath) {
			this.request.cancel();
			this.targetPath = null;
			this.current = null;
			this.anchoredText = null;
			this.apply([]);
			return;
		}
		if (force || absPath !== this.targetPath) {
			// Only loads cancel loads: a refresh for a cursor or status change must not.
			const token = this.request.next();
			const target = await this.host.target(absPath);
			if (!this.request.isCurrent(token)) return;
			const doc = target ? await this.host.store.load(target) : null;
			if (!this.request.isCurrent(token) || this.surface.absPath !== absPath) return;
			this.targetPath = absPath;
			this.current = target;
			this.anchoredText = null;
			this.all = doc?.notes ?? [];
		}
		const text = this.surface.text();
		if (text === this.anchoredText) return;
		this.anchoredText = text;
		this.apply(this.all);
	}

	/** Anchors `notes` in the current text and shows them. */
	private apply(notes: MarginNote[]) {
		this.all = notes;
		const doc = new AnchorText(this.surface.text());
		const marks: NoteMark[] = [];
		this.orphaned.clear();
		this.qualities.clear();
		for (const note of notes) {
			const match = resolveAnchor(doc, note.anchor);
			if (!match) {
				this.orphaned.add(note.id);
				continue;
			}
			this.qualities.set(note.id, match.quality);
			marks.push({ id: note.id, from: match.from, to: match.to, colour: note.colour });
		}
		this.editor()?.dispatch({ effects: setNoteMarks.of(marks) });
		if (this.selectedId && !notes.some((n) => n.id === this.selectedId)) this.selectedId = null;
		this.emit('notes');
	}

	/** The selected text, trimmed of surrounding whitespace, or null when nothing is selected. */
	selection(): { from: number; to: number } | null {
		const view = this.editor();
		if (!view || !this.surface.absPath) return null;
		const { from, to } = view.state.selection.main;
		const text = view.state.sliceDoc(from, to);
		const start = from + (text.length - text.trimStart().length);
		const end = to - (text.length - text.trimEnd().length);
		return end > start ? { from: start, to: end } : null;
	}

	/** An anchor for `range` of the current text. */
	anchorFor(range: { from: number; to: number }): TextAnchor {
		return makeAnchor(this.surface.text(), range.from, range.to);
	}

	/** Adds a note on `range` of the current text. */
	async add(range: { from: number; to: number }, fields: NoteFields): Promise<MarginNote | null> {
		return this.addAnchored(this.anchorFor(range), fields);
	}

	/**
	 * Adds a note on the code `anchor` quotes, to `target`'s notes: by
	 * default the shown file, but a slow model action passes the file it
	 * started on, in case the tab has moved on to another file since.
	 */
	async addAnchored(anchor: TextAnchor, fields: NoteFields, target: CodeTarget | null = this.current): Promise<MarginNote | null> {
		if (!target) return null;
		const note = await this.host.store.add(target, {
			...fields,
			created: today(),
			anchor,
			language: path.extname(target.vaultPath).slice(1).toLowerCase(),
			extra: [],
		}, () => this.host.origin(target));
		if (target.vaultPath !== this.current?.vaultPath) return note;
		await this.reload();
		this.select(note.id);
		return note;
	}

	async update(id: string, patch: Partial<Pick<MarginNote, 'colour' | 'tags' | 'body'>>): Promise<boolean> {
		if (!this.current) return false;
		const done = await this.host.store.update(this.current, id, patch);
		await this.reload();
		return done;
	}

	async remove(id: string): Promise<boolean> {
		if (!this.current) return false;
		const done = await this.host.store.remove(this.current, id);
		await this.reload();
		return done;
	}

	/** Marks a note as selected, e.g. after its highlight was selected. */
	select(id: string | null) {
		if (id === this.selectedId) return;
		this.selectedId = id;
		this.emit('selection');
	}

	/** Selects a note's code in the editor and scrolls to it. */
	reveal(id: string): boolean {
		const view = this.editor();
		const mark = view ? noteMarks(view.state).find((m) => m.id === id) : undefined;
		this.select(id);
		if (!view || !mark || this.orphaned.has(id)) return false;
		view.dispatch({
			selection: EditorSelection.range(mark.from, mark.to),
			effects: EditorView.scrollIntoView(mark.from, { y: 'center' }),
		});
		view.focus();
		return true;
	}

	private editor(): EditorView | null {
		return this.surface.code.editor();
	}

	private emit(change: NotesChange) {
		for (const listener of this.listeners) listener(change);
	}
}
