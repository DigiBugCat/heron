// @vitest-environment jsdom
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component } from 'obsidian';
import { registerLinks } from '../src/links/register';
import { sanitizeSettings } from '../src/settings';
import { CodeFileView, ExternalCodeView } from '../src/ui/vault/codeTabs';
import { eStateFor, EXTERNAL_CODE_VIEW_TYPE, openSourceLocation, targetFrom, vaultFileAt } from '../src/ui/vault/openCode';
import { remove, tempDir, write } from './helpers';
import { Events, FileSystemAdapter, Scope, TFile } from './obsidian-shim';

const cleanup: string[] = [];
const roots: Component[] = [];
afterEach(() => {
	for (const c of roots.splice(0)) c.unload();
	document.body.innerHTML = '';
	while (cleanup.length) remove(cleanup.pop() ?? '');
});

/** A vault on disk whose listed files are `listed`; files elsewhere (e.g. hidden folders) are not. */
function vault(listed: Record<string, string>, unlisted: Record<string, string> = {}) {
	const base = tempDir();
	cleanup.push(base);
	for (const [rel, text] of Object.entries({ ...listed, ...unlisted })) write(base, rel, text);
	const files = new Map(Object.keys(listed).map((rel) => [rel, new TFile(rel)]));
	const leaves: { calls: unknown[][] }[] = [];
	const app = {
		vault: {
			adapter: new FileSystemAdapter(base),
			getAbstractFileByPath: (p: string) => files.get(p) ?? null,
			read: (f: TFile) => Promise.resolve(listed[f.path] ?? ''),
			on: () => ({}),
		},
		workspace: {
			getLeaf: (newLeaf: unknown) => {
				const calls: unknown[][] = [];
				leaves.push({ calls });
				return {
					newLeaf,
					openFile: (...args: unknown[]) => { calls.push(['openFile', newLeaf, ...args]); return Promise.resolve(); },
					setViewState: (...args: unknown[]) => { calls.push(['setViewState', newLeaf, ...args]); return Promise.resolve(); },
				};
			},
			on: () => ({}),
			requestSaveLayout: () => undefined,
		},
	};
	return { base, files, app, leaves };
}

describe('code tab targets', () => {
	it('round-trips lines and cursors through ephemeral state, and reads Obsidian\'s own line', () => {
		expect(eStateFor({ lines: { from: 3, to: 5 } })).toEqual({ heronLines: { from: 3, to: 5 }, line: 2 });
		expect(targetFrom(eStateFor({ lines: { from: 3, to: 5 } }))).toEqual({ lines: { from: 3, to: 5 } });
		expect(targetFrom(eStateFor({ cursor: { line: 4, character: 2 } }))).toEqual({ cursor: { line: 4, character: 2 } });
		expect(targetFrom({ line: 7 })).toEqual({ cursor: { line: 7, character: 0 } });
		expect(targetFrom({ focus: true })).toBeNull();
		expect(targetFrom(null)).toBeNull();
	});
});

describe('opening links and embeds', () => {
	it('opens a vault file through Obsidian at the linked lines', async () => {
		const { base, app, leaves, files } = vault({ 'Code/app/src/a.ts': 'a\nb\nc\n' });
		await openSourceLocation(app as never, base, { folder: path.join(base, 'Code/app'), file: 'src/a.ts', lines: { from: 2, to: 3 } }, true);
		expect(leaves[0]?.calls).toEqual([['openFile', 'tab', files.get('Code/app/src/a.ts'), { eState: { heronLines: { from: 2, to: 3 }, line: 1 } }]]);
	});

	it('opens files outside the vault, or that Obsidian does not list, in an external code tab', async () => {
		const outside = tempDir();
		cleanup.push(outside);
		write(outside, 'lib.py', 'x = 1\n');
		const { base, app, leaves } = vault({}, { '.hidden/tool.ts': 'x\n' });
		expect(vaultFileAt(app as never, base, path.join(base, '.hidden/tool.ts'))).toBeNull();

		await openSourceLocation(app as never, base, { folder: outside, file: 'lib.py', lines: null }, false);
		await openSourceLocation(app as never, base, { folder: base, file: '.hidden/tool.ts', lines: { from: 1, to: 1 } }, false);
		expect(leaves.map((l) => l.calls[0])).toEqual([
			['setViewState', false, { type: EXTERNAL_CODE_VIEW_TYPE, state: { absPath: path.join(outside, 'lib.py') }, active: true }, {}],
			['setViewState', false, { type: EXTERNAL_CODE_VIEW_TYPE, state: { absPath: path.join(base, '.hidden/tool.ts') }, active: true }, { heronLines: { from: 1, to: 1 }, line: 0 }],
		]);
	});

	it('registers obsidian://heron links (new tab) and ```heron embeds (same tab unless Mod)', async () => {
		const dir = tempDir();
		cleanup.push(dir);
		write(dir, 'src/a.ts', 'one\ntwo\nthree\n');
		let protocol: ((params: Record<string, string>) => void) | null = null;
		let processor: ((source: string, el: HTMLElement, ctx: { addChild: (c: Component) => void }) => void) | null = null;
		const openLocation = vi.fn(() => Promise.resolve());
		registerLinks({
			registerObsidianProtocolHandler: (action: string, handler: typeof protocol) => { if (action === 'heron') protocol = handler; },
			registerMarkdownCodeBlockProcessor: (language: string, handler: typeof processor) => { if (language === 'heron') processor = handler; },
			openLocation,
		} as never);

		protocol!({ action: 'heron', folder: dir, file: 'src/a.ts', lines: '2-3' });
		expect(openLocation).toHaveBeenLastCalledWith({ folder: dir, file: 'src/a.ts', lines: { from: 2, to: 3 } }, true);

		const owner = new Component();
		owner.load();
		roots.push(owner);
		const el = document.body.createDiv();
		processor!(`folder: ${dir}\nfile: src/a.ts\nlines: 2`, el, { addChild: (c) => owner.addChild(c) });
		el.querySelector<HTMLElement>('.heron-embed-header')?.click();
		expect(openLocation).toHaveBeenLastCalledWith({ folder: dir, file: 'src/a.ts', lines: { from: 2, to: 2 } }, false);
		el.querySelector<HTMLElement>('.heron-embed-header')?.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
		expect(openLocation).toHaveBeenLastCalledWith({ folder: dir, file: 'src/a.ts', lines: { from: 2, to: 2 } }, true);

		const bad = document.body.createDiv();
		processor!('lines: 2', bad, { addChild: () => undefined });
		expect(bad.querySelector('.heron-embed-error')?.textContent).toMatch(/^Missing "file:"/);
	});
});

describe('code tabs', () => {
	function plugin(app: unknown) {
		return {
			app,
			settings: sanitizeSettings({}),
			settingsEvents: new Events(),
			lsp: { onChange: () => () => undefined, choose: () => null },
			rewind: null,
			updateStatusBar: () => undefined,
			searchInCode: vi.fn(),
			openCommitDiff: vi.fn(),
		};
	}

	async function fileTab(text: string) {
		const { app, base } = vault({ 'src/a.ts': text });
		const heron = plugin(app);
		const view = new CodeFileView({ app } as never, heron as never);
		view.load();
		roots.push(view);
		document.body.append(view.containerEl);
		const file = new TFile('src/a.ts');
		return { view, heron, file, base };
	}

	const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');

	it('highlights the linked lines a vault file opens at, before or after it loads', async () => {
		const { view, file, base } = await fileTab(lines);
		view.setEphemeralState({ heronLines: { from: 4, to: 6 }, line: 3 });
		view.file = file as never;
		await view.onLoadFile(file as never);
		expect(view.codeSurface().absPath).toBe(path.join(base, 'src/a.ts'));
		expect(view.contentEl.querySelectorAll('.heron-linked-line')).toHaveLength(3);
		expect(view.codeSurface().selection()?.lines).toEqual({ from: 4, to: 6 });

		view.setEphemeralState({ heronLines: { from: 10, to: 10 } });
		expect(view.codeSurface().selection()?.lines).toEqual({ from: 10, to: 10 });
		view.setEphemeralState({ heronCursor: { line: 1, character: 0 } });
		expect(view.getEphemeralState()).toMatchObject({ heronCursor: { line: 1, character: 0 } });
	});

	it('finds in the file with Mod+F and searches all code with Mod+Shift+F while focused', async () => {
		const { view, heron, file } = await fileTab(lines);
		view.file = file as never;
		await view.onLoadFile(file as never);
		const scope = view.scope as unknown as Scope;
		expect(scope.trigger(['Mod'], 'F')).toBe(false);
		expect(view.contentEl.querySelector('.cm-panel.cm-search')).not.toBeNull();
		expect(scope.trigger(['Mod', 'Shift'], 'F')).toBe(false);
		expect(heron.searchInCode).toHaveBeenCalledTimes(1);
	});

	it('shows files outside the vault read-only at the linked lines', async () => {
		const dir = tempDir();
		cleanup.push(dir);
		write(dir, 'lib.py', lines);
		const { app } = vault({});
		const view = new ExternalCodeView({ app } as never, plugin(app) as never);
		view.load();
		roots.push(view);
		await view.setState({ absPath: path.join(dir, 'lib.py') }, {} as never);
		view.setEphemeralState({ heronLines: { from: 2, to: 2 } });
		expect(view.getDisplayText()).toBe('lib.py');
		expect(view.codeSurface().isEditable).toBe(false);
		expect(view.contentEl.querySelectorAll('.heron-linked-line')).toHaveLength(1);

		await view.setState({ absPath: path.join(dir, 'missing.py') }, {} as never);
		expect(view.contentEl.textContent).toContain('missing.py was not found');
	});
});
