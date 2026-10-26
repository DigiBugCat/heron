import { EditorState, Extension, RangeSet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, gutter, GutterMarker, hoverTooltip } from '@codemirror/view';
import type { NoteColour } from '../../notes/noteFormat';

/**
 * Margin notes in a code editor: the quoted code highlighted in the note's
 * colour, a badge in the gutter on the first line of each note, and a card
 * when hovering a highlight. Marks follow edits until the notes are anchored
 * again.
 */

export interface NoteMark {
	id: string;
	from: number;
	to: number;
	colour: NoteColour;
}

export interface NoteMarkHandlers {
	/** A highlight or badge was selected. */
	select(id: string): void;
	/** Fills a hover card for the note; returns a cleanup for when the card closes. */
	renderCard(id: string, el: HTMLElement): (() => void) | void;
	/** The editor's context menu; return true when a menu was shown. */
	contextMenu?(event: MouseEvent): boolean;
}

/** Replaces the notes shown in an editor. */
export const setNoteMarks = StateEffect.define<NoteMark[]>();

interface NotesState {
	marks: NoteMark[];
	decorations: DecorationSet;
	badges: RangeSet<GutterMarker>;
}

class BadgeMarker extends GutterMarker {
	constructor(readonly marks: NoteMark[]) {
		super();
	}

	eq(other: BadgeMarker): boolean {
		return other.marks.length === this.marks.length && other.marks.every((m, i) => m.id === this.marks[i]?.id && m.colour === this.marks[i]?.colour);
	}

	toDOM(view: EditorView): HTMLElement {
		const first = this.marks[0];
		const el = view.dom.ownerDocument.createElement('span');
		el.className = `heron-note-badge heron-note-${first?.colour ?? 'yellow'}`;
		el.setAttribute('aria-label', this.marks.length === 1 ? 'Margin note' : `${this.marks.length} margin notes`);
		if (this.marks.length > 1) el.textContent = String(this.marks.length);
		return el;
	}
}

function build(state: EditorState, marks: NoteMark[]): NotesState {
	const shown = marks.filter((m) => m.to > m.from && m.to <= state.doc.length);
	const decorations = Decoration.set(shown.map((m) => Decoration.mark({
		class: `heron-note-mark heron-note-${m.colour}`,
		attributes: { 'data-heron-note': m.id },
	}).range(m.from, m.to)), true);
	const byLine = new Map<number, NoteMark[]>();
	for (const m of shown) {
		const line = state.doc.lineAt(m.from).from;
		byLine.set(line, [...(byLine.get(line) ?? []), m]);
	}
	const builder = new RangeSetBuilder<GutterMarker>();
	for (const line of [...byLine.keys()].sort((a, b) => a - b)) builder.add(line, line, new BadgeMarker(byLine.get(line) ?? []));
	return { marks, decorations, badges: builder.finish() };
}

const notesField = StateField.define<NotesState>({
	create: (state) => build(state, []),
	update(value, tr) {
		let marks = value.marks;
		let changed = false;
		if (tr.docChanged) {
			marks = marks.map((m) => {
				const from = tr.changes.mapPos(m.from, 1);
				return { ...m, from, to: Math.max(from, tr.changes.mapPos(m.to, -1)) };
			});
			changed = true;
		}
		for (const effect of tr.effects) {
			if (effect.is(setNoteMarks)) {
				marks = effect.value;
				changed = true;
			}
		}
		return changed ? build(tr.state, marks) : value;
	},
	provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** The notes in `state`, with positions mapped through edits since they were set. */
export function noteMarks(state: EditorState): NoteMark[] {
	return state.field(notesField, false)?.marks ?? [];
}

/** Notes whose highlight covers `pos`, innermost first. */
export function marksAt(state: EditorState, pos: number): NoteMark[] {
	return noteMarks(state)
		.filter((m) => m.to > m.from && m.from <= pos && pos <= m.to)
		.sort((a, b) => (a.to - a.from) - (b.to - b.from));
}

export function noteDecorations(handlers: NoteMarkHandlers): Extension {
	return [
		notesField,
		gutter({
			class: 'heron-note-gutter',
			markers: (view) => view.state.field(notesField).badges,
			initialSpacer: () => new BadgeMarker([]),
			domEventHandlers: {
				mousedown: (view, line) => {
					const marks = noteMarks(view.state).filter((m) => m.to > m.from && view.state.doc.lineAt(m.from).from === line.from);
					const first = marks[0];
					if (!first) return false;
					handlers.select(first.id);
					return true;
				},
			},
		}),
		hoverTooltip((view, pos) => {
			const marks = marksAt(view.state, pos);
			const first = marks[0];
			if (!first) return null;
			return {
				pos: first.from,
				end: first.to,
				above: true,
				create: () => {
					const dom = view.dom.ownerDocument.createElement('div');
					dom.className = 'heron-note-tooltip';
					const cleanups = marks.map((mark) => handlers.renderCard(mark.id, dom));
					return { dom, destroy: () => { for (const cleanup of cleanups) cleanup?.(); } };
				},
			};
		}, { hoverTime: 300 }),
		EditorView.domEventHandlers({
			click: (event, view) => {
				if (event.button !== 0 || !view.state.selection.main.empty) return false;
				const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
				const first = pos === null ? undefined : marksAt(view.state, pos)[0];
				if (first) handlers.select(first.id);
				return false;
			},
			contextmenu: (event) => {
				if (!handlers.contextMenu?.(event)) return false;
				event.preventDefault();
				return true;
			},
		}),
	];
}
