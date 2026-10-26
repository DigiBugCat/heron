import type { MapLanguage } from './mask';

/** Most symbols kept per file. */
export const MAX_OUTLINE_SYMBOLS = 8;

interface Found {
	name: string;
	/** Exported or public. */
	visible: boolean;
}

const TS_DECL = /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|type|enum|function\*?|const|let|var|namespace)\s+([\w$]+)/gm;
const PY_DECL = /^(?:async[ \t]+)?(?:def|class)[ \t]+([A-Za-z_]\w*)/gm;
const GO_FUNC = /^func[ \t]+(?:\([^)]*?\*?[ \t]*([A-Za-z_]\w*)(?:\[[^\]]*\])?[ \t]*\)[ \t]*)?([A-Za-z_]\w*)/gm;
const GO_TYPE = /^type[ \t]+([A-Za-z_]\w*)/gm;
const RUST_DECL = /^(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?(fn|struct|enum|trait|type|union|const|static|macro_rules!)\s*([A-Za-z_]\w*)/gm;

function scan(masked: string, lang: MapLanguage): Found[] {
	const found: Found[] = [];
	switch (lang) {
		case 'ts':
			for (const [, exported = '', keyword = '', name = ''] of masked.matchAll(TS_DECL)) {
				// Unexported variables are usually helpers; keep declarations that shape the file.
				if (!exported && ['const', 'let', 'var'].includes(keyword)) continue;
				found.push({ name, visible: !!exported });
			}
			break;
		case 'python':
			for (const [, name = ''] of masked.matchAll(PY_DECL)) found.push({ name, visible: !name.startsWith('_') });
			break;
		case 'go': {
			const hits: { at: number; found: Found }[] = [];
			for (const m of masked.matchAll(GO_FUNC)) {
				const [, receiver = '', name = ''] = m;
				hits.push({ at: m.index ?? 0, found: { name: receiver ? `${receiver}.${name}` : name, visible: /^[A-Z]/.test(name) } });
			}
			for (const m of masked.matchAll(GO_TYPE)) {
				const name = m[1] ?? '';
				hits.push({ at: m.index ?? 0, found: { name, visible: /^[A-Z]/.test(name) } });
			}
			hits.sort((a, b) => a.at - b.at);
			found.push(...hits.map((h) => h.found));
			break;
		}
		case 'rust':
			for (const [, pub = '', , name = ''] of masked.matchAll(RUST_DECL)) found.push({ name, visible: !!pub });
			break;
	}
	return found;
}

/**
 * Top-level symbols of a file, from a quick scan of declarations that start
 * a line (`masked` is the output of `maskSource`). When some are exported or
 * public, only those are listed. Source order, without duplicates.
 */
export function outlineSymbols(masked: string, lang: MapLanguage, limit = MAX_OUTLINE_SYMBOLS): string[] {
	const found = scan(masked, lang);
	const visible = found.filter((f) => f.visible);
	const names = (visible.length ? visible : found).map((f) => f.name);
	return [...new Set(names)].slice(0, limit);
}
