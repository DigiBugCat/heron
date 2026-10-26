import { App, Component, MarkdownRenderer } from 'obsidian';
import type { MarginNote } from '../../notes/noteFormat';
import type { AnchoredNote } from './NotesController';

const QUOTE_LINES = 3;

/** Where a note sits, for its card: `Line 41`, `Line 41 · approximate` or `Orphaned`. */
export function placeLabel(entry: AnchoredNote, lineOf: (offset: number) => number): string {
	if (!entry.range) return 'Orphaned';
	const line = `Line ${lineOf(entry.range.from) + 1}`;
	return entry.range.quality === 'fuzzy' ? `${line} · approximate` : line;
}

/** The first lines of a quote, de-indented, for a card. */
export function quotePreview(quote: string): string {
	const lines = quote.split('\n');
	const shown = lines.slice(0, QUOTE_LINES);
	const indent = Math.min(...shown.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
	const text = shown.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
	return lines.length > QUOTE_LINES ? `${text}\n…` : text;
}

export interface CardOptions {
	app: App;
	/** Owns the rendered markdown; unloading it cleans up. */
	owner: Component;
	/** Vault path the body's links resolve from (the note file). */
	sourcePath: string;
	/** `Line 41`, `Orphaned`… */
	place: string;
}

/** Renders a note card into `parent` and returns it. */
export function renderNoteCard(parent: HTMLElement, note: MarginNote, opts: CardOptions): HTMLElement {
	const card = parent.createDiv({ cls: `heron-note-card heron-note-${note.colour}` });
	card.toggleClass('is-orphaned', opts.place === 'Orphaned');
	const header = card.createDiv({ cls: 'heron-note-card-header' });
	header.createSpan({ cls: 'heron-note-dot' });
	header.createSpan({ cls: 'heron-note-author', text: note.author === 'model' ? 'Model' : 'You' });
	for (const tag of note.tags) header.createSpan({ cls: 'heron-note-tag', text: `#${tag}` });
	header.createSpan({ cls: 'heron-note-place', text: opts.place });
	if (note.anchor.quote.trim()) card.createDiv({ cls: 'heron-note-quote', text: quotePreview(note.anchor.quote) });
	if (note.body.trim()) {
		const body = card.createDiv({ cls: 'heron-note-body' });
		void MarkdownRenderer.render(opts.app, note.body, body, opts.sourcePath, opts.owner);
	}
	return card;
}
