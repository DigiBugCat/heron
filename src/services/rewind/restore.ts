import type { HistoryStore } from './HistoryStore';
import { fileInMoment, Moment, MomentFile } from './moments';
import type { Recorder } from './Recorder';

/** Which side of a moment to go back to. */
export type RestoreSide = 'before' | 'after';

export type RestoreOp =
	| { kind: 'write'; path: string; hash: string }
	| { kind: 'delete'; path: string }
	| { kind: 'move'; from: string; to: string };

/** Groups of Heron's restores start with this, so they can be told apart. */
export const RESTORE_GROUP_PREFIX = 'restore:';

/**
 * What it takes to put `file` back the way it was before or after its
 * moment: rename it back, rewrite its content, or delete a file the moment
 * created. Pure.
 */
export function planFileRestore(file: MomentFile, side: RestoreSide): RestoreOp[] {
	if (side === 'after') {
		return file.after === null ? [{ kind: 'delete', path: file.path }] : [{ kind: 'write', path: file.path, hash: file.after }];
	}
	const ops: RestoreOp[] = [];
	const target = file.oldPath ?? file.path;
	if (target !== file.path) ops.push({ kind: 'move', from: file.path, to: target });
	ops.push(file.before === null ? { kind: 'delete', path: target } : { kind: 'write', path: target, hash: file.before });
	return ops;
}

/** Undoing a moment puts every file it changed back to how it was before. */
export function planUndoMoment(moment: Moment): RestoreOp[] {
	return moment.files.flatMap((f) => planFileRestore(f, 'before'));
}

/** Vault paths a plan writes, deletes or moves. */
export function touchedPaths(ops: readonly RestoreOp[]): string[] {
	const paths = ops.flatMap((op) => (op.kind === 'move' ? [op.from, op.to] : [op.path]));
	return [...new Set(paths)];
}

/** True for moments that are Heron's own restores. */
export function isRestoreMoment(m: Moment): boolean {
	return m.changes.some((c) => c.group?.startsWith(RESTORE_GROUP_PREFIX));
}

/**
 * The moment to undo next for `vaultPath`: the most recent one, other than
 * Heron's own restores, that left the file as it is now. Undoing it puts the
 * file back to the moment before, so repeating steps back one moment at a
 * time. `moments` are newest first; `current` is the file's content hash now
 * (null when it does not exist).
 */
export function lastUndoable(moments: readonly Moment[], vaultPath: string, current: string | null): { moment: Moment; file: MomentFile } | null {
	for (const moment of moments) {
		if (isRestoreMoment(moment)) continue;
		const file = fileInMoment(moment, vaultPath);
		if (file && file.path === vaultPath && file.after === current) return { moment, file };
	}
	return null;
}

/** The file operations a restore needs, so tests can use a fake vault. */
export interface RestoreVault {
	exists(vaultPath: string): boolean;
	read(vaultPath: string): Promise<string>;
	/** Creates or overwrites the file (creating folders as needed). */
	write(vaultPath: string, text: string): Promise<void>;
	/** Deletes the file (to the trash, in Obsidian). */
	remove(vaultPath: string): Promise<void>;
	move(from: string, to: string): Promise<void>;
}

export class RestoreError extends Error {}

/**
 * Applies a restore plan through `vault`. Each write is announced to the
 * recorder first, so the restore is itself recorded as one moment (source
 * `heron`, labelled `label`) and can be undone. Fails before changing
 * anything when content it needs is no longer stored. Returns the paths
 * that changed.
 */
export async function applyRestore(
	ops: readonly RestoreOp[],
	deps: { vault: RestoreVault; store: HistoryStore; recorder: Recorder; label: string; group: string },
): Promise<string[]> {
	const { vault, store, recorder } = deps;
	const meta = { label: deps.label, group: deps.group };
	const texts = new Map<string, string>();
	for (const op of ops) {
		if (op.kind !== 'write' || texts.has(op.hash)) continue;
		const text = await store.readText(op.hash);
		if (text === null) throw new RestoreError(`The content of ${op.path} is no longer in the history`);
		texts.set(op.hash, text);
	}
	const changed: string[] = [];
	for (const op of ops) {
		if (op.kind === 'move') {
			if (!vault.exists(op.from) || vault.exists(op.to)) continue;
			recorder.expect(op.to, await vault.read(op.from), meta);
			await vault.move(op.from, op.to);
			changed.push(op.to);
		} else if (op.kind === 'delete') {
			if (!vault.exists(op.path)) continue;
			recorder.expect(op.path, null, meta);
			await vault.remove(op.path);
			changed.push(op.path);
		} else {
			const text = texts.get(op.hash) ?? '';
			if (vault.exists(op.path) && (await vault.read(op.path)) === text) continue;
			recorder.expect(op.path, text, meta);
			await vault.write(op.path, text);
			changed.push(op.path);
		}
	}
	return [...new Set(changed)];
}
