// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component } from 'obsidian';
import type { AttributedChange } from '../src/services/rewind/attribution';
import { groupMoments, Moment } from '../src/services/rewind/moments';
import { primaryFile, renderMoments } from '../src/ui/vault/rewind/MomentList';

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const d of disposers.splice(0)) d();
	document.body.innerHTML = '';
});

const H = (c: string) => c.repeat(64);
const NOW = 10_000_000;

function moments(): Moment[] {
	const claudeRec = { v: 1 as const, type: 'claude' as const, id: 'c', t: NOW - 120_000, session: 's', turn: 2, prompt: 'add retry to mail sender', tool: 'Edit', files: [] };
	const changes: AttributedChange[] = [
		{ v: 1, type: 'file', id: '1', t: NOW - 120_000, repo: 'Code/app', path: 'Code/app/src/mail.ts', kind: 'modify', before: H('a'), after: H('b'), source: 'claude', claude: claudeRec },
		{ v: 1, type: 'file', id: '2', t: NOW - 119_000, repo: 'Code/app', path: 'Code/app/src/retry.ts', kind: 'create', before: null, after: H('c'), source: 'claude', claude: claudeRec },
		{ v: 1, type: 'file', id: '3', t: NOW - 5_000, repo: 'Code/app', path: 'Code/app/src/mail.ts', kind: 'modify', before: H('b'), after: H('d'), source: 'heron', label: 'Restored mail.ts to 14:03', group: 'restore:x' },
	];
	return groupMoments(changes);
}

function render(activePath: string | null) {
	const owner = new Component();
	owner.load();
	disposers.push(() => owner.unload());
	const openDiff = vi.fn();
	const openMenu = vi.fn();
	const el = document.body.createDiv();
	const list = moments();
	renderMoments(el, owner, list, { activePath, openDiff, openMenu, now: NOW });
	return { el, list, openDiff, openMenu };
}

describe('Rewind moment list', () => {
	it('shows each moment’s source, label, age and files, newest first', () => {
		const { el } = render('Code/app/src/mail.ts');
		const rows = [...el.querySelectorAll('.heron-rewind-moment')];
		expect(rows.map((r) => r.querySelector('.heron-rewind-label')?.textContent)).toEqual([
			'Restored mail.ts to 14:03',
			'Claude: add retry to mail sender · 2 files',
		]);
		expect(rows.map((r) => r.querySelector('.heron-rewind-time')?.textContent)).toEqual(['now', '1m']);
		expect(rows[0]?.classList.contains('is-restore')).toBe(true);
		expect(rows[1]?.classList.contains('is-claude')).toBe(true);
		expect(rows[1]?.querySelector('.heron-rewind-icon')?.getAttribute('aria-label')).toBe('Claude Code · prompt 2\nadd retry to mail sender');
		const files = [...(rows[1]?.querySelectorAll('.heron-rewind-file') ?? [])];
		expect(files.map((f) => [f.querySelector('.heron-change-letter')?.textContent, f.querySelector('.heron-change-name')?.textContent])).toEqual([['M', 'mail.ts'], ['A', 'retry.ts']]);
		expect(files.map((f) => f.classList.contains('is-active'))).toEqual([true, false]);
	});

	it('opens the active file’s diff from a moment, and a file’s diff from its row', () => {
		const { el, list, openDiff } = render('Code/app/src/retry.ts');
		const claudeRow = el.querySelectorAll<HTMLElement>('.heron-rewind-moment')[1]!;
		claudeRow.querySelector<HTMLElement>('.heron-rewind-head')!.click();
		expect(openDiff).toHaveBeenLastCalledWith(list[1], list[1]!.files[1], false);
		claudeRow.querySelector<HTMLElement>('.heron-rewind-file')!.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
		expect(openDiff).toHaveBeenLastCalledWith(list[1], list[1]!.files[0], true);
	});

	it('opens the actions menu for a moment or a file', () => {
		const { el, list, openMenu } = render(null);
		const claudeRow = el.querySelectorAll<HTMLElement>('.heron-rewind-moment')[1]!;
		claudeRow.querySelector<HTMLElement>('.heron-rewind-more')!.click();
		expect(openMenu).toHaveBeenLastCalledWith(expect.any(MouseEvent), list[1], null);
		claudeRow.querySelectorAll<HTMLElement>('.heron-rewind-file')[1]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
		expect(openMenu).toHaveBeenLastCalledWith(expect.any(MouseEvent), list[1], list[1]!.files[1]);
	});

	it('picks the file a moment stands for', () => {
		const list = moments();
		expect(primaryFile(list[1]!, 'Code/app/src/retry.ts')?.path).toBe('Code/app/src/retry.ts');
		expect(primaryFile(list[1]!, null)).toBeNull();
		expect(primaryFile(list[0]!, null)?.path).toBe('Code/app/src/mail.ts');
	});
});
