import * as path from 'path';

export const posix = path.posix;

/** The folder of a repository-relative path, '' at the root. */
export function dirOf(p: string): string {
	const d = posix.dirname(p);
	return d === '.' ? '' : d;
}

/** Joins repository-relative parts; null when the result leaves the repository. */
export function join(...parts: string[]): string | null {
	const joined = posix.normalize(parts.filter(Boolean).join('/'));
	if (joined === '.' || joined === '') return '';
	if (joined.startsWith('../') || joined === '..' || joined.startsWith('/')) return null;
	return joined.replace(/\/$/, '');
}

/** Parses JSON with comments and trailing commas, as tsconfig files allow. Null when invalid. */
export function parseJsonc(text: string): unknown {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
		} else if (c === '/' && text[i + 1] === '*') {
			const close = text.indexOf('*/', i + 2);
			i = close < 0 ? text.length : close + 2;
		} else if (c === ',') {
			const rest = text.slice(i + 1).match(/^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/)?.[0].length ?? 0;
			const next = text[i + 1 + rest];
			if (next !== '}' && next !== ']') out += c;
			i++;
		} else {
			out += c;
			i++;
		}
	}
	try {
		return JSON.parse(out);
	} catch {
		return null;
	}
}

export interface TsConfig {
	/** Folder non-relative imports are also looked up in. */
	baseUrl: string | null;
	paths: {
		/** Folder that `paths` targets are relative to. */
		base: string;
		paths: [string, string[]][];
	} | null;
}

/** The tsconfig.json and jsconfig.json files of a repository, read on demand. */
export class TsConfigs {
	private cache = new Map<string, TsConfig | null>();

	/** `configs`: text of config files by repository-relative path. */
	constructor(private configs: ReadonlyMap<string, string>) {}

	/** The nearest tsconfig.json or jsconfig.json above `file`, with `extends` applied. */
	configFor(file: string): TsConfig | null {
		for (let d = dirOf(file); ; d = dirOf(d)) {
			for (const name of ['tsconfig.json', 'jsconfig.json']) {
				const p = join(d, name);
				if (p === null || !this.configs.has(p)) continue;
				if (!this.cache.has(p)) this.cache.set(p, this.load(p, new Set()));
				return this.cache.get(p) ?? null;
			}
			if (!d) return null;
		}
	}

	private load(file: string, seen: Set<string>): TsConfig | null {
		if (seen.has(file)) return null;
		seen.add(file);
		const raw = parseJsonc(this.configs.get(file) ?? '');
		let config: TsConfig = { baseUrl: null, paths: null };
		if (raw && typeof raw === 'object') {
			const data = raw as { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
			const parents = (Array.isArray(data.extends) ? data.extends : [data.extends]).filter((e): e is string => typeof e === 'string');
			for (const parent of parents) {
				if (!parent.startsWith('.')) continue; // a package's config: not in this repository
				const target = join(dirOf(file), parent.endsWith('.json') ? parent : `${parent}.json`);
				const inherited = target ? this.load(target, seen) : null;
				if (inherited) config = { baseUrl: inherited.baseUrl ?? config.baseUrl, paths: inherited.paths ?? config.paths };
			}
			const options = data.compilerOptions ?? {};
			const baseUrl = typeof options.baseUrl === 'string' ? join(dirOf(file), options.baseUrl) : null;
			if (baseUrl !== null) config.baseUrl = baseUrl;
			if (options.paths && typeof options.paths === 'object') {
				const entries = Object.entries(options.paths as Record<string, unknown>)
					.map(([k, v]): [string, string[]] => [k, Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []]);
				config.paths = { base: baseUrl ?? config.baseUrl ?? dirOf(file), paths: entries };
			}
		}
		return config;
	}
}

/** The part of `spec` matched by the `*` in a tsconfig `paths` pattern, '' for an exact match, or null. */
export function matchPattern(pattern: string, spec: string): string | null {
	const star = pattern.indexOf('*');
	if (star < 0) return pattern === spec ? '' : null;
	const prefix = pattern.slice(0, star);
	const suffix = pattern.slice(star + 1);
	if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) return null;
	return spec.slice(prefix.length, spec.length - suffix.length);
}
