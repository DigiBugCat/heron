import { fileURLToPath } from 'url';

/** A zero-based line and UTF-16 column. */
export interface Position {
	line: number;
	character: number;
}

interface Range {
	start: Position;
	end: Position;
}

/** A place in a file on disk. */
export interface FileLocation {
	absPath: string;
	position: Position;
}

/** A named symbol and where it is defined. */
export interface SymbolEntry extends FileLocation {
	name: string;
	kind: string;
	/** Enclosing symbols, outermost first, e.g. `Server › start`. */
	container: string;
}

interface LspLocation { uri: string; range: Range }
interface LspLocationLink { targetUri: string; targetRange: Range; targetSelectionRange?: Range }
interface LspDocumentSymbol { name: string; kind: number; range: Range; selectionRange?: Range; children?: LspDocumentSymbol[] }
interface LspSymbolInformation { name: string; kind: number; location: { uri: string; range?: Range }; containerName?: string }

const ORIGIN: Position = { line: 0, character: 0 };

/** Names for LSP `SymbolKind` values (1-based). */
const SYMBOL_KINDS = [
	'', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor',
	'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array',
	'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter',
];

export function symbolKindName(kind: number): string {
	return SYMBOL_KINDS[kind] || 'symbol';
}

/** The path of a `file:` URI, or null for other schemes (e.g. virtual documents). */
export function pathOfUri(uri: string): string | null {
	if (!uri.startsWith('file:')) return null;
	try {
		return fileURLToPath(uri);
	} catch {
		return null;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object';
}

/**
 * Normalizes a definition-style response (`Location`, `Location[]` or
 * `LocationLink[]`, possibly null) to file locations, dropping duplicates
 * and non-file URIs.
 */
export function toFileLocations(response: unknown): FileLocation[] {
	const items = Array.isArray(response) ? response : response ? [response] : [];
	const seen = new Set<string>();
	const result: FileLocation[] = [];
	for (const item of items) {
		if (!isObject(item)) continue;
		let uri: string;
		let range: Range;
		if (typeof item.targetUri === 'string') {
			const link = item as unknown as LspLocationLink;
			uri = link.targetUri;
			range = link.targetSelectionRange ?? link.targetRange;
		} else if (typeof item.uri === 'string' && isObject(item.range)) {
			const loc = item as unknown as LspLocation;
			uri = loc.uri;
			range = loc.range;
		} else {
			continue;
		}
		const absPath = pathOfUri(uri);
		if (!absPath) continue;
		const key = `${absPath}:${range.start.line}:${range.start.character}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push({ absPath, position: range.start });
	}
	return result;
}

/**
 * Flattens a `textDocument/documentSymbol` response, either hierarchical
 * `DocumentSymbol`s or flat `SymbolInformation`s, in document order.
 */
export function flattenDocumentSymbols(response: unknown, absPath: string): SymbolEntry[] {
	if (!Array.isArray(response)) return [];
	const result: SymbolEntry[] = [];
	const visit = (symbols: unknown[], container: string[]) => {
		for (const raw of symbols) {
			if (!isObject(raw) || typeof raw.name !== 'string') continue;
			if (isObject(raw.location)) {
				const info = raw as unknown as LspSymbolInformation;
				result.push({
					absPath,
					position: info.location.range?.start ?? ORIGIN,
					name: info.name,
					kind: symbolKindName(info.kind),
					container: info.containerName ?? '',
				});
				continue;
			}
			const sym = raw as unknown as LspDocumentSymbol;
			result.push({
				absPath,
				position: (sym.selectionRange ?? sym.range).start,
				name: sym.name,
				kind: symbolKindName(sym.kind),
				container: container.join(' › '),
			});
			if (Array.isArray(sym.children)) visit(sym.children, [...container, sym.name]);
		}
	};
	visit(response, []);
	result.sort((a, b) => a.position.line - b.position.line || a.position.character - b.position.character);
	return result;
}

/** Converts a `workspace/symbol` response to entries, dropping non-file results. */
export function workspaceSymbols(response: unknown, limit: number): SymbolEntry[] {
	if (!Array.isArray(response)) return [];
	const result: SymbolEntry[] = [];
	for (const raw of response) {
		if (result.length >= limit) break;
		if (!isObject(raw) || typeof raw.name !== 'string' || !isObject(raw.location)) continue;
		const info = raw as unknown as LspSymbolInformation;
		const absPath = pathOfUri(info.location.uri);
		if (!absPath) continue;
		result.push({
			absPath,
			position: info.location.range?.start ?? ORIGIN,
			name: info.name,
			kind: symbolKindName(info.kind),
			container: info.containerName ?? '',
		});
	}
	return result;
}
