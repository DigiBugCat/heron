import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRepo } from '../src/git/GitRepo';
import { git, makeRepo, remove, write } from './helpers';

const cleanup: string[] = [];
afterEach(() => {
	while (cleanup.length) remove(cleanup.pop() ?? '');
});

async function open(folder: string): Promise<GitRepo> {
	const result = await GitRepo.open(folder);
	if (result.kind !== 'repo') throw new Error(`expected a repo, got ${result.kind}`);
	return result.repo;
}

describe('linked worktrees inside the repository', () => {
	it('are left out of changes and the file list, unlike unrelated nested repositories', async () => {
		const root = makeRepo({ 'a.txt': 'a\n' });
		const other = makeRepo({ 'x.txt': 'x\n' });
		cleanup.push(root, other);
		git(root, 'worktree', 'add', '-q', '-b', 'agent', '.claude/worktrees/agent');
		git(root, 'init', '-q', 'vendor/lib');
		// A worktree of a different repository that happens to live in this one.
		git(other, 'worktree', 'add', '-q', '-b', 'stray', path.join(root, 'stray'));
		write(root, 'new.txt', 'n\n');

		const repo = await open(root);
		const untracked = (await repo.status()).files.map((f) => f.path).sort();
		expect(untracked).toEqual(['new.txt', 'stray/', 'vendor/lib/']);
		const files = (await repo.listFiles()).sort();
		expect(files).toEqual(['a.txt', 'new.txt', 'stray/', 'vendor/lib/']);
	});

	it('open as repositories of their own, sharing the main repository\'s git dir', async () => {
		const root = makeRepo({ 'src/a.ts': 'a\n' });
		cleanup.push(root);
		git(root, 'worktree', 'add', '-q', '-b', 'agent', '.claude/worktrees/agent');
		const main = await open(root);
		const linked = await open(path.join(root, '.claude/worktrees/agent/src'));
		expect(linked.root).toBe(path.join(root, '.claude/worktrees/agent'));
		expect(linked.commonDir).toBe(main.commonDir);
		expect(linked.gitDir).not.toBe(main.gitDir);
		expect(linked.repoPath(path.join(linked.folder, 'a.ts'))).toBe('src/a.ts');
	});
});
