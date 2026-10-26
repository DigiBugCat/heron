import { setIcon } from 'obsidian';
import { Extension, RangeSet, RangeSetBuilder, Text } from '@codemirror/state';
import { Decoration, EditorView, gutter, GutterMarker } from '@codemirror/view';
import type { ReviewThread } from '../../github/types';

/** Review threads by the document line they are attached to, clamped to the document. */
export function threadsByLine(doc: Text, threads: ReviewThread[]): Map<number, ReviewThread[]> {
	const byLine = new Map<number, ReviewThread[]>();
	for (const t of threads) {
		if (t.line === null) continue;
		const line = Math.min(Math.max(t.line, 1), doc.lines);
		const list = byLine.get(line) ?? [];
		list.push(t);
		byLine.set(line, list);
	}
	return byLine;
}

class ThreadMarker extends GutterMarker {
	constructor(readonly count: number, readonly resolved: boolean) {
		super();
	}

	eq(other: ThreadMarker) {
		return other.count === this.count && other.resolved === this.resolved;
	}

	toDOM(view: EditorView) {
		const el = view.dom.ownerDocument.createElement('div');
		el.className = `heron-thread-marker${this.resolved ? ' is-resolved' : ''}`;
		el.setAttribute('aria-label', `${this.count} review thread${this.count === 1 ? '' : 's'}`);
		setIcon(el, 'message-square');
		if (this.count > 1) el.appendChild(view.dom.ownerDocument.createTextNode(String(this.count)));
		return el;
	}
}

const unresolvedLine = Decoration.line({ class: 'heron-thread-line' });

/**
 * A gutter with a comment marker on each line that has review threads
 * (dimmed when they are all resolved), and a tint on lines with unresolved
 * ones. Selecting a marker calls `onSelect` with that line's threads.
 */
export function threadGutter(threads: ReviewThread[], onSelect: (threads: ReviewThread[]) => void): Extension {
	if (!threads.some((t) => t.line !== null)) return [];
	const markersFor = (doc: Text): RangeSet<GutterMarker> => {
		const builder = new RangeSetBuilder<GutterMarker>();
		const byLine = threadsByLine(doc, threads);
		for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
			const list = byLine.get(line) ?? [];
			builder.add(doc.line(line).from, doc.line(line).from, new ThreadMarker(list.length, list.every((t) => t.resolved)));
		}
		return builder.finish();
	};
	return [
		gutter({
			class: 'heron-thread-gutter',
			markers: (view) => markersFor(view.state.doc),
			initialSpacer: () => new ThreadMarker(1, false),
			domEventHandlers: {
				mousedown: (view, block) => {
					const line = view.state.doc.lineAt(block.from).number;
					const list = threadsByLine(view.state.doc, threads).get(line);
					if (!list) return false;
					onSelect(list);
					return true;
				},
			},
		}),
		EditorView.decorations.of((view) => {
			const builder = new RangeSetBuilder<Decoration>();
			const byLine = threadsByLine(view.state.doc, threads);
			for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
				if ((byLine.get(line) ?? []).some((t) => !t.resolved)) builder.add(view.state.doc.line(line).from, view.state.doc.line(line).from, unresolvedLine);
			}
			return builder.finish();
		}),
	];
}
