// @vitest-environment jsdom
/**
 * The call graph against the real `typescript-language-server` dev
 * dependency (or the folder in HERON_LSP_PATH). Skipped when unavailable.
 */
import { existsSync } from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component } from 'obsidian';
import { LspManager } from '../src/lsp/LspManager';
import { buildCallGraph } from '../src/lsp/callHierarchy';
import { mergePaths } from '../src/lsp/shellEnv';
import { CodeSurface } from '../src/ui/vault/CodeSurface';
import { remove, tempDir, write } from './helpers';

const LOCAL_BIN = path.resolve(__dirname, '..', 'node_modules', '.bin');
const extraPath = process.env.HERON_LSP_PATH ?? (existsSync(path.join(LOCAL_BIN, 'typescript-language-server')) ? LOCAL_BIN : undefined);

const cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

describe.skipIf(!extraPath)('call graph with a real language server', () => {
	it('typescript-language-server: finds callers and callees of a function', async () => {
		const root = tempDir('heron-calls-');
		const files = {
			'tsconfig.json': '{ "compilerOptions": { "strict": true }, "include": ["*.ts"] }',
			'main.ts': 'import { run } from "./app";\nexport function main() { run(); }\n',
			'app.ts': 'import { save } from "./store";\nexport function run() { save(); }\n',
			'store.ts': 'export function save() {}\n',
		};
		for (const [rel, text] of Object.entries(files)) write(root, rel, text);
		const lsp = new LspManager({
			enabled: () => true,
			commands: () => ({}),
			path: () => Promise.resolve(mergePaths(extraPath ?? '', process.env.PATH ?? '')),
		});
		const owner = new Component();
		owner.load();
		cleanup.push(() => { lsp.stopAll(); owner.unload(); document.body.innerHTML = ''; remove(root); });
		const surface = owner.addChild(new CodeSurface(document.body.createDiv(), {
			app: {} as never, lsp, fontSize: 13, wordWrap: false,
			open: () => Promise.resolve(null), label: (p) => p, onStatus: () => undefined,
		}));
		await surface.show(path.join(root, 'app.ts'), files['app.ts'], { line: 1, character: 17 });
		await vi.waitFor(() => expect(surface.hasCodeIntel()).toBe(true), { timeout: 30000 });

		const cursor = await surface.cursorRequest();
		if (!cursor) throw new Error('no language server');
		expect(cursor.supports('callHierarchyProvider')).toBe(true);
		let names: string[] = [];
		await vi.waitFor(async () => {
			const graph = await buildCallGraph((m, p) => cursor.request(m, p), cursor.textDocument, cursor.position);
			names = (graph?.items ?? []).map((i) => i.name).sort();
			expect(names).toEqual(['main', 'run', 'save']);
		}, { timeout: 30000 });
	}, 90000);
});
