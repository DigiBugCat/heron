import type { FileLocation, OutlineNode } from '../lsp/locations';
import type { ServerAccess } from '../lsp/requests';
import { ModelCancelled, ModelClient } from '../model/client';
import type { TextPosition } from '../utils/textPositions';

/** What the model actions work on, and the helpers they share. */

/** The code an action works on, and ways to learn more about it. */
export interface ActionSource {
	absPath: string;
	/** The file's current text, including unsaved edits. */
	text: string;
	/** Code fence language for the file, e.g. `ts`. */
	language: string;
	/** Short name for a file, e.g. `heron/src/main.ts`. */
	label(absPath: string): string;
	/** The file's symbols, or null without a language server. */
	outline(): Promise<OutlineNode[] | null>;
	/** The file's language server, or null. */
	server(): Promise<ServerAccess | null>;
	/** The lines of a file, or null when it cannot be read. */
	readLines(absPath: string): Promise<string[] | null>;
	/** Lines in the project containing `word` as a whole word (zero-based lines). */
	grep(word: string, limit: number, signal?: AbortSignal): Promise<{ absPath: string; line: number; text: string }[]>;
}

export interface ActionOptions {
	model: ModelClient;
	signal?: AbortSignal;
	/** Reports what the action is doing, for a status line. */
	progress?(message: string): void;
}

/** A selected range of the source's text, as offsets. */
export interface TextRange {
	from: number;
	to: number;
}

/** Longest wait for one language server request. */
const REQUEST_TIMEOUT_MS = 8_000;

export const CALLABLE = new Set(['function', 'method', 'constructor']);

export function check(signal?: AbortSignal) {
	if (signal?.aborted) throw new ModelCancelled();
}

/** A language server request that gives up quietly: null on error, timeout or a missing capability. */
export async function ask(server: ServerAccess | null, capability: string, method: string, params: unknown): Promise<unknown> {
	if (!server || !server.supports(capability)) return null;
	let timer: number | undefined;
	try {
		return await Promise.race([
			server.request(method, params),
			new Promise((resolve) => { timer = window.setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS); }),
		]);
	} catch {
		return null;
	} finally {
		window.clearTimeout(timer);
	}
}

/** Reads files once per action: no cache outlives it, so nothing goes stale. */
export function lineReader(source: ActionSource): (absPath: string) => Promise<string[] | null> {
	const read = new Map<string, Promise<string[] | null>>();
	const own = source.text.split('\n');
	return (absPath) => {
		if (absPath === source.absPath) return Promise.resolve(own);
		let lines = read.get(absPath);
		if (!lines) read.set(absPath, (lines = source.readLines(absPath)));
		return lines;
	};
}

export function within(loc: FileLocation, absPath: string, from: TextPosition, to: TextPosition): boolean {
	return loc.absPath === absPath && loc.position.line >= from.line && loc.position.line <= to.line;
}

export const where = (source: ActionSource, loc: FileLocation) => `${source.label(loc.absPath)}:${loc.position.line + 1}`;
