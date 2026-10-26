import type { TextAnchor } from './anchor';

/**
 * The markdown format of a code file's margin notes. One note file per code
 * file; each margin note is a section:
 *
 *     ## Note k3j9x2
 *     - colour: yellow
 *     - author: you
 *     - tags: #question #perf
 *     - created: 2026-10-26
 *     - line: 41
 *     <!-- heron-anchor {"prefix":"…","suffix":"…"} -->
 *
 *     ```ts
 *     const server = load(port);
 *     ```
 *
 *     Why load here and not in the constructor?
 *
 * People edit these files by hand, so parsing is tolerant (unknown fields,
 * missing parts, `color` for `colour`) and lossless: sections that were not
 * changed are written back byte for byte, and so is everything before the
 * first note.
 */

export const NOTE_COLOURS = ['yellow', 'green', 'blue', 'purple', 'red'] as const;
export type NoteColour = typeof NOTE_COLOURS[number];

export type NoteAuthor = 'you' | 'model';

export interface MarginNote {
	id: string;
	colour: NoteColour;
	author: NoteAuthor;
	/** Tags without the leading `#`. */
	tags: string[];
	/** Creation date, `YYYY-MM-DD`, or '' when unknown. */
	created: string;
	/** The quoted code and its context. */
	anchor: TextAnchor;
	/** Info string of the quote's code fence, e.g. `ts`. */
	language: string;
	/** The note's text (markdown); empty for a bare highlight. */
	body: string;
	/** Metadata lines this format does not know, kept as written. */
	extra: string[];
}

interface Section {
	note: MarginNote;
	/** The section as read, or null once it has changed and must be rendered. */
	raw: string | null;
}

export interface NoteFrontmatter {
	/** Vault path of the repository, or '' for a file outside one. */
	repo: string;
	/** Path of the code file in its repository (or vault). */
	file: string;
	/** HEAD when the note file was created. */
	commit: string;
}

/** A parsed note file. Mutate it with the methods, then `serialize()`. */
export class NoteDocument {
	/** `preamble` is the text before the first note, or null when the file starts with one. */
	private constructor(private preamble: string | null, private sections: Section[]) {}

	static parse(text: string): NoteDocument {
		const lines = text.split('\n');
		const starts: number[] = [];
		let fence: string | null = null;
		lines.forEach((line, i) => {
			// Headings inside a code block (a quote of markdown) do not start notes.
			const f = FENCE.exec(line)?.[1];
			if (f && !fence) fence = f;
			else if (f && fence && isClosingFence(line, fence)) fence = null;
			else if (!fence && HEADING.test(line)) starts.push(i);
		});
		const first = starts[0] ?? lines.length;
		const preamble = first > 0 && text !== '' ? lines.slice(0, first).join('\n') : null;
		const sections = starts.map((start, k) => {
			const section = lines.slice(start, starts[k + 1] ?? lines.length);
			return { note: parseSection(section), raw: section.join('\n') };
		});
		return new NoteDocument(preamble, sections);
	}

	/** A new note file for `meta` with no notes yet. */
	static create(meta: NoteFrontmatter, codeLink: string): NoteDocument {
		const front = [
			'---',
			`repo: ${yamlString(meta.repo)}`,
			`file: ${yamlString(meta.file)}`,
			`commit: ${yamlString(meta.commit)}`,
			'---',
			'',
			`Margin notes on ${codeLink}.`,
			'',
		].join('\n');
		return new NoteDocument(front, []);
	}

	get notes(): MarginNote[] {
		return this.sections.map((s) => s.note);
	}

	frontmatter(): NoteFrontmatter {
		return parseFrontmatter(this.preamble ?? '');
	}

	find(id: string): MarginNote | undefined {
		return this.sections.find((s) => s.note.id === id)?.note;
	}

	/** Adds `note` at the end. */
	add(note: MarginNote) {
		this.sections.push({ note, raw: null });
	}

	/** Changes a note; returns false when there is no note with that id. */
	update(id: string, patch: Partial<Omit<MarginNote, 'id'>>): boolean {
		const section = this.sections.find((s) => s.note.id === id);
		if (!section) return false;
		section.note = { ...section.note, ...patch };
		section.raw = null;
		return true;
	}

	/** Removes a note; returns false when there is no note with that id. */
	remove(id: string): boolean {
		const i = this.sections.findIndex((s) => s.note.id === id);
		if (i < 0) return false;
		this.sections.splice(i, 1);
		return true;
	}

	serialize(): string {
		// Chunks are joined by newlines, which reproduces unchanged text exactly.
		const chunks: string[] = this.preamble === null ? [] : [this.preamble];
		for (const section of this.sections) {
			if (section.raw !== null) {
				chunks.push(section.raw);
				continue;
			}
			// A changed note gets exactly one blank line before it and after it.
			const prev = chunks.length - 1;
			if (prev >= 0) chunks[prev] = (chunks[prev] ?? '').replace(/\n*$/, '\n');
			chunks.push(`${renderSection(section.note)}\n`);
		}
		return chunks.join('\n');
	}
}

const HEADING = /^##\s+Note\s+([\w-]+)\s*$/;
const META = /^\s*[-*]\s+([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/;
const ANCHOR_COMMENT = /^\s*<!--\s*heron-anchor\s+(.*?)\s*-->\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

/** True when `line` closes a code block opened with `fence`. */
function isClosingFence(line: string, fence: string): boolean {
	const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
	return !!close && close[0] === fence[0] && close.length >= fence.length;
}

function isColour(value: string): value is NoteColour {
	return (NOTE_COLOURS as readonly string[]).includes(value);
}

function parseSection(lines: string[]): MarginNote {
	const id = HEADING.exec(lines[0] ?? '')?.[1] ?? '';
	const note: MarginNote = {
		id, colour: 'yellow', author: 'you', tags: [], created: '',
		anchor: { quote: '', prefix: '', suffix: '' }, language: '', body: '', extra: [],
	};
	let i = 1;
	// Metadata: list items, the anchor comment and blank lines before the quote.
	for (; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (!line.trim()) continue;
		const anchor = ANCHOR_COMMENT.exec(line);
		if (anchor) {
			Object.assign(note.anchor, parseAnchorJson(anchor[1] ?? ''));
			continue;
		}
		const meta = META.exec(line);
		if (!meta) break;
		const key = (meta[1] ?? '').toLowerCase();
		const value = meta[2] ?? '';
		if (key === 'colour' || key === 'color') {
			const colour = value.toLowerCase();
			if (isColour(colour)) note.colour = colour;
			else note.extra.push(line);
		} else if (key === 'author') {
			note.author = value.toLowerCase() === 'model' ? 'model' : 'you';
		} else if (key === 'tags') {
			note.tags = parseTags(value);
		} else if (key === 'created') {
			note.created = value;
		} else if (key === 'line') {
			const n = Number.parseInt(value, 10);
			if (Number.isFinite(n) && n > 0) note.anchor.line = n - 1;
		} else {
			note.extra.push(line);
		}
	}
	// The quote: a code block right after the metadata.
	const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i] ?? '');
	if (open) {
		const fence = open[1] ?? '```';
		note.language = (open[2] ?? '').trim();
		let j = i + 1;
		while (j < lines.length && !isClosingFence(lines[j] ?? '', fence)) j++;
		note.anchor.quote = lines.slice(i + 1, j).join('\n');
		i = j + 1;
	}
	note.body = lines.slice(i).join('\n').replace(/^\s*\n/, '').trimEnd();
	return note;
}

function parseAnchorJson(text: string): Partial<TextAnchor> {
	try {
		const value = JSON.parse(text) as unknown;
		if (!value || typeof value !== 'object') return {};
		const v = value as Record<string, unknown>;
		return {
			...(typeof v.prefix === 'string' ? { prefix: v.prefix } : {}),
			...(typeof v.suffix === 'string' ? { suffix: v.suffix } : {}),
		};
	} catch {
		return {};
	}
}

/** `#a #b`, `a, b` or `[a, b]` → `['a', 'b']`. */
export function parseTags(value: string): string[] {
	const tags = value.replace(/^\[|\]$/g, '').split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
	return [...new Set(tags)];
}

/** A code fence longer than any run of backticks in `text`. */
function fenceFor(text: string): string {
	const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	return '`'.repeat(longest + 1);
}

/** Renders one note as a markdown section, without a trailing newline. */
export function renderSection(note: MarginNote): string {
	const lines = [
		`## Note ${note.id}`,
		`- colour: ${note.colour}`,
		`- author: ${note.author}`,
	];
	if (note.tags.length) lines.push(`- tags: ${note.tags.map((t) => `#${t}`).join(' ')}`);
	if (note.created) lines.push(`- created: ${note.created}`);
	if (note.anchor.line !== undefined) lines.push(`- line: ${note.anchor.line + 1}`);
	lines.push(...note.extra);
	lines.push(`<!-- heron-anchor ${anchorJson(note.anchor)} -->`);
	const fence = fenceFor(note.anchor.quote);
	lines.push('', `${fence}${note.language}`, note.anchor.quote, fence);
	if (note.body.trim()) lines.push('', note.body.trimEnd());
	return lines.join('\n');
}

/** The anchor context as JSON that cannot end the HTML comment it sits in. */
function anchorJson(anchor: TextAnchor): string {
	return JSON.stringify({ prefix: anchor.prefix, suffix: anchor.suffix }).replace(/--/g, '-\\u002d').replace(/>/g, '\\u003e');
}

/** A YAML scalar for `value`: plain when that is safe, else double-quoted. */
export function yamlString(value: string): string {
	return /^[\w./@+-][\w ./@+-]*$/.test(value) && !/\s$/.test(value) ? value : JSON.stringify(value);
}

function unquote(value: string): string {
	const v = value.trim();
	if (v.startsWith('"')) {
		try {
			return String(JSON.parse(v));
		} catch {
			return v.slice(1, -1);
		}
	}
	if (v.startsWith('\'') && v.endsWith('\'')) return v.slice(1, -1).replace(/''/g, '\'');
	return v;
}

/** Reads `repo`, `file` and `commit` from a note's frontmatter; missing ones are ''. */
export function parseFrontmatter(text: string): NoteFrontmatter {
	const result: NoteFrontmatter = { repo: '', file: '', commit: '' };
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!match) return result;
	for (const line of (match[1] ?? '').split(/\r?\n/)) {
		const kv = /^(repo|file|commit)\s*:\s*(.*)$/.exec(line);
		if (kv) result[kv[1] as keyof NoteFrontmatter] = unquote(kv[2] ?? '');
	}
	return result;
}

/** A short random note id that is not in `taken`. */
export function newNoteId(taken: Iterable<string>, random: () => number = Math.random): string {
	const used = new Set(taken);
	for (;;) {
		let id = '';
		for (let i = 0; i < 6; i++) id += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)] ?? '0';
		if (!used.has(id)) return id;
	}
}
