// @vitest-environment jsdom
import { mkdirSync } from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { findRepoRoot } from '../src/utils/paths';
import { findRepos, parentFolders } from '../src/ui/vault/ExplorerGit';
import { makeRepo, remove, tempDir, write } from './helpers';

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) remove(cleanup.pop() ?? ''); });

describe('repositories in the vault', () => {
	it('finds repositories a few levels down, skipping hidden folders and node_modules', async () => {
		const vault = tempDir('heron-vault-');
		cleanup.push(vault);
		write(vault, 'Notes/a.md', '# a');
		mkdirSync(path.join(vault, 'Code/app/.git'), { recursive: true });
		mkdirSync(path.join(vault, 'Code/app/packages/inner/.git'), { recursive: true });
		mkdirSync(path.join(vault, '.trash/old/.git'), { recursive: true });
		mkdirSync(path.join(vault, 'node_modules/dep/.git'), { recursive: true });
		mkdirSync(path.join(vault, 'a/b/c/d/.git'), { recursive: true });
		expect((await findRepos(vault)).sort()).toEqual(['Code/app']);
	});

	it('lists the folders above a vault path, nearest first', () => {
		expect(parentFolders('Code/app/src/main.ts')).toEqual(['Code/app/src', 'Code/app', 'Code']);
		expect(parentFolders('README.md')).toEqual([]);
	});

	it('finds the repository root of a file deep inside it', async () => {
		const root = makeRepo({ 'src/deep/file.ts': 'x' });
		cleanup.push(root);
		expect(await findRepoRoot(path.join(root, 'src', 'deep'))).toBe(root);
		const outside = tempDir();
		cleanup.push(outside);
		expect(await findRepoRoot(outside)).toBeNull();
	});
});
