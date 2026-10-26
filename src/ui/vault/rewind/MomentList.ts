import { Component, Keymap, setIcon } from 'obsidian';
import * as path from 'path';
import type { Moment, MomentFile } from '../../../services/rewind/moments';
import { isRestoreMoment } from '../../../services/rewind/restore';
import type { Source } from '../../../services/rewind/records';
import { formatDateTime, formatShortAge } from '../../../utils/time';

/** Moments shown at most. */
export const MAX_MOMENTS = 200;
/** Files listed per moment before "and N more". */
const MAX_FILES = 20;

const SOURCE_ICON: Record<Source, string> = { claude: 'bot', heron: 'pencil', git: 'git-branch', external: 'file-text' };
const SOURCE_NAME: Record<Source, string> = { claude: 'Claude Code', heron: 'Heron', git: 'Git', external: 'Outside Heron' };
const KIND_CLASS: Record<MomentFile['kind'], string> = { create: 'added', modify: 'modified', delete: 'deleted', rename: 'renamed' };
const KIND_LETTER: Record<MomentFile['kind'], string> = { create: 'A', modify: 'M', delete: 'D', rename: 'R' };

export interface MomentListOptions {
	/** The file being looked at: highlighted, and what selecting a moment shows. */
	activePath: string | null;
	/** Shows `file`'s change in `moment`; `newTab` for Mod-click. */
	openDiff(moment: Moment, file: MomentFile, newTab: boolean): void;
	/** Shows the actions for a moment, or for one of its files. */
	openMenu(evt: MouseEvent, moment: Moment, file: MomentFile | null): void;
	now?: number;
}

/** The file a moment's row stands for: the active file if it changed, else its only file. */
export function primaryFile(moment: Moment, activePath: string | null): MomentFile | null {
	const active = activePath ? moment.files.find((f) => f.path === activePath || f.oldPath === activePath) : undefined;
	return active ?? (moment.files.length === 1 ? moment.files[0] ?? null : null);
}

/** Tooltip naming a moment's source in full. */
function sourceTitle(m: Moment): string {
	if (m.source === 'claude' && m.claude) {
		const turn = m.claude.turn ? ` · prompt ${m.claude.turn}` : '';
		return `Claude Code${turn}${m.claude.prompt ? `\n${m.claude.prompt}` : ''}`;
	}
	if (m.source === 'git' && m.git) return `Git: ${m.git.subject}`;
	return SOURCE_NAME[m.source];
}

/**
 * Renders moments as a list: source icon, label, age and the files each
 * changed. DOM listeners are registered on `owner`.
 */
export function renderMoments(parent: HTMLElement, owner: Component, moments: readonly Moment[], opts: MomentListOptions) {
	const now = (opts.now ?? Date.now()) / 1000;
	for (const moment of moments.slice(0, MAX_MOMENTS)) {
		const restore = isRestoreMoment(moment);
		const el = parent.createDiv({ cls: `heron-rewind-moment is-${moment.source}${restore ? ' is-restore' : ''}` });
		const head = el.createDiv({ cls: 'heron-rewind-head tree-item-self is-clickable', attr: { role: 'button', tabindex: '0' } });
		const icon = head.createSpan({ cls: 'heron-rewind-icon' });
		setIcon(icon, restore ? 'rotate-ccw' : SOURCE_ICON[moment.source]);
		icon.setAttr('aria-label', sourceTitle(moment));
		head.createSpan({ cls: 'heron-rewind-label', text: moment.label });
		const age = head.createSpan({ cls: 'heron-rewind-time', text: formatShortAge(moment.end / 1000, now) });
		age.title = formatDateTime(moment.end / 1000);
		const more = head.createSpan({ cls: 'heron-rewind-more clickable-icon', attr: { 'aria-label': 'Actions' } });
		setIcon(more, 'more-horizontal');

		const primary = primaryFile(moment, opts.activePath) ?? moment.files[0] ?? null;
		const show = (evt: MouseEvent | KeyboardEvent) => {
			if (primary) opts.openDiff(moment, primary, Keymap.isModEvent(evt) !== false);
		};
		owner.registerDomEvent(head, 'click', show);
		owner.registerDomEvent(head, 'keydown', (evt) => { if (evt.key === 'Enter') show(evt); });
		owner.registerDomEvent(head, 'contextmenu', (evt) => {
			evt.preventDefault();
			opts.openMenu(evt, moment, primaryFile(moment, opts.activePath));
		});
		owner.registerDomEvent(more, 'click', (evt) => {
			evt.stopPropagation();
			opts.openMenu(evt, moment, primaryFile(moment, opts.activePath));
		});

		const files = el.createDiv({ cls: 'heron-rewind-files' });
		for (const file of moment.files.slice(0, MAX_FILES)) renderFile(files, owner, moment, file, opts);
		if (moment.files.length > MAX_FILES) {
			files.createDiv({ cls: 'heron-rewind-more-files', text: `and ${moment.files.length - MAX_FILES} more` });
		}
	}
}

function renderFile(parent: HTMLElement, owner: Component, moment: Moment, file: MomentFile, opts: MomentListOptions) {
	const active = file.path === opts.activePath || file.oldPath === opts.activePath;
	const row = parent.createDiv({
		cls: `heron-rewind-file heron-change tree-item-self is-clickable heron-kind-${KIND_CLASS[file.kind]}${active ? ' is-active' : ''}`,
		attr: { role: 'button', tabindex: '0' },
	});
	row.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
	row.createSpan({ cls: 'heron-change-letter', text: KIND_LETTER[file.kind] });
	row.createSpan({ cls: 'heron-change-name', text: path.posix.basename(file.path) });
	const dir = path.posix.dirname(file.path);
	if (dir !== '.') row.createSpan({ cls: 'heron-change-dir', text: dir });
	const show = (evt: MouseEvent | KeyboardEvent) => opts.openDiff(moment, file, Keymap.isModEvent(evt) !== false);
	owner.registerDomEvent(row, 'click', show);
	owner.registerDomEvent(row, 'keydown', (evt) => { if (evt.key === 'Enter') show(evt); });
	owner.registerDomEvent(row, 'contextmenu', (evt) => {
		evt.preventDefault();
		opts.openMenu(evt, moment, file);
	});
}
