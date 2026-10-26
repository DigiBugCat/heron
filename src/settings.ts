import { BUILTIN_SERVERS } from './lsp/servers';
import {
	CodeNotesSettings, DEFAULT_CODE_NOTES_SETTINGS, DEFAULT_MODEL_SETTINGS, ModelSettings,
	sanitizeCodeNotesSettings, sanitizeModelSettings,
} from './notes/settings';

/** Whether code tabs open read-only or editable. */
export type CodeMode = 'read' | 'edit';

/** How diffs are laid out: one interleaved column, or old and new side by side. */
export type DiffLayout = 'unified' | 'split';

/** Persisted plugin settings stored in `data.json`. */
export interface HeronSettings {
	fontSize: number;
	diffLayout: DiffLayout;
	/** Wrap long lines in the viewer instead of scrolling sideways. */
	wordWrap: boolean;
	/** Repositories whose Changes show changes against a base branch, by common git dir. */
	baseCompareRepos: string[];
	/** Base branch chosen per repository, keyed by its common git dir. */
	baseBranches: Record<string, string>;
	/** Start language servers for go to definition, hover and references. */
	languageServers: boolean;
	/**
	 * Command lines that replace a built-in server's default, by server ID.
	 * An empty string turns that server off.
	 */
	serverCommands: Record<string, string>;
	/** The Code outline and Code changes panels were added to the right sidebar once. */
	sidebarPanelsAdded: boolean;
	/** How code files open: for reading, or ready to edit. */
	codeMode: CodeMode;
	/** Record a local history of changes to files in the vault's repositories. */
	rewind: boolean;
	/** Rewind history older than this many days is pruned. */
	rewindMaxAgeDays: number;
	/** Rewind history is pruned to fit in this many megabytes. */
	rewindMaxSizeMb: number;
	/** The Rewind panel was added to the right sidebar once. */
	rewindPanelAdded: boolean;
	/** Vault folder that code maps and call graphs are saved in. */
	codeMapFolder: string;
	/** Margin notes on code. */
	codeNotes: CodeNotesSettings;
	/** The opt-in model actions (explain, find similar, diagram). */
	model: ModelSettings;
}

export const DEFAULT_SETTINGS: HeronSettings = {
	fontSize: 13,
	diffLayout: 'unified',
	wordWrap: false,
	baseCompareRepos: [],
	baseBranches: {},
	languageServers: true,
	serverCommands: {},
	sidebarPanelsAdded: false,
	codeMode: 'read',
	rewind: true,
	rewindMaxAgeDays: 14,
	rewindMaxSizeMb: 200,
	rewindPanelAdded: false,
	codeMapFolder: 'Code maps',
	codeNotes: DEFAULT_CODE_NOTES_SETTINGS,
	model: DEFAULT_MODEL_SETTINGS,
};

export const FONT_SIZE_RANGE = { min: 10, max: 20 } as const;
export const REWIND_AGE_RANGE = { min: 1, max: 365 } as const;
export const REWIND_SIZE_RANGE = { min: 10, max: 10000 } as const;
/** Repositories whose base mode and base branch are remembered. */
export const MAX_BASE_BRANCHES = 50;

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * Builds valid settings from whatever was stored on disk, falling back to
 * defaults for missing or malformed values.
 */
export function sanitizeSettings(raw: unknown): HeronSettings {
	const data = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof HeronSettings, unknown>>;
	const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

	return {
		fontSize: clamp(Math.round(num(data.fontSize, DEFAULT_SETTINGS.fontSize)), FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max),
		diffLayout: data.diffLayout === 'split' ? 'split' : 'unified',
		wordWrap: data.wordWrap === true,
		baseCompareRepos: sanitizeBaseCompareRepos(data.baseCompareRepos),
		baseBranches: sanitizeBaseBranches(data.baseBranches),
		languageServers: typeof data.languageServers === 'boolean' ? data.languageServers : DEFAULT_SETTINGS.languageServers,
		serverCommands: sanitizeServerCommands(data.serverCommands),
		sidebarPanelsAdded: data.sidebarPanelsAdded === true,
		codeMode: data.codeMode === 'edit' ? 'edit' : 'read',
		rewind: typeof data.rewind === 'boolean' ? data.rewind : DEFAULT_SETTINGS.rewind,
		rewindMaxAgeDays: clamp(Math.round(num(data.rewindMaxAgeDays, DEFAULT_SETTINGS.rewindMaxAgeDays)), REWIND_AGE_RANGE.min, REWIND_AGE_RANGE.max),
		rewindMaxSizeMb: clamp(Math.round(num(data.rewindMaxSizeMb, DEFAULT_SETTINGS.rewindMaxSizeMb)), REWIND_SIZE_RANGE.min, REWIND_SIZE_RANGE.max),
		rewindPanelAdded: data.rewindPanelAdded === true,
		codeMapFolder: sanitizeVaultFolder(data.codeMapFolder, DEFAULT_SETTINGS.codeMapFolder),
		codeNotes: sanitizeCodeNotesSettings(data.codeNotes),
		model: sanitizeModelSettings(data.model),
	};
}

/** A vault folder path without leading or trailing slashes, or `fallback` when empty or invalid. */
export function sanitizeVaultFolder(raw: unknown, fallback: string): string {
	if (typeof raw !== 'string') return fallback;
	const cleaned = raw.split('/').map((part) => part.trim()).filter((part) => part && part !== '.' && part !== '..').join('/');
	return cleaned || fallback;
}

function sanitizeServerCommands(raw: unknown): Record<string, string> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const known = new Set(BUILTIN_SERVERS.map((s) => s.id));
	const entries = Object.entries(raw as Record<string, unknown>)
		.filter((e): e is [string, string] => known.has(e[0]) && typeof e[1] === 'string')
		.map(([id, command]): [string, string] => [id, command.trim()]);
	return Object.fromEntries(entries);
}

function sanitizeBaseBranches(raw: unknown): Record<string, string> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const entries = Object.entries(raw as Record<string, unknown>)
		.filter((e): e is [string, string] => typeof e[1] === 'string' && e[0].length > 0 && e[1].length > 0);
	return Object.fromEntries(entries.slice(-MAX_BASE_BRANCHES));
}

function sanitizeBaseCompareRepos(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const keys = raw.filter((k): k is string => typeof k === 'string' && k.length > 0);
	return [...new Set(keys)].slice(-MAX_BASE_BRANCHES);
}

/** Records `branch` as the base for the repository `key`, keeping the map bounded. */
export function setBaseBranch(map: Record<string, string>, key: string, branch: string): Record<string, string> {
	const entries: [string, string][] = [...Object.entries(map).filter(([k]) => k !== key), [key, branch]];
	return Object.fromEntries(entries.slice(-MAX_BASE_BRANCHES));
}

/** Turns base mode on or off for the repository `key`, keeping the list bounded. */
export function setBaseCompare(repos: string[], key: string, on: boolean): string[] {
	const rest = repos.filter((k) => k !== key);
	return (on ? [...rest, key] : rest).slice(-MAX_BASE_BRANCHES);
}
