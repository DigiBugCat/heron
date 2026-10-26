import type { NotesVault } from '../src/services/CodeNotesStore';

/** A vault in a map, like Obsidian's but synchronous underneath. */
export function memoryVault(files: Map<string, string> = new Map()): NotesVault & { files: Map<string, string> } {
	return {
		files,
		read: (path) => Promise.resolve(files.get(path) ?? null),
		create: (path, text) => {
			if (files.has(path)) return Promise.reject(new Error('File already exists.'));
			files.set(path, text);
			return Promise.resolve();
		},
		process: (path, fn) => {
			const text = files.get(path);
			if (text === undefined) return Promise.reject(new Error('missing'));
			files.set(path, fn(text));
			return Promise.resolve();
		},
		exists: (path) => files.has(path),
	};
}
