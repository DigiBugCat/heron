import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores } from 'eslint/config';
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js';

export default tseslint.config(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'scripts',
		'test-vault',
		'tests/fixtures',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Product names keep their casing in UI text ("Show Rewind", "Claude Code").
		rules: {
			'obsidianmd/ui/sentence-case': ['error', { enforceCamelCaseLower: true, brands: [...DEFAULT_BRANDS, 'Claude Code', 'Rewind'] }],
		},
	},
	{
		// Tests run under Node via vitest, not inside Obsidian.
		files: ['tests/**/*.ts'],
		languageOptions: { globals: { ...globals.node } },
		rules: {
			'obsidianmd/prefer-window-timers': 'off',
			'obsidianmd/prefer-active-doc': 'off',
		},
	},
	{
		// @codemirror/* and @lezer/* are Obsidian-provided externals (not bundled).
		// They live in devDependencies intentionally — allow importing them from src.
		rules: {
			'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
		},
	},
);
