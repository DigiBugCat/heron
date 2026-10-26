import { ItemView, Keymap, setIcon, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import { ChangeEntry, ChangeGroup, ChangeKind, groupChanges } from '../../git/status';
import type { ExplorerGit, VaultRepo } from './ExplorerGit';

export const CHANGES_VIEW_TYPE = 'heron-changes';

const GROUPS: { group: ChangeGroup; title: string }[] = [
	{ group: 'conflicts', title: 'Conflicts' },
	{ group: 'staged', title: 'Staged' },
	{ group: 'unstaged', title: 'Changes' },
];

const KIND_LETTER: Record<ChangeKind, string> = {
	added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!',
};

export interface ChangesViewOptions {
	git: () => ExplorerGit | null;
	/** Opens the diff of `entry` in `repoRel`; `newTab` for Mod-click. */
	openDiff: (repoRel: string, entry: ChangeEntry, newTab: boolean) => void;
	/** Opens the changed file itself. */
	openFile: (vaultPath: string, newTab: boolean) => void;
}

/**
 * Right-sidebar list of uncommitted changes in every repository in the
 * vault, grouped like a source control panel. Selecting a change opens its
 * diff in a tab. Read-only: Heron never stages or commits.
 */
export class ChangesView extends ItemView {
	private listEl!: HTMLElement;
	private collapsed = new Set<string>();

	constructor(leaf: WorkspaceLeaf, private opts: ChangesViewOptions) {
		super(leaf);
	}

	getViewType() { return CHANGES_VIEW_TYPE; }

	getDisplayText() { return 'Code changes'; }

	getIcon() { return 'git-branch'; }

	onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('heron-panel');
		this.listEl = this.contentEl.createDiv({ cls: 'heron-changes' });
		this.app.workspace.onLayoutReady(() => {
			const git = this.opts.git();
			if (git) this.register(git.onChange(() => this.render()));
			this.render();
		});
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.render()));
		return Promise.resolve();
	}

	private render() {
		const git = this.opts.git();
		this.listEl.empty();
		const repos = git?.vaultRepos() ?? [];
		if (!repos.length) {
			this.listEl.createDiv({ cls: 'heron-panel-empty', text: 'No git repositories in this vault.' });
			return;
		}
		// The repository of the file you're looking at comes first.
		const active = this.app.workspace.getActiveFile()?.path ?? '';
		repos.sort((a, b) => Number(active.startsWith(`${b.rel}/`)) - Number(active.startsWith(`${a.rel}/`)));
		for (const repo of repos) this.renderRepo(repo);
	}

	private renderRepo({ rel, snapshot }: VaultRepo) {
		const section = this.listEl.createDiv({ cls: 'heron-changes-repo' });
		const header = section.createDiv({ cls: 'heron-changes-header tree-item-self is-clickable', attr: { role: 'button', tabindex: '0' } });
		const collapsed = this.collapsed.has(rel);
		setIcon(header.createSpan({ cls: 'heron-changes-chevron' }), collapsed ? 'chevron-right' : 'chevron-down');
		header.createSpan({ cls: 'heron-changes-name', text: path.posix.basename(rel) });
		const toggle = () => {
			if (collapsed) this.collapsed.delete(rel);
			else this.collapsed.add(rel);
			this.render();
		};
		this.registerDomEvent(header, 'click', toggle);
		this.registerDomEvent(header, 'keydown', (evt) => { if (evt.key === 'Enter') toggle(); });

		if (snapshot.kind !== 'repo') {
			header.createSpan({ cls: 'heron-changes-branch', text: snapshot.kind === 'none' ? 'loading…' : 'not readable' });
			return;
		}
		const { branch, files } = snapshot.status;
		const branchText = branch.head ?? (branch.oid ? `detached ${branch.oid.slice(0, 7)}` : 'no commits');
		const sync = [branch.ahead ? `↑${branch.ahead}` : '', branch.behind ? `↓${branch.behind}` : ''].filter(Boolean).join(' ');
		header.createSpan({ cls: 'heron-changes-branch', text: sync ? `${branchText} ${sync}` : branchText });
		header.createSpan({ cls: 'heron-changes-count', text: String(files.length) });
		if (collapsed) return;

		const entries = groupChanges(files);
		if (!entries.length) {
			section.createDiv({ cls: 'heron-panel-empty', text: 'No changes.' });
			return;
		}
		for (const { group, title } of GROUPS) {
			const inGroup = entries.filter((e) => e.group === group);
			if (!inGroup.length) continue;
			section.createDiv({ cls: 'heron-changes-group', text: `${title} · ${inGroup.length}` });
			for (const entry of inGroup) this.renderEntry(section, rel, entry);
		}
	}

	private renderEntry(parent: HTMLElement, repoRel: string, entry: ChangeEntry) {
		const vaultPath = `${repoRel}/${entry.file.path}`;
		const row = parent.createDiv({ cls: `heron-change tree-item-self is-clickable heron-kind-${entry.kind}`, attr: { role: 'button', tabindex: '0' } });
		row.title = entry.file.origPath ? `${entry.file.origPath} → ${entry.file.path}` : entry.file.path;
		row.createSpan({ cls: 'heron-change-letter', text: KIND_LETTER[entry.kind] });
		row.createSpan({ cls: 'heron-change-name', text: path.posix.basename(entry.file.path) });
		const dir = path.posix.dirname(entry.file.path);
		if (dir !== '.') row.createSpan({ cls: 'heron-change-dir', text: dir });
		if (entry.kind !== 'deleted') {
			const open = row.createSpan({ cls: 'heron-change-open clickable-icon', attr: { 'aria-label': 'Open file' } });
			setIcon(open, 'file-text');
			this.registerDomEvent(open, 'click', (evt) => {
				evt.stopPropagation();
				this.opts.openFile(vaultPath, Keymap.isModEvent(evt) !== false);
			});
		}
		const showDiff = (evt: MouseEvent | KeyboardEvent) => this.opts.openDiff(repoRel, entry, Keymap.isModEvent(evt) !== false);
		this.registerDomEvent(row, 'click', showDiff);
		this.registerDomEvent(row, 'keydown', (evt) => { if (evt.key === 'Enter') showDiff(evt); });
	}
}
