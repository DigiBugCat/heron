import { describe, expect, it } from 'vitest';
import { expandUseTree, parseImports } from '../src/codemap/imports';
import { languageOf, maskSource } from '../src/codemap/mask';
import { outlineSymbols } from '../src/codemap/outline';

const specs = (text: string, lang: Parameters<typeof parseImports>[1]) => parseImports(text, lang).map((r) => r.spec);

describe('code map: source masking', () => {
	it('keeps offsets and line breaks while blanking comments and string contents', () => {
		const text = 'const a = "x // y"; // note\n/* block\n */ b';
		const masked = maskSource(text, 'ts');
		expect(masked).toHaveLength(text.length);
		expect(masked.split('\n')).toHaveLength(3);
		expect(masked).toContain('"      "');
		expect(masked).not.toContain('note');
		expect(masked).not.toContain('block');
		expect(masked.endsWith(' b')).toBe(true);
	});

	it('tells regular expressions from division', () => {
		const masked = maskSource('const r = /it\'s/g; const d = a / b / c; import "x";', 'ts');
		expect(masked).toContain('import "');
		expect(masked).toContain('a / b / c');
	});

	it('handles nested template literals', () => {
		const text = 'const t = `a ${f(`b ${c}`)} import "no"`;\nimport x from "./real";';
		expect(specs(text, 'ts')).toEqual(['./real']);
	});

	it('maps file extensions to languages', () => {
		expect(languageOf('src/a.tsx')).toBe('ts');
		expect(languageOf('lib/b.mjs')).toBe('ts');
		expect(languageOf('pkg/c.py')).toBe('python');
		expect(languageOf('cmd/main.go')).toBe('go');
		expect(languageOf('src/lib.rs')).toBe('rust');
		expect(languageOf('README.md')).toBeNull();
		expect(languageOf('.eslintrc')).toBeNull();
	});
});

describe('code map: TypeScript and JavaScript imports', () => {
	it('finds every import form', () => {
		const text = [
			'import a from "./a";',
			'import { b, c as d } from \'./b\';',
			'import * as e from "./e";',
			'import type { F } from "./f";',
			'import "./side-effect";',
			'import {',
			'  g,',
			'  h,',
			'} from "./multi";',
			'export * from "./star";',
			'export * as ns from "./ns";',
			'export { x } from "./reexport";',
			'export type { T } from "./types";',
			'const r = require("./req");',
			'import fs = require("fs");',
			'const lazy = await import("./lazy");',
			'const tpl = import(`./tpl`);',
		].join('\n');
		expect(specs(text, 'ts')).toEqual([
			'./a', './b', './e', './f', './side-effect', './multi',
			'./star', './ns', './reexport', './types',
			'./req', 'fs', './lazy', './tpl',
		]);
	});

	it('ignores imports in comments and strings, and computed specifiers', () => {
		const text = [
			'// import a from "./commented";',
			'/* import b from "./block"; */',
			'const s = "import c from \'./string\'";',
			'const t = `import d from "./template"`;',
			'const name = "x"; require("./" + name); import(`./dyn/${name}`);',
			'obj.import("./method");',
			'const exportFrom = 1; export const y = "./not-an-import";',
		].join('\n');
		expect(specs(text, 'ts')).toEqual([]);
	});
});

describe('code map: Python imports', () => {
	it('parses import and from-import statements', () => {
		const text = [
			'import os, sys',
			'import a.b.c as abc',
			'from pkg.mod import thing, other as o',
			'from . import sibling',
			'from .. import parent_mod',
			'from .sub.deep import Name',
			'from x import (',
			'    one,',
			'    two,  # comment',
			')',
			'from y import *',
			'def f():',
			'    import inner; from z import w',
			'mod = importlib.import_module("dyn.mod")',
		].join('\n');
		const refs = parseImports(text, 'python');
		expect(refs).toEqual(expect.arrayContaining([
			{ spec: 'pkg.mod', level: 0, names: ['thing', 'other'] },
			{ spec: '', level: 1, names: ['sibling'] },
			{ spec: '', level: 2, names: ['parent_mod'] },
			{ spec: 'sub.deep', level: 1, names: ['Name'] },
			{ spec: 'x', level: 0, names: ['one', 'two'] },
			{ spec: 'y', level: 0, names: ['*'] },
			{ spec: 'z', level: 0, names: ['w'] },
			{ spec: 'os', level: 0, names: [] },
			{ spec: 'sys', level: 0, names: [] },
			{ spec: 'a.b.c', level: 0, names: [] },
			{ spec: 'inner', level: 0, names: [] },
			{ spec: 'dyn.mod', level: 0, names: [] },
		]));
		expect(refs).toHaveLength(12);
	});

	it('ignores imports in docstrings and comments, and joins continuations', () => {
		const text = [
			'"""',
			'import not_real',
			'"""',
			'# from fake import x',
			's = "import nope"',
			'from long.module import \\',
			'    name',
		].join('\n');
		expect(parseImports(text, 'python')).toEqual([{ spec: 'long.module', level: 0, names: ['name'] }]);
	});
});

describe('code map: Go imports', () => {
	it('parses single and grouped imports with aliases', () => {
		const text = [
			'package main',
			'import "fmt"',
			'import str "strings"',
			'import (',
			'\t"os"',
			'\t_ "embed"',
			'\t. "example.com/app/internal/dot"',
			'\tcfg "example.com/app/config" // comment "not/this"',
			'\t`example.com/app/raw`',
			')',
			'// import "commented"',
			'var s = "import \\"fake\\""',
		].join('\n');
		expect(specs(text, 'go')).toEqual(['fmt', 'strings', 'os', 'embed', 'example.com/app/internal/dot', 'example.com/app/config', 'example.com/app/raw']);
	});
});

describe('code map: Rust imports', () => {
	it('parses mod declarations, use trees and extern crates', () => {
		const text = [
			'mod config;',
			'pub mod net;',
			'pub(crate) mod util;',
			'mod inline { fn x() {} }',
			'use crate::config::Settings;',
			'use super::parent::{self, Thing as Other};',
			'pub use self::net::*;',
			'use std::{collections::HashMap, io::{self, Read}};',
			'extern crate serde;',
			'// use crate::commented;',
			'let s = "use crate::string;";',
			'let r = r#"mod fake;"#;',
			'fn f<\'a>(x: &\'a str) -> char { \'"\' }',
			'use crate::after_lifetime;',
		].join('\n');
		const refs = parseImports(text, 'rust');
		expect(refs.filter((r) => r.mod).map((r) => r.spec)).toEqual(['config', 'net', 'util']);
		expect(refs.filter((r) => !r.mod).map((r) => r.spec)).toEqual([
			'crate::config::Settings',
			'super::parent',
			'super::parent::Thing',
			'self::net',
			'std::collections::HashMap',
			'std::io',
			'std::io::Read',
			'crate::after_lifetime',
			'serde',
		]);
	});

	it('expands use trees', () => {
		expect(expandUseTree('a::{b, c::{d, e as f}, self, *}')).toEqual([['a', 'b'], ['a', 'c', 'd'], ['a', 'c', 'e'], ['a'], ['a']]);
		expect(expandUseTree('::std::fmt')).toEqual([['std', 'fmt']]);
	});
});

describe('code map: outline', () => {
	const outline = (text: string, lang: Parameters<typeof maskSource>[1]) => outlineSymbols(maskSource(text, lang), lang);

	it('lists exported TypeScript declarations, or top-level ones when nothing is exported', () => {
		const exported = 'export class A {}\nexport default function b() {}\nconst helper = 1;\nfunction local() {}\nexport const C = 1;\n  export function nested() {}';
		expect(outline(exported, 'ts')).toEqual(['A', 'b', 'C']);
		expect(outline('const helper = 1;\nfunction local() {}\nclass K {}', 'ts')).toEqual(['local', 'K']);
	});

	it('lists public Python, Go and Rust symbols', () => {
		expect(outline('class A:\n    def method(self): pass\ndef _private(): pass\nasync def run(): pass', 'python')).toEqual(['A', 'run']);
		expect(outline('type Server struct{}\nfunc (s *Server) Start() {}\nfunc helper() {}\nfunc New() *Server {}', 'go')).toEqual(['Server', 'Server.Start', 'New']);
		expect(outline('pub struct S;\nfn private() {}\npub(crate) fn f() {}\npub async fn g() {}\nimpl S {}', 'rust')).toEqual(['S', 'f', 'g']);
	});

	it('ignores declarations in comments and strings', () => {
		expect(outline('// export class Fake {}\nconst s = `\nexport class Nope {}\n`;\nexport class Real {}', 'ts')).toEqual(['Real']);
	});
});
