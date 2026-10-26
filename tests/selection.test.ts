// @vitest-environment jsdom
import { readFileSync } from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Component } from 'obsidian';
import { CodeRenderer } from '../src/ui/pane/renderers';

describe('selecting read-only code (regression: selections were invisible inside Obsidian)', () => {
	it('draws its own selection layer', () => {
		const owner = new Component();
		owner.load();
		const code = owner.addChild(new CodeRenderer(document.body.createDiv(), 13));
		code.setDocument('const a = 1;\nconst b = 2;\n', 'a.ts', false);
		expect(document.querySelector('.heron-code-view .cm-selectionLayer')).not.toBeNull();
		owner.unload();
	});

	it('re-enables text selection that Obsidian turns off for non-editable content', () => {
		const css = readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf-8');
		expect(css).toMatch(/\.heron-renderer \.cm-content,\s*\.heron-embed-body \.cm-content \{[^}]*user-select: text;/);
	});
});
