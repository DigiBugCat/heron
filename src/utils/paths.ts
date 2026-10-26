import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Expands a leading `~` and resolves to an absolute path. */
export function normalizeFolderInput(input: string): string {
	let p = input.trim();
	// Strip quotes added by "Copy as path" on Windows or shells.
	if (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) {
		p = p.slice(1, -1);
	}
	if (p === '~') p = os.homedir();
	else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2));
	return path.resolve(p);
}

export async function isDirectory(p: string): Promise<boolean> {
	try {
		return (await fsp.stat(p)).isDirectory();
	} catch {
		return false;
	}
}

export async function isFile(p: string): Promise<boolean> {
	try {
		return (await fsp.stat(p)).isFile();
	} catch {
		return false;
	}
}

/**
 * A short name for `absPath`: '/'-separated and relative to `folder` when
 * inside it, otherwise absolute with the home folder shown as `~`.
 */
export function displayPath(absPath: string, folder: string): string {
	if (folder) {
		const rel = path.relative(folder, absPath);
		if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
	}
	const home = os.homedir();
	return absPath.startsWith(home + path.sep) ? `~${absPath.slice(home.length)}` : absPath;
}

const repoRoots = new Map<string, string | null>();

/**
 * The nearest folder at or above `dir` that holds a `.git` entry (a
 * repository or worktree root), or null. Results are cached per folder.
 */
export async function findRepoRoot(dir: string): Promise<string | null> {
	const cached = repoRoots.get(dir);
	if (cached !== undefined) return cached;
	let root: string | null = null;
	try {
		await fsp.stat(path.join(dir, '.git'));
		root = dir;
	} catch {
		const parent = path.dirname(dir);
		root = parent === dir ? null : await findRepoRoot(parent);
	}
	repoRoots.set(dir, root);
	return root;
}
