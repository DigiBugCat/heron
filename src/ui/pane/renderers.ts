import { Component, setIcon } from 'obsidian';
import { Annotation, Compartment, EditorSelection, EditorState, Extension, Text, Transaction } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { Decoration, drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import type { BlameCommit } from '../../git/blame';
import type { LineRange } from '../../links/sourceLink';
import type { Position as TextPosition } from '../../lsp/locations';
import type { DiffLayout } from '../../settings';
import { blameGutter } from '../editor/blameGutter';
import { diffStats, DiffStats } from '../editor/diffStats';
import { languageFor } from '../editor/languages';
import { diffTheme, fontTheme, obsidianHighlight, obsidianTheme } from '../editor/theme';

/**
 * Something shown in the content pane. Renderers own a wrapper element and
 * remove it when unloaded, so swapping renderers never leaks DOM, editors or
 * listeners.
 */
export abstract class PaneRenderer extends Component {
	protected el: HTMLElement;

	constructor(parent: HTMLElement, cls: string) {
		super();
		this.el = parent.createDiv({ cls: `so-renderer ${cls}` });
	}

	onunload() {
		this.el.remove();
	}

	setFontSize(_fontSize: number) { /* optional */ }

	setWordWrap(_wordWrap: boolean) { /* optional */ }

	/** The editor that find and go-to-line act on, if this renderer has one. */
	editor(): EditorView | null { return null; }

	/** Opens the find panel; returns false when there is nothing to search. */
	openSearch(): boolean {
		const view = this.editor();
		if (!view) return false;
		openSearchPanel(view);
		return true;
	}

	/** The selected text in the editor, or '' when nothing is selected. */
	selectedText(): string {
		const view = this.editor();
		if (!view) return '';
		const { from, to } = view.state.selection.main;
		return view.state.sliceDoc(from, to);
	}

	/** Opens the go-to-line prompt; returns false when there is no editor. */
	goToLine(): boolean {
		const view = this.editor();
		if (!view) return false;
		gotoLine(view);
		return true;
	}
}

function readOnlyExtensions(): Extension[] {
	return [
		EditorState.readOnly.of(true),
		EditorView.editable.of(false),
		// Read-only content is not focusable by default; without focus the
		// find and go-to-line keys would never reach the editor.
		EditorView.contentAttributes.of({ tabindex: '0' }),
	];
}

/** What an editable code view adds: undo, the usual editing keys, brackets and indentation. */
function editingExtensions(): Extension[] {
	return [
		history(),
		closeBrackets(),
		bracketMatching(),
		indentOnInput(),
		keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
	];
}

/** Marks transactions that load a document, as opposed to the user's edits. */
const loadDocument = Annotation.define<boolean>();
const LOAD_ANNOTATIONS = [loadDocument.of(true), Transaction.addToHistory.of(false)];

function baseEditorExtensions(): Extension[] {
	return [
		search({ top: true }),
		// Draw the selection ourselves: Obsidian turns off native text selection
		// outside editable areas, so a read-only editor's selection would be invisible.
		drawSelection(),
		highlightSelectionMatches(),
		keymap.of(searchKeymap),
		lineNumbers(),
		highlightActiveLine(),
		syntaxHighlighting(obsidianHighlight),
		obsidianTheme,
	];
}

/** CodeMirror line wrapping, when enabled. */
function wrapExtension(wordWrap: boolean): Extension {
	return wordWrap ? EditorView.lineWrapping : [];
}

/** `lines` clamped to the document, or null when it starts past the end. */
function clampLines(doc: Text, lines: LineRange): LineRange | null {
	if (lines.from > doc.lines) return null;
	return { from: lines.from, to: Math.min(lines.to, doc.lines) };
}

const linkedLine = Decoration.line({ class: 'so-linked-line' });

function linkedLinesHighlight(doc: Text, lines: LineRange | null): Extension {
	const range = lines && clampLines(doc, lines);
	if (!range) return [];
	const marks = [];
	for (let n = range.from; n <= range.to; n++) marks.push(linkedLine.range(doc.line(n).from));
	return EditorView.decorations.of(Decoration.set(marks));
}

/** The document offset of `pos`, clamped to the document. */
export function offsetOf(doc: Text, pos: TextPosition): number {
	const line = doc.line(Math.min(Math.max(pos.line + 1, 1), doc.lines));
	return line.from + Math.min(Math.max(pos.character, 0), line.length);
}

/** What a link or code block made from the editor should cover. */
export interface EditorSelectionInfo {
	/** Selected lines, or null for the whole file when nothing is selected. */
	lines: LineRange | null;
	text: string;
}

/**
 * Read-only, syntax-highlighted file view. The CodeMirror instance is reused
 * across files; language, font size, linked-line highlights and the blame
 * gutter are swapped via compartments.
 */
export class CodeRenderer extends PaneRenderer {
	private view: EditorView | null = null;
	private language = new Compartment();
	private font = new Compartment();
	private highlight = new Compartment();
	private blame = new Compartment();
	private blameShown = false;
	private wrap = new Compartment();
	private lsp = new Compartment();
	private lspShown = false;
	private cursorListeners = new Set<() => void>();
	private editListeners = new Set<() => void>();
	private editing = new Compartment();
	private editable = false;

	constructor(parent: HTMLElement, private fontSize: number, private wordWrap = false) {
		super(parent, 'so-code-view');
	}

	onload() {
		this.view = new EditorView({
			parent: this.el,
			state: EditorState.create({
				extensions: [
					// First, so the blame gutter sits left of the line numbers.
					this.blame.of([]),
					this.editing.of(readOnlyExtensions()),
					...baseEditorExtensions(),
					this.language.of([]),
					this.font.of(fontTheme(this.fontSize)),
					this.highlight.of([]),
					this.wrap.of(wrapExtension(this.wordWrap)),
					this.lsp.of([]),
					EditorView.updateListener.of((update) => {
						if (update.selectionSet) for (const listener of this.cursorListeners) listener();
						if (update.docChanged && !update.transactions.some((tr) => tr.annotation(loadDocument))) {
							for (const listener of this.editListeners) listener();
						}
					}),
				],
			}),
		});
	}

	onunload() {
		this.view?.destroy();
		this.view = null;
		super.onunload();
	}

	editor() { return this.view; }

	/**
	 * Replaces the document in place and highlights `lines`, if given. Scrolls
	 * to the highlighted lines, or to `cursor`, or back to the top, unless
	 * `keepScroll`. Any language server extension is removed first, since it
	 * belongs to the previous document.
	 */
	setDocument(text: string, fileName: string, keepScroll: boolean, lines: LineRange | null = null, cursor: TextPosition | null = null) {
		const view = this.view;
		if (!view) return;
		this.setLanguageServer(null);
		const { scrollTop, scrollLeft } = view.scrollDOM;
		const doc = Text.of(text.split(/\r\n?|\n/));
		this.resetHistory();
		if (cursor && !keepScroll) {
			const anchor = offsetOf(doc, cursor);
			view.dispatch({
				annotations: LOAD_ANNOTATIONS,
				changes: { from: 0, to: view.state.doc.length, insert: doc },
				effects: [
					this.language.reconfigure(languageFor(fileName)),
					this.highlight.reconfigure([]),
					...(this.blameShown ? [this.blame.reconfigure(blameGutter([]))] : []),
					EditorView.scrollIntoView(anchor, { y: 'center' }),
				],
				selection: EditorSelection.cursor(anchor),
			});
			return;
		}
		const range = lines && clampLines(doc, lines);
		// Selecting the linked lines lets "Copy link" reproduce the same link.
		const selection = range && !keepScroll
			? EditorSelection.range(doc.line(range.from).from, doc.line(range.to).to)
			: EditorSelection.cursor(0);
		view.dispatch({
			annotations: LOAD_ANNOTATIONS,
			changes: { from: 0, to: view.state.doc.length, insert: doc },
			effects: [
				this.language.reconfigure(languageFor(fileName)),
				this.highlight.reconfigure(linkedLinesHighlight(doc, lines)),
				// Blame for the old document no longer applies; keep the gutter's
				// width until the caller supplies blame for the new one.
				...(this.blameShown ? [this.blame.reconfigure(blameGutter([]))] : []),
			],
			selection,
		});
		if (range && !keepScroll) {
			view.dispatch({ effects: EditorView.scrollIntoView(selection.from, { y: 'center' }) });
			return;
		}
		view.scrollDOM.scrollTop = keepScroll ? scrollTop : 0;
		view.scrollDOM.scrollLeft = keepScroll ? scrollLeft : 0;
	}

	/**
	 * Shows `lines` (one entry per document line) in a blame gutter, an empty
	 * gutter for an empty list, or removes the gutter for null.
	 */
	setBlame(lines: BlameCommit[] | null, onOpen?: (commit: BlameCommit) => void) {
		this.blameShown = lines !== null;
		this.view?.dispatch({ effects: this.blame.reconfigure(lines ? blameGutter(lines, onOpen) : []) });
	}

	/** Allows or prevents editing; undo history starts fresh either way. */
	setEditable(editable: boolean) {
		if (editable === this.editable) return;
		this.editable = editable;
		this.view?.dispatch({ effects: this.editing.reconfigure(editable ? editingExtensions() : readOnlyExtensions()) });
	}

	isEditable(): boolean { return this.editable; }

	/** The current text, including unsaved edits. */
	text(): string { return this.view?.state.doc.toString() ?? ''; }

	/** Calls `listener` after each edit the user makes (not when a document is loaded). */
	onEdit(listener: () => void): () => void {
		this.editListeners.add(listener);
		return () => this.editListeners.delete(listener);
	}

	/** Forgets undo history, so a newly loaded document can't be undone into the previous one. */
	private resetHistory() {
		if (!this.editable || !this.view) return;
		this.view.dispatch({ effects: this.editing.reconfigure([]) });
		this.view.dispatch({ effects: this.editing.reconfigure(editingExtensions()) });
	}

	/** Adds language server features for the current document, or removes them for null. */
	setLanguageServer(extension: Extension | null) {
		if (!extension && !this.lspShown) return;
		this.lspShown = !!extension;
		this.view?.dispatch({ effects: this.lsp.reconfigure(extension ?? []) });
	}

	/** Moves the cursor to `pos` and scrolls it to the middle of the view. */
	moveCursor(pos: TextPosition) {
		const view = this.view;
		if (!view) return;
		const anchor = offsetOf(view.state.doc, pos);
		view.dispatch({ selection: EditorSelection.cursor(anchor), effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
	}

	/** Calls `listener` whenever the cursor or selection moves; returns an unsubscribe function. */
	onCursorMove(listener: () => void): () => void {
		this.cursorListeners.add(listener);
		return () => this.cursorListeners.delete(listener);
	}

	/** The cursor as a zero-based line and column. */
	cursor(): TextPosition | null {
		const view = this.view;
		if (!view) return null;
		const head = view.state.selection.main.head;
		const line = view.state.doc.lineAt(head);
		return { line: line.number - 1, character: head - line.from };
	}

	/** True while the blame gutter is shown. */
	hasBlame(): boolean {
		return this.blameShown;
	}

	/** The selected whole lines, or the whole file when the selection is empty. */
	selection(): EditorSelectionInfo | null {
		const view = this.view;
		if (!view) return null;
		const { doc } = view.state;
		const { from, to, empty } = view.state.selection.main;
		if (empty) return { lines: null, text: doc.toString() };
		const first = doc.lineAt(from);
		// A selection ending at the start of a line (e.g. a dragged or triple-click
		// selection) does not include that line.
		let last = doc.lineAt(to);
		if (to === last.from && to > from) last = doc.lineAt(to - 1);
		return { lines: { from: first.number, to: last.number }, text: doc.sliceString(first.from, last.to) };
	}

	setFontSize(fontSize: number) {
		if (this.fontSize === fontSize) return;
		this.fontSize = fontSize;
		this.view?.dispatch({ effects: this.font.reconfigure(fontTheme(fontSize)) });
	}

	setWordWrap(wordWrap: boolean) {
		if (this.wordWrap === wordWrap) return;
		this.wordWrap = wordWrap;
		this.view?.dispatch({ effects: this.wrap.reconfigure(wrapExtension(wordWrap)) });
	}
}

/**
 * Syntax-highlighted diff of two documents using `@codemirror/merge`,
 * either unified (one editor) or split (old and new side by side).
 * Unchanged stretches are collapsed in both layouts.
 */
export class DiffRenderer extends PaneRenderer {
	private unified: EditorView | null = null;
	private split: MergeView | null = null;
	/** Side of the split layout that last had focus. */
	private focusedSide: 'a' | 'b' = 'b';
	private font = new Compartment();
	private wrap = new Compartment();

	constructor(
		parent: HTMLElement,
		private fontSize: number,
		private original: string,
		private modified: string,
		private fileName: string,
		readonly layout: DiffLayout,
		private wordWrap = false,
	) {
		super(parent, `so-diff-view so-diff-${layout}`);
	}

	onload() {
		const extensions = [
			...readOnlyExtensions(),
			...baseEditorExtensions(),
			languageFor(this.fileName),
			this.font.of(fontTheme(this.fontSize)),
			this.wrap.of(wrapExtension(this.wordWrap)),
			diffTheme,
		];
		const collapseUnchanged = { margin: 3, minSize: 6 };

		if (this.layout === 'split') {
			this.split = new MergeView({
				parent: this.el,
				a: { doc: this.original, extensions },
				b: { doc: this.modified, extensions },
				highlightChanges: true,
				gutter: true,
				collapseUnchanged,
			});
			this.registerDomEvent(this.split.a.dom, 'focusin', () => { this.focusedSide = 'a'; });
			this.registerDomEvent(this.split.b.dom, 'focusin', () => { this.focusedSide = 'b'; });
			return;
		}

		this.unified = new EditorView({
			parent: this.el,
			state: EditorState.create({
				doc: this.modified,
				extensions: [
					...extensions,
					unifiedMergeView({
						original: this.original,
						mergeControls: false,
						highlightChanges: true,
						gutter: true,
						collapseUnchanged,
					}),
				],
			}),
		});
	}

	onunload() {
		this.unified?.destroy();
		this.split?.destroy();
		this.unified = null;
		this.split = null;
		super.onunload();
	}

	/** In the split layout, the side that last had focus, defaulting to the new version. */
	editor() {
		if (this.split) return this.split[this.focusedSide];
		return this.unified;
	}

	/** Number of added and removed lines across all changed chunks. */
	stats(): DiffStats {
		return diffStats(this.original, this.modified);
	}

	setFontSize(fontSize: number) {
		if (this.fontSize === fontSize) return;
		this.fontSize = fontSize;
		const effects = this.font.reconfigure(fontTheme(fontSize));
		for (const view of this.views()) view.dispatch({ effects });
	}

	setWordWrap(wordWrap: boolean) {
		if (this.wordWrap === wordWrap) return;
		this.wordWrap = wordWrap;
		const effects = this.wrap.reconfigure(wrapExtension(wordWrap));
		for (const view of this.views()) view.dispatch({ effects });
	}

	private views(): EditorView[] {
		if (this.split) return [this.split.a, this.split.b];
		return this.unified ? [this.unified] : [];
	}
}

/** Centered icon + message, used for empty, binary, oversized and error states. */
export class MessageRenderer extends PaneRenderer {
	constructor(parent: HTMLElement, private icon: string, private message: string, private detail?: string) {
		super(parent, 'so-message');
	}

	onload() {
		const iconEl = this.el.createDiv({ cls: 'so-message-icon' });
		setIcon(iconEl, this.icon);
		this.el.createDiv({ cls: 'so-message-text', text: this.message });
		if (this.detail) this.el.createDiv({ cls: 'so-message-detail', text: this.detail });
	}
}
