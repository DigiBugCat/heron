import type { ImportRef } from './imports';
import type { MapLanguage } from './mask';
import { dirOf, join, matchPattern, posix, TsConfigs } from './tsconfig';

export { parseJsonc } from './tsconfig';

/** Where an import leads: files in the repository, an outside package, or nowhere known. */
export type Resolution =
	| { kind: 'files'; paths: string[] }
	| { kind: 'external'; name: string }
	| { kind: 'unresolved' };

const UNRESOLVED: Resolution = { kind: 'unresolved' };
const TS_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/** `./x.js` in TypeScript ESM code usually means `./x.ts`. */
const JS_TO_TS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

interface Crate {
	dir: string;
	srcDir: string;
	root: string | null;
}

/**
 * Resolves imports to files of one repository (or folder), given the paths
 * of all its files and the text of its config files (`tsconfig.json`,
 * `jsconfig.json`, `go.mod`, `Cargo.toml`). Paths are relative to the
 * repository root and `/`-separated.
 */
export class ImportResolver {
	private files: Set<string>;
	private dirs = new Set<string>();
	private goFilesByDir = new Map<string, string[]>();
	private goModules: { dir: string; module: string }[] = [];
	private crates: Crate[] = [];
	private crateByName = new Map<string, Crate>();
	private tsConfigs: TsConfigs;

	constructor(files: Iterable<string>, configs: ReadonlyMap<string, string>) {
		this.files = new Set(files);
		this.tsConfigs = new TsConfigs(configs);
		for (const file of this.files) {
			for (let d = dirOf(file); d; d = dirOf(d)) {
				if (this.dirs.has(d)) break;
				this.dirs.add(d);
			}
			if (file.endsWith('.go') && !file.endsWith('_test.go')) {
				const list = this.goFilesByDir.get(dirOf(file)) ?? [];
				list.push(file);
				this.goFilesByDir.set(dirOf(file), list);
			}
		}
		for (const list of this.goFilesByDir.values()) list.sort();
		for (const [file, text] of configs) {
			const name = posix.basename(file);
			if (name === 'go.mod') {
				const module = /^\s*module\s+"?([^\s"]+)"?/m.exec(text)?.[1];
				if (module) this.goModules.push({ dir: dirOf(file), module });
			} else if (name === 'Cargo.toml') {
				const dir = dirOf(file);
				const srcDir = join(dir, 'src') ?? 'src';
				const root = [join(srcDir, 'lib.rs'), join(srcDir, 'main.rs')].find((p) => p !== null && this.files.has(p)) ?? null;
				const crate: Crate = { dir, srcDir, root };
				this.crates.push(crate);
				const pkg = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(text)?.[1];
				if (pkg) this.crateByName.set(pkg.replace(/-/g, '_'), crate);
			}
		}
		this.goModules.sort((a, b) => b.module.length - a.module.length);
		this.crates.sort((a, b) => b.dir.length - a.dir.length);
	}

	/** Resolves one import of the file `from`. */
	resolve(from: string, ref: ImportRef, lang: MapLanguage): Resolution {
		switch (lang) {
			case 'ts': return this.resolveTs(from, ref.spec);
			case 'python': return this.resolvePython(from, ref);
			case 'go': return this.resolveGo(ref.spec);
			case 'rust': return this.resolveRust(from, ref);
		}
	}

	private has(p: string | null): boolean {
		return p !== null && this.files.has(p);
	}

	// TypeScript and JavaScript

	private resolveTs(from: string, spec: string): Resolution {
		if (spec.startsWith('.')) {
			const file = this.tsFile(join(dirOf(from), spec));
			return file ? { kind: 'files', paths: [file] } : UNRESOLVED;
		}
		if (spec.startsWith('/')) return UNRESOLVED;
		const config = this.tsConfigs.configFor(from);
		if (config?.paths) {
			const matches = config.paths.paths
				.map(([pattern, targets]) => ({ pattern, targets, star: matchPattern(pattern, spec) }))
				.filter((m) => m.star !== null)
				.sort((a, b) => b.pattern.indexOf('*') - a.pattern.indexOf('*') || b.pattern.length - a.pattern.length);
			for (const m of matches) {
				for (const target of m.targets) {
					const file = this.tsFile(join(config.paths.base, target.replace('*', m.star ?? '')));
					if (file) return { kind: 'files', paths: [file] };
				}
			}
		}
		if (config?.baseUrl !== null && config?.baseUrl !== undefined) {
			const file = this.tsFile(join(config.baseUrl, spec));
			if (file) return { kind: 'files', paths: [file] };
		}
		const bare = spec.replace(/^node:/, '');
		const parts = bare.split('/');
		const name = bare.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
		return name ? { kind: 'external', name } : UNRESOLVED;
	}

	private tsFile(base: string | null): string | null {
		if (base === null) return null;
		if (this.has(base)) return base;
		const ext = posix.extname(base);
		for (const swap of JS_TO_TS[ext] ?? []) {
			const p = base.slice(0, -ext.length) + swap;
			if (this.has(p)) return p;
		}
		for (const e of TS_EXTENSIONS) if (this.has(base + e)) return base + e;
		for (const e of TS_EXTENSIONS) {
			const p = join(base, `index${e}`);
			if (this.has(p)) return p;
		}
		return null;
	}

	// Python

	private resolvePython(from: string, ref: ImportRef): Resolution {
		const level = ref.level ?? 0;
		const names = (ref.names ?? []).filter((n) => n !== '*');
		const segments = ref.spec ? ref.spec.split('.') : [];
		if (level > 0) {
			let base: string | null = dirOf(from);
			for (let k = 1; k < level && base !== null; k++) base = base ? dirOf(base) : null;
			if (base === null) return UNRESOLVED;
			const found = this.pythonTarget(join(base, ...segments), names);
			return found.length ? { kind: 'files', paths: found } : UNRESOLVED;
		}
		for (const root of this.pythonRoots(from)) {
			// The longest prefix of the dotted name that is a module, so `a.b.C` finds `a/b.py`.
			for (let k = segments.length; k > 0; k--) {
				const found = this.pythonTarget(join(root, ...segments.slice(0, k)), k === segments.length ? names : []);
				if (found.length) return { kind: 'files', paths: found };
			}
		}
		const top = segments[0];
		if (!top) return UNRESOLVED;
		const local = this.pythonRoots(from).some((root) => {
			const p = join(root, top);
			return p !== null && (this.dirs.has(p) || this.has(`${p}.py`));
		});
		return local ? UNRESOLVED : { kind: 'external', name: top };
	}

	/** Submodules named by a from-import, or else the module (or package) itself. */
	private pythonTarget(modulePath: string | null, names: string[]): string[] {
		if (modulePath === null) return [];
		const subs = names.map((n) => this.pythonModule(join(modulePath, n))).filter((p): p is string => p !== null);
		if (subs.length === names.length && subs.length > 0) return [...new Set(subs)];
		const self = this.pythonModule(modulePath);
		return [...new Set([...subs, ...(self ? [self] : [])])];
	}

	private pythonModule(p: string | null): string | null {
		if (p === null || p === '') return this.has('__init__.py') ? '__init__.py' : null;
		for (const candidate of [`${p}.py`, `${p}.pyi`, `${p}/__init__.py`, `${p}/__init__.pyi`]) {
			if (this.has(candidate)) return candidate;
		}
		return null;
	}

	/**
	 * Folders absolute imports are looked up from: the folder above the
	 * file's top package (found through `__init__.py`), the file's own
	 * folder (scripts), the repository root and `src/`.
	 */
	private pythonRoots(from: string): string[] {
		let top = dirOf(from);
		let above = top;
		while (top && this.has(join(top, '__init__.py'))) {
			above = dirOf(top);
			top = above;
		}
		const roots = [above, dirOf(from), '', ...(this.dirs.has('src') ? ['src'] : [])];
		return [...new Set(roots)];
	}

	// Go

	private resolveGo(spec: string): Resolution {
		const mod = this.goModules.find((m) => spec === m.module || spec.startsWith(`${m.module}/`));
		if (!mod) return spec ? { kind: 'external', name: spec } : UNRESOLVED;
		const dir = join(mod.dir, spec.slice(mod.module.length + 1));
		const files = dir === null ? undefined : this.goFilesByDir.get(dir);
		return files?.length ? { kind: 'files', paths: [...files] } : UNRESOLVED;
	}

	// Rust

	private crateOf(file: string): Crate | null {
		return this.crates.find((c) => !c.dir || file.startsWith(`${c.dir}/`)) ?? null;
	}

	/** The folder holding the files of a file's child modules. */
	private childDir(file: string, crate: Crate | null): string {
		const base = posix.basename(file);
		if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs' || file === crate?.root) return dirOf(file);
		return join(dirOf(file), posix.basename(file, '.rs')) ?? '';
	}

	private childModule(file: string, name: string, crate: Crate | null): string | null {
		const dir = this.childDir(file, crate);
		for (const candidate of [join(dir, `${name}.rs`), join(dir, name, 'mod.rs')]) {
			if (this.has(candidate)) return candidate;
		}
		return null;
	}

	private parentModule(file: string, crate: Crate | null): string | null {
		if (!crate || file === crate.root) return null;
		const moduleDir = posix.basename(file) === 'mod.rs' ? dirOf(dirOf(file)) : dirOf(file);
		if (moduleDir === crate.srcDir) return crate.root;
		const candidates = [`${moduleDir}.rs`, join(moduleDir, 'mod.rs')];
		return candidates.find((c) => this.has(c)) ?? null;
	}

	private resolveRust(from: string, ref: ImportRef): Resolution {
		const crate = this.crateOf(from);
		if (ref.mod) {
			const file = this.childModule(from, ref.spec, crate);
			return file ? { kind: 'files', paths: [file] } : UNRESOLVED;
		}
		const segs = ref.spec.split('::').filter(Boolean);
		const first = segs[0];
		if (!first) return UNRESOLVED;
		let file: string | null;
		let rest: string[];
		if (first === 'crate') {
			file = crate?.root ?? null;
			rest = segs.slice(1);
		} else if (first === 'self' || first === 'super') {
			file = from;
			rest = segs;
			while (rest[0] === 'self' || rest[0] === 'super') {
				if (rest[0] === 'super') file = file ? this.parentModule(file, crate) : null;
				rest = rest.slice(1);
			}
		} else if (this.crateByName.has(first)) {
			file = this.crateByName.get(first)?.root ?? null;
			rest = segs.slice(1);
		} else if (this.childModule(from, first, crate)) {
			file = from;
			rest = segs;
		} else if (crate?.root && this.childModule(crate.root, first, crate)) {
			file = crate.root;
			rest = segs;
		} else if (/^[A-Z]/.test(first)) {
			return UNRESOLVED; // an item in scope, such as an enum's variants; crates are lower case
		} else {
			return { kind: 'external', name: first };
		}
		if (!file) return UNRESOLVED;
		for (const seg of rest) {
			const child = this.childModule(file, seg, crate);
			if (!child) break;
			file = child;
		}
		return { kind: 'files', paths: [file] };
	}
}
