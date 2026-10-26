import { promises as fsp } from 'fs';
import * as path from 'path';

/** Directories never descended into when walking a folder outside git. */
const IGNORED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules']);

/** Hard cap on listed files, so huge folders cannot exhaust memory. */
export const MAX_INDEXED_FILES = 50_000;

/** True when any path segment starts with a dot. */
export function isHiddenPath(rel: string): boolean {
	return rel.split('/').some((seg) => seg.startsWith('.'));
}

/** Walks `folder` breadth-first without following symlinked directories. */
export async function walkFolder(folder: string, limit = MAX_INDEXED_FILES): Promise<{ rels: string[]; truncated: boolean }> {
	const rels: string[] = [];
	const queue: string[] = [''];
	while (queue.length > 0) {
		const relDir = queue.shift() ?? '';
		let entries;
		try {
			entries = await fsp.readdir(path.join(folder, relDir), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) queue.push(rel);
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				if (rels.length >= limit) return { rels, truncated: true };
				rels.push(rel);
			}
		}
	}
	return { rels, truncated: false };
}
