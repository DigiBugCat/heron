/** Where a code file's notes live in the vault. Pure; paths are '/'-separated vault paths. */

export const DEFAULT_NOTES_FOLDER = 'Code notes';

/** A code file in the vault, and the repository it belongs to. */
export interface CodeTarget {
	/** Vault path of the code file. */
	vaultPath: string;
	/** Vault path of its repository, or '' when it is not in one inside the vault. */
	repo: string;
	/** Path of the file inside the repository, or its vault path without one. */
	file: string;
}

/** Joins vault path parts, dropping empty parts and duplicate slashes. */
export function joinVaultPath(...parts: string[]): string {
	return parts.flatMap((p) => p.split('/')).filter((p) => p && p !== '.').join('/');
}

/** `Code notes/<repo name>/<path>` without an extension: the base of a file's note paths. */
export function noteBase(folder: string, target: CodeTarget): string {
	const root = folder.trim() || DEFAULT_NOTES_FOLDER;
	if (!target.repo) return joinVaultPath(root, target.file);
	const repoName = target.repo.split('/').pop() ?? target.repo;
	return joinVaultPath(root, repoName, target.file);
}

/** The vault path of the margin notes for `target`. */
export function notePath(folder: string, target: CodeTarget): string {
	return `${noteBase(folder, target)}.md`;
}

/** Characters that cannot appear in a file name in the vault. */
function safeName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A vault path for a new diagram of `target` (or of `symbol` in it), next
 * to its notes. Never an existing path: `exists` is asked until one is free.
 */
export function diagramPath(folder: string, target: CodeTarget, symbol: string, exists: (path: string) => boolean): string {
	const base = noteBase(folder, target);
	const name = symbol ? `${base} ${safeName(symbol)} diagram` : `${base} diagram`;
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? `${name}.md` : `${name} ${n}.md`;
		if (!exists(candidate)) return candidate;
	}
}

/** Parent folders of a vault path, outermost first. */
export function parentFolders(vaultPath: string): string[] {
	const parts = vaultPath.split('/');
	return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}
