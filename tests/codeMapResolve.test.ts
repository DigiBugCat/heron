import { describe, expect, it } from 'vitest';
import { buildGraph, countLines, folderGraph, MAX_FILE_NODES } from '../src/codemap/graph';
import { ImportResolver, parseJsonc } from '../src/codemap/resolve';

function resolver(files: string[], configs: Record<string, string> = {}) {
	return new ImportResolver([...files, ...Object.keys(configs)], new Map(Object.entries(configs)));
}

describe('code map: resolving TypeScript imports', () => {
	const files = [
		'src/main.ts', 'src/util/index.ts', 'src/util/strings.ts', 'src/view.tsx', 'src/esm.ts',
		'src/types.d.ts', 'lib/legacy.js', 'packages/app/src/feature.ts', 'packages/app/src/deep/x.ts', 'packages/lib/index.ts',
	];
	const configs = {
		'tsconfig.json': `{
			// comments and trailing commas are allowed
			"compilerOptions": {
				"baseUrl": ".",
				"paths": { "@/*": ["src/*"], "#legacy": ["lib/legacy.js"], },
			},
		}`,
		'packages/app/tsconfig.json': '{ "extends": "../../tsconfig.json", "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["./src/*"] } } }',
		'packages/lib/tsconfig.json': '{ "extends": "../../tsconfig" }',
	};
	const r = resolver(files, configs);
	const resolve = (from: string, spec: string) => r.resolve(from, { spec }, 'ts');

	it('resolves relative paths with extensions, index files and .js-for-.ts', () => {
		expect(resolve('src/main.ts', './util')).toEqual({ kind: 'files', paths: ['src/util/index.ts'] });
		expect(resolve('src/main.ts', './util/strings')).toEqual({ kind: 'files', paths: ['src/util/strings.ts'] });
		expect(resolve('src/main.ts', './view')).toEqual({ kind: 'files', paths: ['src/view.tsx'] });
		expect(resolve('src/main.ts', './esm.js')).toEqual({ kind: 'files', paths: ['src/esm.ts'] });
		expect(resolve('src/main.ts', './types')).toEqual({ kind: 'files', paths: ['src/types.d.ts'] });
		expect(resolve('src/util/strings.ts', '../../lib/legacy')).toEqual({ kind: 'files', paths: ['lib/legacy.js'] });
		expect(resolve('src/main.ts', './missing')).toEqual({ kind: 'unresolved' });
		expect(resolve('src/main.ts', '../../outside')).toEqual({ kind: 'unresolved' });
	});

	it('resolves tsconfig paths and baseUrl, following extends', () => {
		expect(resolve('src/main.ts', '@/util/strings')).toEqual({ kind: 'files', paths: ['src/util/strings.ts'] });
		expect(resolve('src/main.ts', '#legacy')).toEqual({ kind: 'files', paths: ['lib/legacy.js'] });
		expect(resolve('src/main.ts', 'src/view')).toEqual({ kind: 'files', paths: ['src/view.tsx'] });
		// A nested config with its own paths replaces the root's; one without inherits them.
		expect(resolve('packages/app/src/feature.ts', '~/deep/x')).toEqual({ kind: 'files', paths: ['packages/app/src/deep/x.ts'] });
		expect(resolve('packages/app/src/feature.ts', '@/main')).toEqual({ kind: 'external', name: '@/main' });
		expect(resolve('packages/lib/index.ts', '@/main')).toEqual({ kind: 'files', paths: ['src/main.ts'] });
	});

	it('names outside packages', () => {
		expect(resolve('src/main.ts', 'react')).toEqual({ kind: 'external', name: 'react' });
		expect(resolve('src/main.ts', 'react-dom/client')).toEqual({ kind: 'external', name: 'react-dom' });
		expect(resolve('src/main.ts', '@codemirror/view')).toEqual({ kind: 'external', name: '@codemirror/view' });
		expect(resolve('src/main.ts', 'node:fs')).toEqual({ kind: 'external', name: 'fs' });
	});

	it('parses JSON with comments and trailing commas', () => {
		expect(parseJsonc('{ "a": "// not a comment", /* c */ "b": [1, 2,], }')).toEqual({ a: '// not a comment', b: [1, 2] });
		expect(parseJsonc('{ broken')).toBeNull();
	});
});

describe('code map: resolving Python imports', () => {
	const files = [
		'app/__init__.py', 'app/main.py', 'app/models/__init__.py', 'app/models/user.py',
		'app/services/billing.py', 'app/services/__init__.py', 'scripts/run.py', 'scripts/helper.py',
		'src/lib/__init__.py', 'src/lib/core.py', 'tools/mod.py',
	];
	const r = resolver(files);
	const resolve = (from: string, spec: string, level = 0, names: string[] = []) => r.resolve(from, { spec, level, names }, 'python');

	it('resolves absolute imports through packages', () => {
		expect(resolve('app/main.py', 'app.models.user')).toEqual({ kind: 'files', paths: ['app/models/user.py'] });
		expect(resolve('app/main.py', 'app.models')).toEqual({ kind: 'files', paths: ['app/models/__init__.py'] });
		expect(resolve('app/main.py', 'app.models', 0, ['user'])).toEqual({ kind: 'files', paths: ['app/models/user.py'] });
		// A name that is not a submodule points at the package itself.
		expect(resolve('app/main.py', 'app.models', 0, ['User'])).toEqual({ kind: 'files', paths: ['app/models/__init__.py'] });
		// `a.b.Name` finds the module `a.b`.
		expect(resolve('app/main.py', 'app.services.billing.Invoice')).toEqual({ kind: 'files', paths: ['app/services/billing.py'] });
	});

	it('resolves relative imports', () => {
		expect(resolve('app/services/billing.py', '', 1, ['__init__'])).toEqual({ kind: 'files', paths: ['app/services/__init__.py'] });
		expect(resolve('app/services/billing.py', 'models.user', 2)).toEqual({ kind: 'files', paths: ['app/models/user.py'] });
		expect(resolve('app/services/billing.py', '', 2, ['main', 'models'])).toEqual({ kind: 'files', paths: ['app/main.py', 'app/models/__init__.py'] });
		expect(resolve('app/main.py', '', 4, ['x'])).toEqual({ kind: 'unresolved' });
	});

	it('finds script siblings and src layouts, and names outside packages', () => {
		expect(resolve('scripts/run.py', 'helper')).toEqual({ kind: 'files', paths: ['scripts/helper.py'] });
		expect(resolve('app/main.py', 'lib.core')).toEqual({ kind: 'files', paths: ['src/lib/core.py'] });
		expect(resolve('app/main.py', 'os.path')).toEqual({ kind: 'external', name: 'os' });
		expect(resolve('app/main.py', 'requests')).toEqual({ kind: 'external', name: 'requests' });
		// A local package whose module is missing is not an outside package.
		expect(resolve('app/main.py', 'app.missing')).toEqual({ kind: 'files', paths: ['app/__init__.py'] });
		expect(resolve('app/main.py', 'tools.nothing')).toEqual({ kind: 'unresolved' });
	});
});

describe('code map: resolving Go imports', () => {
	const files = ['go.mod', 'cmd/app/main.go', 'internal/store/store.go', 'internal/store/cache.go', 'internal/store/store_test.go'];
	const r = resolver(files, { 'go.mod': 'module example.com/app\n\ngo 1.22\n' });
	const resolve = (spec: string) => r.resolve('cmd/app/main.go', { spec }, 'go');

	it('maps module packages to their files and names the rest', () => {
		expect(resolve('example.com/app/internal/store')).toEqual({ kind: 'files', paths: ['internal/store/cache.go', 'internal/store/store.go'] });
		expect(resolve('example.com/app/internal/missing')).toEqual({ kind: 'unresolved' });
		expect(resolve('fmt')).toEqual({ kind: 'external', name: 'fmt' });
		expect(resolve('github.com/x/y')).toEqual({ kind: 'external', name: 'github.com/x/y' });
	});
});

describe('code map: resolving Rust modules', () => {
	const files = [
		'Cargo.toml', 'src/main.rs', 'src/config.rs', 'src/net/mod.rs', 'src/net/http.rs', 'src/net/http/client.rs',
		'crates/util/Cargo.toml', 'crates/util/src/lib.rs', 'crates/util/src/fmt.rs',
	];
	const r = resolver(files, {
		'Cargo.toml': '[package]\nname = "app"\n',
		'crates/util/Cargo.toml': '[package]\nname = "my-util"\nversion = "0.1.0"\n',
	});
	const use = (from: string, spec: string) => r.resolve(from, { spec }, 'rust');
	const mod = (from: string, spec: string) => r.resolve(from, { spec, mod: true }, 'rust');

	it('resolves mod declarations to files', () => {
		expect(mod('src/main.rs', 'config')).toEqual({ kind: 'files', paths: ['src/config.rs'] });
		expect(mod('src/main.rs', 'net')).toEqual({ kind: 'files', paths: ['src/net/mod.rs'] });
		expect(mod('src/net/mod.rs', 'http')).toEqual({ kind: 'files', paths: ['src/net/http.rs'] });
		expect(mod('src/net/http.rs', 'client')).toEqual({ kind: 'files', paths: ['src/net/http/client.rs'] });
		expect(mod('src/main.rs', 'missing')).toEqual({ kind: 'unresolved' });
	});

	it('resolves use paths through crate, self, super and workspace crates', () => {
		expect(use('src/net/http.rs', 'crate::config::Settings')).toEqual({ kind: 'files', paths: ['src/config.rs'] });
		expect(use('src/net/http/client.rs', 'super::super::Net')).toEqual({ kind: 'files', paths: ['src/net/mod.rs'] });
		expect(use('src/net/http.rs', 'super::http::client::Client')).toEqual({ kind: 'files', paths: ['src/net/http/client.rs'] });
		expect(use('src/net/http.rs', 'self::client')).toEqual({ kind: 'files', paths: ['src/net/http/client.rs'] });
		expect(use('src/main.rs', 'net::http')).toEqual({ kind: 'files', paths: ['src/net/http.rs'] });
		expect(use('src/main.rs', 'my_util::fmt::pretty')).toEqual({ kind: 'files', paths: ['crates/util/src/fmt.rs'] });
		expect(use('src/main.rs', 'std::collections::HashMap')).toEqual({ kind: 'external', name: 'std' });
		expect(use('src/main.rs', 'Mode::Fast')).toEqual({ kind: 'unresolved' });
	});
});

describe('code map: graph', () => {
	it('builds file nodes and import edges, counting outside packages and files', () => {
		const graph = buildGraph({
			files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'other/d.ts', 'src/data.json'],
			configs: new Map(),
			sources: [
				{ path: 'src/b.ts', text: 'import { a } from "./a";\nexport function b() {}\n' },
				{ path: 'src/a.ts', text: 'import x from "react";\nimport y from "react";\nimport "../other/d";\nimport "./b";\nimport "./b.js";\nimport data from "./data.json";\nimport "./a";\nexport const a = 1;\n' },
				{ path: 'src/c.ts', text: 'import { a } from "./a";\nimport { b } from "./b";\n' },
			],
		});
		expect(graph.nodes.map((n) => n.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
		expect(graph.nodes[0]).toMatchObject({ external: ['react'], outside: 1, lines: 8, symbols: ['a'] });
		expect(graph.edges).toEqual([
			{ from: 'src/a.ts', to: 'src/b.ts', weight: 2 },
			{ from: 'src/b.ts', to: 'src/a.ts', weight: 1 },
			{ from: 'src/c.ts', to: 'src/a.ts', weight: 1 },
			{ from: 'src/c.ts', to: 'src/b.ts', weight: 1 },
		]);
	});

	it('counts lines like an editor', () => {
		expect(countLines('')).toBe(0);
		expect(countLines('one')).toBe(1);
		expect(countLines('one\ntwo\n')).toBe(2);
		expect(countLines('one\n\n')).toBe(2);
	});

	it('folds a large graph into folders within the cap, adding up edges', () => {
		const sources = [];
		for (let i = 0; i < 200; i++) {
			const area = `area${i % 4}`;
			sources.push({ path: `repo/${area}/part${i % 40}/f${i}.ts`, text: i % 4 === 0 ? '' : `import "../../area0/part0/f0";\nimport "../../area0/part0/f0";` });
		}
		const graph = buildGraph({ files: sources.map((s) => s.path), configs: new Map(), sources });
		expect(graph.nodes.length).toBeGreaterThan(MAX_FILE_NODES);
		const deep = folderGraph(graph, 'repo');
		expect(deep.depth).toBe(2);
		expect(deep.nodes.length).toBeLessThanOrEqual(MAX_FILE_NODES);
		const shallow = folderGraph(graph, 'repo', 10);
		expect(shallow.depth).toBe(1);
		expect(shallow.nodes.map((n) => n.key)).toEqual(['area0', 'area1', 'area2', 'area3']);
		expect(shallow.nodes[0]?.files.length).toBe(50);
		expect(shallow.edges).toEqual([
			{ from: 'area1', to: 'area0', weight: 100 },
			{ from: 'area2', to: 'area0', weight: 100 },
			{ from: 'area3', to: 'area0', weight: 100 },
		]);
	});

	it('puts files directly in the mapped folder under the empty key', () => {
		const graph = buildGraph({ files: ['x/top.py', 'x/pkg/m.py'], configs: new Map(), sources: [{ path: 'x/top.py', text: 'from pkg import m' }, { path: 'x/pkg/m.py', text: '' }] });
		expect(folderGraph(graph, 'x').nodes.map((n) => n.key)).toEqual(['', 'pkg']);
		expect(folderGraph(graph, 'x').edges).toEqual([{ from: '', to: 'pkg', weight: 1 }]);
	});
});
