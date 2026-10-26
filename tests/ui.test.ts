// @vitest-environment jsdom
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component } from 'obsidian';
import type { FileCommit } from '../src/git/history';
import { CodeEmbed, sliceLines } from '../src/ui/embed/CodeEmbed';
import { CodeRenderer, DiffRenderer } from '../src/ui/pane/renderers';
import { CodeSurface, CodeSurfaceHost } from '../src/ui/vault/CodeSurface';
import { git, makeRepo, remove, tempDir, write } from './helpers';

const cleanup: string[] = [];
const roots: Component[] = [];
afterEach(() => {
	for (const c of roots.splice(0)) c.unload();
	document.body.innerHTML = '';
	while (cleanup.length) remove(cleanup.pop() ?? '');
});

function host(): { owner: Component; el: HTMLElement } {
	const owner = new Component();
	owner.load();
	roots.push(owner);
	return { owner, el: document.body.createDiv() };
}

/** A code surface without a language server, as a code tab shows it. */
function surface(extra: Partial<CodeSurfaceHost> = {}): { surface: CodeSurface; el: HTMLElement; owner: Component } {
	const { owner, el } = host();
	const s = owner.addChild(new CodeSurface(el, {
		app: {} as never,
		lsp: { onChange: () => () => undefined, choose: () => null } as never,
		fontSize: 13,
		wordWrap: false,
		open: () => Promise.resolve(null),
		label: (p) => p,
		onStatus: () => undefined,
		...extra,
	}));
	return { surface: s, el, owner };
}

/** Number of editors whose content wraps lines. */
const wrapped = (el: HTMLElement) => el.querySelectorAll('.cm-content.cm-lineWrapping').length;

describe('code surface', () => {
	it('opens find and go-to-line only while a file is shown', async () => {
		const { surface: s, el } = surface();
		expect(s.openSearch()).toBe(false);
		expect(s.goToLine()).toBe(false);

		await s.show('/x/a.ts', 'const needle = 1;\n', null);
		expect(s.openSearch()).toBe(true);
		expect(el.querySelector('.cm-panel.cm-search')).not.toBeNull();
		expect(s.goToLine()).toBe(true);
		expect(el.querySelector('.cm-goto-line, .cm-gotoLine')).not.toBeNull();
	});

	it('highlights and selects linked lines, and links to the selection from the repository root', async () => {
		const root = makeRepo({ 'src/a.ts': Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') });
		cleanup.push(root);
		const { surface: s, el } = surface();
		await s.show(path.join(root, 'src/a.ts'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'), null);

		expect(s.showLines({ from: 3, to: 5 })).toBe(true);
		expect(el.querySelectorAll('.heron-linked-line')).toHaveLength(3);
		expect(s.selection()).toEqual({ lines: { from: 3, to: 5 }, text: 'line 3\nline 4\nline 5' });
		expect(s.linkLocation()).toEqual({
			loc: { folder: root, file: 'src/a.ts', lines: { from: 3, to: 5 } },
			text: 'line 3\nline 4\nline 5',
		});

		// Loading the file again clears the highlight; without a selection the link is to the whole file.
		await s.show(path.join(root, 'src/a.ts'), 'line 1\n', null);
		expect(el.querySelectorAll('.heron-linked-line')).toHaveLength(0);
		expect(s.linkLocation()?.loc.lines).toBeNull();
	});

	it('clamps linked lines past the end of the file', async () => {
		const { surface: s, el } = surface();
		await s.show('/x/a.ts', 'one\ntwo', null);
		expect(s.showLines({ from: 2, to: 99 })).toBe(true);
		expect(el.querySelectorAll('.heron-linked-line')).toHaveLength(1);
		expect(s.showLines({ from: 50, to: 60 })).toBe(false);
	});

	it('reuses one editor across files and destroys it on unload', async () => {
		const { surface: s, el, owner } = surface();
		await s.show('/x/a.py', 'print(1)\n', null);
		const editor = el.querySelector('.cm-editor');
		await s.show('/x/b.go', 'package main\n', null);
		expect(el.querySelector('.cm-editor')).toBe(editor);
		expect(el.textContent).toContain('package main');

		owner.removeChild(s);
		expect(el.querySelectorAll('.cm-editor')).toHaveLength(0);
	});

	it('toggles a blame gutter that follows the shown file and opens commits on click', async () => {
		const root = makeRepo({ 'a.ts': 'const first = 1;\n', 'b.ts': 'const second = first;\n' });
		cleanup.push(root);
		write(root, 'a.ts', 'const first = 1;\nconst third = 3;\n');
		git(root, 'add', '-A');
		git(root, '-c', 'user.name=Other', '-c', 'user.email=o@x', 'commit', '-q', '--author=Other <o@x>', '-m', 'Add third');
		const opened: { root: string; commit: FileCommit }[] = [];
		const { surface: s, el } = surface({ openCommit: (r, commit) => opened.push({ root: r, commit }) });
		const changes: string[] = [];
		s.onChange((c) => changes.push(c));
		await s.show(path.join(root, 'a.ts'), 'const first = 1;\nconst third = 3;\n', null);

		expect(s.toggleBlame()).toBe(true);
		expect(s.blameShown).toBe(true);
		expect(changes).toContain('blame');
		await vi.waitFor(() => expect(el.querySelectorAll('.heron-blame-start')).toHaveLength(2));
		expect(Array.from(el.querySelectorAll('.heron-blame-author')).map((a) => a.textContent)).toEqual(['Test', 'Other']);
		expect(Array.from(el.querySelectorAll('.heron-blame-age')).map((x) => x.textContent)).toEqual(['now', 'now']);

		await s.show(path.join(root, 'b.ts'), 'const second = first;\n', null);
		await vi.waitFor(() => expect(Array.from(el.querySelectorAll('.heron-blame-author')).map((a) => a.textContent)).toEqual(['Test']));

		el.querySelector('.heron-blame-start')?.parentElement?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await vi.waitFor(() => expect(opened).toHaveLength(1));
		expect(opened[0]?.root).toBe(root);
		expect(opened[0]?.commit).toMatchObject({ subject: 'init', path: 'b.ts', author: 'Test' });

		expect(s.toggleBlame()).toBe(false);
		expect(el.querySelectorAll('.heron-blame-gutter')).toHaveLength(0);
	});

	it('wraps the code view and follows the setting', () => {
		const { owner, el } = host();
		const code = owner.addChild(new CodeRenderer(el, 13, true));
		code.setDocument('const a = 1;\n', 'a.ts', false);
		expect(wrapped(el)).toBe(1);
		code.setWordWrap(false);
		expect(wrapped(el)).toBe(0);
	});
});

describe('diff renderer', () => {
	const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
	const after = before.replace('line 100', 'line one hundred');

	it('renders side by side with stats, and wraps both sides', () => {
		const { owner, el } = host();
		const diff = owner.addChild(new DiffRenderer(el, 13, before, after, 'big.ts', 'split'));
		expect(el.querySelectorAll('.heron-diff-split .cm-mergeView .cm-editor')).toHaveLength(2);
		expect(el.querySelector('.cm-merge-a')?.textContent).toContain('line 100');
		expect(el.querySelector('.cm-merge-b')?.textContent).toContain('line one hundred');
		expect(diff.stats()).toEqual({ added: 1, removed: 1 });
		expect(wrapped(el)).toBe(0);
		diff.setWordWrap(true);
		expect(wrapped(el)).toBe(2);

		owner.removeChild(diff);
		expect(el.querySelectorAll('.cm-editor')).toHaveLength(0);
	});

	it('renders unified in one editor', () => {
		const { owner, el } = host();
		owner.addChild(new DiffRenderer(el, 13, before, after, 'big.ts', 'unified'));
		expect(el.querySelectorAll('.heron-diff-unified .cm-editor')).toHaveLength(1);
	});
});

describe('CodeEmbed', () => {
	const until = async (check: () => boolean, ms = 3000) => {
		for (const start = Date.now(); !check() && Date.now() - start < ms;) await new Promise((r) => setTimeout(r, 25));
	};

	it('slices lines, ignoring a trailing newline', () => {
		expect(sliceLines('a\nb\nc\n', 2, 9)).toEqual({ text: 'b\nc', to: 3 });
		expect(sliceLines('a\nb\n', 3, 4)).toBeNull();
	});

	it('renders the embedded lines with their real line numbers and opens on click, in a new tab with Mod', async () => {
		const dir = tempDir();
		cleanup.push(dir);
		write(dir, 'src/a.ts', Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n'));
		const { owner, el } = host();
		const location = { folder: dir, file: 'src/a.ts', lines: { from: 11, to: 12 } };
		const opened: unknown[] = [];
		owner.addChild(new CodeEmbed(el, { absPath: path.join(dir, 'src/a.ts'), location }, (l, newTab) => opened.push([l, newTab])));

		await until(() => !!el.querySelector('.cm-content'));
		expect(el.querySelector('.cm-content')?.textContent).toBe('const v11 = 11;const v12 = 12;');
		expect(el.querySelector('.cm-lineNumbers')?.textContent).toContain('11');
		expect(el.querySelector('.heron-embed-label')?.textContent).toBe('src/a.ts:11-12');

		el.querySelector<HTMLElement>('.heron-embed-header')?.click();
		el.querySelector<HTMLElement>('.heron-embed-header')?.dispatchEvent(new MouseEvent('click', { metaKey: true, bubbles: true }));
		expect(opened).toEqual([[location, false], [location, true]]);
	});

	it('updates when the file changes and explains missing files', async () => {
		const dir = tempDir();
		cleanup.push(dir);
		write(dir, 'a.ts', 'before');
		const { owner, el } = host();
		const embed = owner.addChild(new CodeEmbed(el, {
			absPath: path.join(dir, 'a.ts'),
			location: { folder: dir, file: 'a.ts', lines: null },
		}, () => {}));
		await until(() => el.querySelector('.cm-content')?.textContent === 'before');

		write(dir, 'a.ts', 'after');
		await until(() => el.querySelector('.cm-content')?.textContent === 'after');
		expect(el.querySelector('.cm-content')?.textContent).toBe('after');

		remove(path.join(dir, 'a.ts'));
		await until(() => !!el.querySelector('.heron-embed-message'));
		expect(el.querySelector('.heron-embed-message')?.textContent).toContain('File not found');
		expect(el.querySelectorAll('.cm-editor')).toHaveLength(0);

		owner.removeChild(embed);
	});
});
