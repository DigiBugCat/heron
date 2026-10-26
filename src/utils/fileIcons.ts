/** [lucide icon name, css colour class] */
export type FileIconSpec = [string, string];

const CODE = 'file-code-2';

const EXT_ICON: Record<string, FileIconSpec> = {
	ts:    [CODE, 'heron-icon-ts'],
	tsx:   [CODE, 'heron-icon-ts'],
	js:    [CODE, 'heron-icon-js'],
	jsx:   [CODE, 'heron-icon-js'],
	mjs:   [CODE, 'heron-icon-js'],
	cjs:   [CODE, 'heron-icon-js'],
	py:    [CODE, 'heron-icon-py'],
	rs:    [CODE, 'heron-icon-rs'],
	go:    [CODE, 'heron-icon-go'],
	rb:    [CODE, 'heron-icon-rb'],
	java:  [CODE, 'heron-icon-java'],
	kt:    [CODE, 'heron-icon-java'],
	kts:   [CODE, 'heron-icon-java'],
	scala: [CODE, 'heron-icon-java'],
	swift: [CODE, 'heron-icon-rs'],
	c:     [CODE, 'heron-icon-c'],
	h:     [CODE, 'heron-icon-c'],
	cpp:   [CODE, 'heron-icon-c'],
	cc:    [CODE, 'heron-icon-c'],
	hpp:   [CODE, 'heron-icon-c'],
	cs:    [CODE, 'heron-icon-c'],
	lua:   [CODE, 'heron-icon-c'],
	php:   [CODE, 'heron-icon-php'],
	sql:   ['database',    'heron-icon-json'],
	css:   ['paintbrush',  'heron-icon-css'],
	scss:  ['paintbrush',  'heron-icon-css'],
	less:  ['paintbrush',  'heron-icon-css'],
	html:  ['code',        'heron-icon-html'],
	htm:   ['code',        'heron-icon-html'],
	xml:   ['code',        'heron-icon-html'],
	vue:   ['code',        'heron-icon-vue'],
	svelte:['code',        'heron-icon-svelte'],
	json:  ['braces',      'heron-icon-json'],
	jsonc: ['braces',      'heron-icon-json'],
	yaml:  ['braces',      'heron-icon-json'],
	yml:   ['braces',      'heron-icon-json'],
	toml:  ['braces',      'heron-icon-json'],
	md:    ['file-text',   'heron-icon-md'],
	mdx:   ['file-text',   'heron-icon-md'],
	txt:   ['file-text',   'heron-icon-txt'],
	sh:    ['terminal',    'heron-icon-sh'],
	bash:  ['terminal',    'heron-icon-sh'],
	zsh:   ['terminal',    'heron-icon-sh'],
	fish:  ['terminal',    'heron-icon-sh'],
	env:   ['lock',        'heron-icon-env'],
	png:   ['image',       'heron-icon-img'],
	jpg:   ['image',       'heron-icon-img'],
	jpeg:  ['image',       'heron-icon-img'],
	gif:   ['image',       'heron-icon-img'],
	svg:   ['image',       'heron-icon-img'],
	webp:  ['image',       'heron-icon-img'],
	ico:   ['image',       'heron-icon-img'],
};

const DEFAULT_ICON: FileIconSpec = ['file', 'heron-icon-default'];

/** Returns the lowercase extension of `name`, or '' when it has none. */
export function extensionOf(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Icon and colour class for a file name. Dotfiles like `.env` use their name as the extension. */
export function fileIcon(name: string): FileIconSpec {
	const ext = extensionOf(name) || (name.startsWith('.') ? name.slice(1).toLowerCase() : '');
	return EXT_ICON[ext] ?? DEFAULT_ICON;
}
