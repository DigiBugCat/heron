import { symlinkSync } from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { isHiddenPath, walkFolder } from '../src/services/folderWalk';
import { remove, tempDir, write } from './helpers';

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) remove(cleanup.pop() ?? ''); });

describe('isHiddenPath', () => {
	it('detects hidden paths by any segment', () => {
		expect(isHiddenPath('a/.b/c')).toBe(true);
		expect(isHiddenPath('a/b.c/d')).toBe(false);
	});
});

describe('walkFolder', () => {
	it('skips VCS and dependency folders and does not follow symlinked directories', async () => {
		const root = tempDir();
		cleanup.push(root);
		write(root, 'a.txt', '');
		write(root, 'src/b.ts', '');
		write(root, 'node_modules/pkg/index.js', '');
		write(root, '.git/HEAD', '');
		symlinkSync(path.join(root, 'src'), path.join(root, 'loop'), 'dir');
		const { rels, truncated } = await walkFolder(root);
		expect(truncated).toBe(false);
		// The symlink itself is listed as an entry, but never descended into.
		expect(rels.sort()).toEqual(['a.txt', 'loop', 'src/b.ts']);
	});

	it('stops at the limit', async () => {
		const root = tempDir();
		cleanup.push(root);
		for (let i = 0; i < 10; i++) write(root, `f${i}.txt`, '');
		const { rels, truncated } = await walkFolder(root, 4);
		expect(rels).toHaveLength(4);
		expect(truncated).toBe(true);
	});
});
