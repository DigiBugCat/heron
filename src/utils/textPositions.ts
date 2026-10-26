/** A zero-based line and UTF-16 column, as language servers use. */
export interface TextPosition {
	line: number;
	character: number;
}

/** Offsets where each line of `text` starts; lines end at `\n`. */
export function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
	return starts;
}

/** The zero-based line containing `offset`. */
export function lineAt(starts: number[], offset: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((starts[mid] ?? 0) <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** The line and column of `offset`. */
export function positionAt(starts: number[], offset: number): TextPosition {
	const line = lineAt(starts, offset);
	return { line, character: offset - (starts[line] ?? 0) };
}

/** The offset of `pos`, clamped to the line and the text. */
export function offsetAt(starts: number[], pos: TextPosition, textLength: number): number {
	const line = Math.min(Math.max(pos.line, 0), starts.length - 1);
	const start = starts[line] ?? 0;
	const end = line + 1 < starts.length ? (starts[line + 1] ?? textLength) - 1 : textLength;
	return Math.min(start + Math.max(pos.character, 0), end);
}
