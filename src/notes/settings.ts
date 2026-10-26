import { DEFAULT_MODEL } from '../model/client';
import { DEFAULT_NOTES_FOLDER } from './notePaths';

/** Settings for margin notes. */
export interface CodeNotesSettings {
	/** Vault folder that holds the notes, one per code file. */
	folder: string;
	/** The Code notes panel was added to the right sidebar once. */
	panelAdded: boolean;
}

export type ModelTransport = 'cli' | 'api';

/** Settings for the opt-in model actions. */
export interface ModelSettings {
	/** Off until the user turns it on; nothing is sent anywhere before. */
	enabled: boolean;
	transport: ModelTransport;
	model: string;
	/** How to run Claude Code, e.g. `claude` or a full path. */
	cliCommand: string;
	/**
	 * Name of the API key in Obsidian's secret storage (not the key itself,
	 * which never goes into `data.json`).
	 */
	apiKeySecret: string;
}

export const DEFAULT_CODE_NOTES_SETTINGS: CodeNotesSettings = { folder: DEFAULT_NOTES_FOLDER, panelAdded: false };

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
	enabled: false,
	transport: 'cli',
	model: DEFAULT_MODEL,
	cliCommand: 'claude',
	apiKeySecret: '',
};

function record(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function text(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function sanitizeCodeNotesSettings(raw: unknown): CodeNotesSettings {
	const data = record(raw);
	const folder = text(data.folder, DEFAULT_NOTES_FOLDER).replace(/^\/+|\/+$/g, '');
	return { folder: folder || DEFAULT_NOTES_FOLDER, panelAdded: data.panelAdded === true };
}

export function sanitizeModelSettings(raw: unknown): ModelSettings {
	const data = record(raw);
	return {
		enabled: data.enabled === true,
		transport: data.transport === 'api' ? 'api' : 'cli',
		model: text(data.model, DEFAULT_MODEL),
		cliCommand: text(data.cliCommand, DEFAULT_MODEL_SETTINGS.cliCommand),
		// Secret names are lowercase letters, digits and dashes.
		apiKeySecret: typeof data.apiKeySecret === 'string' && /^[a-z0-9-]*$/.test(data.apiKeySecret) ? data.apiKeySecret : '',
	};
}
