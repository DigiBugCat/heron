import { describe, expect, it } from 'vitest';
import { makeAnchor } from '../src/notes/anchor';
import { MarginNote, newNoteId, NoteDocument, parseFrontmatter, parseTags, renderSection, yamlString } from '../src/notes/noteFormat';
import { diagramPath, notePath, parentFolders } from '../src/notes/notePaths';

const HAND_WRITTEN = `---
repo: Code/heron
file: src/main.ts
commit: dc70c55
tags: [review]
---

Margin notes on [[Code/heron/src/main.ts|src/main.ts]].

Some thoughts of my own before the notes.

## Note abc123
- colour: green
- author: you
- tags: #question #perf
- created: 2026-10-20
- line: 4
- reviewer: sam
<!-- heron-anchor {"prefix":"before\\n","suffix":"\\nafter"} -->

\`\`\`ts
const server = load(port);
\`\`\`

Why load here?

- a list in the body
- color: not metadata, this is the body

## Note zz9
* Color: Purple
* author: model

~~~
## Note fake — a heading inside the quote
~~~
Body with a code block:

\`\`\`md
## Note alsofake
\`\`\`
`;

function note(overrides: Partial<MarginNote> = {}): MarginNote {
	return {
		id: 'n1', colour: 'yellow', author: 'you', tags: [], created: '2026-10-26',
		anchor: { quote: 'x();', prefix: 'a\n', suffix: '\nb', line: 9 },
		language: 'ts', body: 'A note.', extra: [],
		...overrides,
	};
}

describe('NoteDocument', () => {
	it('parses hand-written notes tolerantly', () => {
		const doc = NoteDocument.parse(HAND_WRITTEN);
		expect(doc.notes.map((n) => n.id)).toEqual(['abc123', 'zz9']);
		const [first, second] = doc.notes;
		expect(first).toMatchObject({
			colour: 'green', author: 'you', tags: ['question', 'perf'], created: '2026-10-20', language: 'ts',
			anchor: { quote: 'const server = load(port);', prefix: 'before\n', suffix: '\nafter', line: 3 },
			extra: ['- reviewer: sam'],
		});
		expect(first?.body).toBe('Why load here?\n\n- a list in the body\n- color: not metadata, this is the body');
		expect(second).toMatchObject({ colour: 'purple', author: 'model', language: '' });
		expect(second?.anchor.quote).toBe('## Note fake — a heading inside the quote');
		expect(second?.body).toContain('## Note alsofake');
	});

	it('reads the frontmatter', () => {
		expect(NoteDocument.parse(HAND_WRITTEN).frontmatter()).toEqual({ repo: 'Code/heron', file: 'src/main.ts', commit: 'dc70c55' });
	});

	it('writes unchanged files back byte for byte', () => {
		for (const text of [HAND_WRITTEN, '', 'just text', '## Note a1\n', '## Note a1\nbody', 'pre\n## Note a\n\n## Note b\nx\n\n\n']) {
			expect(NoteDocument.parse(text).serialize()).toBe(text);
		}
	});

	it('keeps other notes byte for byte when one changes', () => {
		const doc = NoteDocument.parse(HAND_WRITTEN);
		expect(doc.update('zz9', { body: 'Rewritten.' })).toBe(true);
		const out = doc.serialize();
		expect(out.slice(0, out.indexOf('## Note zz9'))).toBe(HAND_WRITTEN.slice(0, HAND_WRITTEN.indexOf('## Note zz9')));
		const again = NoteDocument.parse(out);
		expect(again.find('zz9')).toMatchObject({ body: 'Rewritten.', colour: 'purple', author: 'model' });
		expect(again.find('abc123')).toEqual(NoteDocument.parse(HAND_WRITTEN).find('abc123'));
	});

	it('round-trips a rendered note, including awkward quotes and context', () => {
		const tricky = note({
			anchor: { quote: 'const s = `a ``` b`;\n-->\n', prefix: '<!-- x -->', suffix: '"quoted"\n--', line: 0 },
			tags: ['explain'], author: 'model', colour: 'blue', body: '## Not a note heading\n\nText.', extra: ['- reviewer: sam'],
		});
		const doc = NoteDocument.create({ repo: 'Code/heron', file: 'src/a b.ts', commit: '' }, '[[Code/heron/src/a b.ts]]');
		doc.add(tricky);
		doc.add(note({ id: 'n2', body: '' }));
		const text = doc.serialize();
		const parsed = NoteDocument.parse(text);
		expect(parsed.notes).toEqual([tricky, note({ id: 'n2', body: '' })]);
		expect(parsed.frontmatter()).toEqual({ repo: 'Code/heron', file: 'src/a b.ts', commit: '' });
		expect(parsed.serialize()).toBe(text);
		// The anchor comment must stay one HTML comment.
		for (const line of text.split('\n').filter((l) => l.startsWith('<!-- heron-anchor'))) {
			expect(line.slice('<!-- heron-anchor'.length, -3)).not.toMatch(/--|>/);
		}
	});

	it('separates added notes from existing text by one blank line', () => {
		const doc = NoteDocument.parse('intro\n\n\n');
		doc.add(note());
		expect(doc.serialize()).toBe(`intro\n\n${renderSection(note())}\n`);
		const noNewline = NoteDocument.parse('## Note a\nbody');
		noNewline.add(note());
		expect(noNewline.serialize()).toBe(`## Note a\nbody\n\n${renderSection(note())}\n`);
	});

	it('removes a note and leaves the rest', () => {
		const doc = NoteDocument.parse(HAND_WRITTEN);
		expect(doc.remove('abc123')).toBe(true);
		expect(doc.remove('missing')).toBe(false);
		const out = doc.serialize();
		expect(out).not.toContain('abc123');
		expect(NoteDocument.parse(out).notes.map((n) => n.id)).toEqual(['zz9']);
	});

	it('treats a note without a quote as one that cannot be anchored', () => {
		const doc = NoteDocument.parse('## Note q1\n- colour: red\n\nJust text, no code.\n');
		expect(doc.notes[0]).toMatchObject({ colour: 'red', anchor: { quote: '' }, body: 'Just text, no code.' });
	});

	it('stores a bare highlight without a body', () => {
		const text = renderSection(note({ body: '  ' }));
		expect(text.endsWith('```')).toBe(true);
		expect(NoteDocument.parse(text).notes[0]?.body).toBe('');
	});

	it('keeps anchors made from real text', () => {
		const code = 'a();\nconst server = load(port);\nb();\n';
		const anchor = makeAnchor(code, 5, 31);
		const doc = NoteDocument.parse('');
		doc.add(note({ anchor }));
		expect(NoteDocument.parse(doc.serialize()).notes[0]?.anchor).toEqual(anchor);
	});
});

describe('note helpers', () => {
	it('parses tags in several spellings', () => {
		expect(parseTags('#a #b')).toEqual(['a', 'b']);
		expect(parseTags('a, b, a')).toEqual(['a', 'b']);
		expect(parseTags('[x, y]')).toEqual(['x', 'y']);
	});

	it('quotes YAML values only when needed', () => {
		expect(yamlString('Code/heron')).toBe('Code/heron');
		expect(yamlString('a: b')).toBe('"a: b"');
		expect(yamlString('')).toBe('""');
		expect(parseFrontmatter('---\nrepo: "a: b"\nfile: \'it\'\'s\'\n---\n')).toEqual({ repo: 'a: b', file: 'it\'s', commit: '' });
	});

	it('makes unused ids', () => {
		let n = 0;
		const seq = [0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0];
		expect(newNoteId(['000000'], () => seq[n++] ?? 0)).toBe('i00000');
	});

	it('puts notes under the folder, by repository name and file path', () => {
		const target = { vaultPath: 'Code/heron/src/main.ts', repo: 'Code/heron', file: 'src/main.ts' };
		expect(notePath('Code notes', target)).toBe('Code notes/heron/src/main.ts.md');
		expect(notePath('', target)).toBe('Code notes/heron/src/main.ts.md');
		expect(notePath('Notes/', { vaultPath: 'scripts/x.py', repo: '', file: 'scripts/x.py' })).toBe('Notes/scripts/x.py.md');
		const taken = new Set(['Code notes/heron/src/main.ts diagram.md']);
		expect(diagramPath('Code notes', target, '', (p) => taken.has(p))).toBe('Code notes/heron/src/main.ts diagram 2.md');
		expect(diagramPath('Code notes', target, 'Server.start', () => false)).toBe('Code notes/heron/src/main.ts Server.start diagram.md');
		expect(parentFolders('a/b/c.md')).toEqual(['a', 'a/b']);
	});
});
