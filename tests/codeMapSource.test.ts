import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { codeMapMeta, LEGEND_ID, parseCanvas, stableId } from '../src/codemap/canvas';
import { buildCodeMap, listCodeMapFiles, mapChanges, readCodeMapSources } from '../src/services/CodeMapSource';
import { sanitizeSettings, sanitizeVaultFolder } from '../src/settings';
import { makeRepo, remove, tempDir, write } from './helpers';

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) remove(cleanup.pop() ?? ''); });

const FILES = {
	'.gitignore': 'dist/\n',
	'tsconfig.json': '{ "compilerOptions": { "paths": { "@lib/*": ["lib/*"] } } }',
	'src/main.ts': 'import { helper } from "@lib/helper";\nimport { view } from "./ui/view";\nimport "obsidian";\n',
	'src/ui/view.ts': 'export function view() {}\n',
	'lib/helper.ts': 'export function helper() {}\n',
	'README.md': '# readme\n',
	'.github/scripts/x.js': 'require("./y");\n',
};

describe('code map sources', () => {
	it('lists the repository for resolution and the mapped folder for sources', async () => {
		const root = makeRepo(FILES);
		cleanup.push(root);
		write(root, 'dist/bundle.js', 'ignored');
		write(root, 'node_modules/pkg/index.js', 'ignored');
		const listing = await listCodeMapFiles(path.join(root, 'src'));
		expect(listing.root).toBe(root);
		expect(listing.scope).toBe('src');
		expect(listing.repo).not.toBeNull();
		expect(listing.sources).toEqual(['src/main.ts', 'src/ui/view.ts']);
		expect(listing.files).toContain('lib/helper.ts');
		expect(listing.files).not.toContain('dist/bundle.js');
		const { sources, configs } = await readCodeMapSources(listing);
		expect(sources.map((s) => s.path)).toEqual(['src/main.ts', 'src/ui/view.ts']);
		expect([...configs.keys()]).toEqual(['tsconfig.json']);
	});

	it('walks folders outside git, skipping dependency and build folders', async () => {
		const dir = tempDir('heron-map-');
		cleanup.push(dir);
		write(dir, 'app.py', 'import util\n');
		write(dir, 'util.py', '');
		write(dir, 'node_modules/x/index.js', '');
		write(dir, 'build/out.js', '');
		write(dir, '.venv/lib/site.py', '');
		const listing = await listCodeMapFiles(dir);
		expect(listing.repo).toBeNull();
		expect(listing.scope).toBe('');
		expect(listing.sources).toEqual(['app.py', 'util.py']);
	});

	it('builds a canvas linking vault files, coloured by git status, and keeps moved cards on update', async () => {
		const root = makeRepo(FILES);
		cleanup.push(root);
		write(root, 'src/ui/view.ts', 'export function view() { return 1; }\n');
		write(root, 'src/ui/new.ts', 'import "./view";\n');
		const listing = await listCodeMapFiles(root);
		const status = await listing.repo?.status();
		const changes = mapChanges(status?.files ?? []);
		expect(changes.get('src/ui/view.ts')).toBe('modified');
		expect(changes.get('src/ui/new.ts')).toBe('added');

		const request = { listing, level: 'files' as const, folderVaultPath: 'Code/app', rootLabel: 'app', changes, previous: null, now: new Date(2026, 0, 2, 3, 4) };
		const first = await buildCodeMap(request);
		expect(first).toMatchObject({ files: 4, imports: 3, skipped: 0 });
		const canvas = parseCanvas(first.text);
		expect(codeMapMeta(canvas)).toEqual({ kind: 'code-map', version: 1, source: 'Code/app', level: 'files' });
		const card = (p: string) => canvas?.nodes.find((n) => n.id === stableId('f', p));
		expect(card('src/main.ts')?.text).toContain('[[Code/app/src/main.ts|main.ts]]');
		expect(card('src/main.ts')?.text).toContain('1 package');
		expect(card('src/ui/view.ts')?.color).toBe('2');
		expect(card('src/ui/new.ts')?.color).toBe('4');
		expect(card('.github/scripts/x.js')).toBeUndefined();
		expect(canvas?.nodes.find((n) => n.id === LEGEND_ID)?.text).toContain('4 files · 3 imports · 1 package');

		// Move a card, then regenerate.
		const moved = { ...canvas, nodes: canvas?.nodes.map((n) => (n.id === stableId('f', 'lib/helper.ts') ? { ...n, x: 5000, y: 6000 } : n)) };
		const second = await buildCodeMap({ ...request, previous: JSON.stringify(moved), changes: new Map() });
		const again = parseCanvas(second.text);
		expect(again?.nodes.find((n) => n.id === stableId('f', 'lib/helper.ts'))).toMatchObject({ x: 5000, y: 6000 });
		expect(again?.nodes.find((n) => n.id === stableId('f', 'src/ui/view.ts'))?.color).toBeUndefined();

		// The same folder as a folder-level map.
		const folders = parseCanvas((await buildCodeMap({ ...request, level: 'folders' })).text);
		expect(codeMapMeta(folders)?.level).toBe('folders');
		expect(folders?.nodes.filter((n) => n.id.startsWith('heron-d-')).map((n) => n.text?.split('\n')[0]).sort()).toEqual(['**lib/**', '**src/**', '**src/ui/**']);
	});
});

describe('code map folder setting', () => {
	it('defaults to "Code maps" and cleans up typed paths', () => {
		expect(sanitizeSettings({}).codeMapFolder).toBe('Code maps');
		expect(sanitizeSettings({ codeMapFolder: 7 }).codeMapFolder).toBe('Code maps');
		expect(sanitizeSettings({ codeMapFolder: '/Maps/ code /' }).codeMapFolder).toBe('Maps/code');
		expect(sanitizeVaultFolder('../..', 'Fallback')).toBe('Fallback');
		expect(sanitizeVaultFolder('a/./b', 'Fallback')).toBe('a/b');
	});
});
