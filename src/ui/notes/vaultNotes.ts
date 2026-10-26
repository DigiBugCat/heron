import { App, normalizePath, TFile, TFolder } from 'obsidian';
import * as path from 'path';
import { GitRepo } from '../../git/GitRepo';
import type { CodeTarget } from '../../notes/notePaths';
import { parentFolders } from '../../notes/notePaths';
import type { NotesVault, NoteOrigin } from '../../services/CodeNotesStore';
import { findRepoRoot } from '../../utils/paths';

/** Obsidian's vault as the notes store sees it. */
export function vaultNotes(app: App): NotesVault {
	const { vault } = app;
	const file = (p: string) => {
		const f = vault.getAbstractFileByPath(normalizePath(p));
		return f instanceof TFile ? f : null;
	};
	return {
		read: async (p) => {
			const f = file(p);
			return f ? vault.read(f) : null;
		},
		create: async (p, text) => {
			await ensureFolders(app, p);
			await vault.create(normalizePath(p), text);
		},
		process: async (p, fn) => {
			const f = file(p);
			if (!f) throw new Error(`${p} no longer exists`);
			await vault.process(f, fn);
		},
		exists: (p) => !!vault.getAbstractFileByPath(normalizePath(p)),
	};
}

/** Creates the folders above vault path `p` that are missing. */
export async function ensureFolders(app: App, p: string) {
	for (const folder of parentFolders(normalizePath(p))) {
		const existing = app.vault.getAbstractFileByPath(folder);
		if (existing instanceof TFolder) continue;
		try {
			await app.vault.createFolder(folder);
		} catch {
			// Created meanwhile, e.g. by another note being saved.
		}
	}
}

/** The vault path of `absPath`, or null outside the vault at `base`. */
export function toVaultPath(base: string, absPath: string): string | null {
	if (!base) return null;
	const rel = path.relative(base, absPath);
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
	return rel.split(path.sep).join('/');
}

/** Where a code file sits: its vault path and the repository inside the vault holding it, if any. */
export async function codeTarget(base: string, absPath: string): Promise<CodeTarget | null> {
	const vaultPath = toVaultPath(base, absPath);
	if (!vaultPath) return null;
	const root = await findRepoRoot(path.dirname(absPath));
	const repo = root ? toVaultPath(base, root) : null;
	if (!root || !repo) return { vaultPath, repo: '', file: vaultPath };
	return { vaultPath, repo, file: path.relative(root, absPath).split(path.sep).join('/') };
}

/** The commit at HEAD of `target`'s repository, and a link from the note file to the code. */
export async function noteOrigin(app: App, base: string, target: CodeTarget, notePath: string): Promise<NoteOrigin> {
	let commit = '';
	if (target.repo) {
		const opened = await GitRepo.open(path.join(base, target.repo));
		if (opened.kind === 'repo') commit = (await opened.repo.head()) ?? '';
	}
	return { commit, codeLink: codeLink(app, target.vaultPath, notePath, target.file) };
}

/** A link to the code file in the user's link format, or a wikilink if Obsidian doesn't know the file. */
export function codeLink(app: App, vaultPath: string, from: string, alias: string): string {
	const f = app.vault.getAbstractFileByPath(vaultPath);
	return f instanceof TFile ? app.fileManager.generateMarkdownLink(f, from, undefined, alias) : `[[${vaultPath}|${alias}]]`;
}
