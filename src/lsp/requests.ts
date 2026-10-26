import { FileLocation, pathOfUri, symbolKindName } from './locations';

/**
 * Raw access to the language server of a file shown in a code tab, for
 * features that build their own requests (the model actions). Pure helpers
 * for the responses live here too.
 */
export interface ServerAccess {
	/** `file:` URI of the shown file, as the server knows it. */
	uri: string;
	/** False only when the server said it lacks `capability` (e.g. `hoverProvider`). */
	supports(capability: string): boolean;
	request(method: string, params: unknown): Promise<unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object';
}

/** The text of a `textDocument/hover` response (MarkupContent, MarkedString or a list of them). */
export function hoverText(response: unknown): string {
	if (!isObject(response)) return '';
	const contents = response.contents;
	const part = (c: unknown): string => {
		if (typeof c === 'string') return c;
		if (isObject(c) && typeof c.value === 'string') {
			return typeof c.language === 'string' ? `\`\`\`${c.language}\n${c.value}\n\`\`\`` : c.value;
		}
		return '';
	};
	const text = Array.isArray(contents) ? contents.map(part).filter(Boolean).join('\n\n') : part(contents);
	return text.trim();
}

/** A function or method in a call hierarchy. */
export interface CallItem extends FileLocation {
	name: string;
	kind: string;
	detail: string;
	/** The item as the server sent it, to pass back in `callHierarchy/*Calls`. */
	raw: unknown;
}

function callItem(raw: unknown): CallItem | null {
	if (!isObject(raw) || typeof raw.name !== 'string' || typeof raw.uri !== 'string') return null;
	const absPath = pathOfUri(raw.uri);
	const range = (isObject(raw.selectionRange) ? raw.selectionRange : raw.range) as { start?: { line: number; character: number } } | undefined;
	if (!absPath || !range?.start) return null;
	return {
		name: raw.name,
		kind: symbolKindName(typeof raw.kind === 'number' ? raw.kind : 0),
		detail: typeof raw.detail === 'string' ? raw.detail : '',
		absPath,
		position: range.start,
		raw,
	};
}

/** Items from `textDocument/prepareCallHierarchy`. */
export function callItems(response: unknown): CallItem[] {
	return Array.isArray(response) ? response.map(callItem).filter((i): i is CallItem => !!i) : [];
}

/** Callers from `callHierarchy/incomingCalls` (`from`) or callees from `outgoingCalls` (`to`). */
export function callTargets(response: unknown, side: 'from' | 'to'): CallItem[] {
	if (!Array.isArray(response)) return [];
	return response.map((call) => (isObject(call) ? callItem(call[side]) : null)).filter((i): i is CallItem => !!i);
}
