import { App, TFile, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import type { LineRange, SourceLocation } from '../../links/sourceLink';
import type { Position } from '../../lsp/locations';
import { normalizeFolderInput } from '../../utils/paths';

export const CODE_VIEW_TYPE = 'heron-code';
export const EXTERNAL_CODE_VIEW_TYPE = 'heron-external-code';

/** Where a code tab puts the cursor, or which lines it highlights, when it opens. */
export interface CodeTarget {
	cursor?: Position | null;
	/** 1-based, inclusive; highlighted, selected and scrolled to. */
	lines?: LineRange | null;
}

/**
 * Ephemeral state for a code tab. `line` (zero-based) is what Obsidian's
 * own views read, so a vault file Heron does not show still opens there.
 */
export function eStateFor(target: CodeTarget): Record<string, unknown> {
	const state: Record<string, unknown> = {};
	if (target.cursor) state.heronCursor = target.cursor;
	if (target.lines) {
		state.heronLines = target.lines;
		state.line = target.lines.from - 1;
	}
	return state;
}

/** Reads a target back from ephemeral state; `line` alone (from Obsidian's search) places the cursor. */
export function targetFrom(state: unknown): CodeTarget | null {
	if (!state || typeof state !== 'object') return null;
	const s = state as { heronCursor?: Partial<Position>; heronLines?: Partial<LineRange>; line?: unknown };
	const lines = s.heronLines;
	if (lines && typeof lines.from === 'number' && typeof lines.to === 'number') return { lines: { from: lines.from, to: lines.to } };
	const cursor = s.heronCursor;
	if (cursor && typeof cursor.line === 'number') return { cursor: { line: cursor.line, character: cursor.character ?? 0 } };
	if (typeof s.line === 'number') return { cursor: { line: s.line, character: 0 } };
	return null;
}

/** The vault file at `absPath`, or null outside the vault or for files Obsidian does not list (e.g. in hidden folders). */
export function vaultFileAt(app: App, base: string, absPath: string): TFile | null {
	if (!base) return null;
	const rel = path.relative(base, absPath);
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
	const file = app.vault.getAbstractFileByPath(rel.split(path.sep).join('/'));
	return file instanceof TFile ? file : null;
}

/**
 * Shows `absPath` in `leaf`: a vault file through Obsidian, so it opens in
 * whatever view handles it and joins the tab's history; anything else in
 * an external code tab.
 */
export async function openCodeFile(app: App, base: string, leaf: WorkspaceLeaf, absPath: string, target: CodeTarget = {}): Promise<void> {
	const eState = eStateFor(target);
	const file = vaultFileAt(app, base, absPath);
	if (file) await leaf.openFile(file, { eState });
	else await leaf.setViewState({ type: EXTERNAL_CODE_VIEW_TYPE, state: { absPath }, active: true }, eState);
}

/** The file a link or embed points at, as an absolute path. */
export function locationPath(loc: SourceLocation): string {
	return path.resolve(normalizeFolderInput(loc.folder), loc.file);
}

/** Opens a link's or embed's file at its lines, in a new tab when `newTab`. */
export async function openSourceLocation(app: App, base: string, loc: SourceLocation, newTab: boolean): Promise<void> {
	await openCodeFile(app, base, app.workspace.getLeaf(newTab ? 'tab' : false), locationPath(loc), { lines: loc.lines });
}
