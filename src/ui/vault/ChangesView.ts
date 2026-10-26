import { ItemView, Keymap, Notice, setIcon, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import type { GitRepo } from '../../git/GitRepo';
import { badgeFor, ChangeEntry, ChangeGroup, groupChanges, RepoStatus } from '../../git/status';
import { BaseComparisons, BaseView } from '../../services/BaseComparison';
import { showBaseMenu } from './baseMenu';
import type { ExplorerGit, VaultRepo } from './ExplorerGit';

export const CHANGES_VIEW_TYPE = 'heron-changes';

const GROUPS: { group: ChangeGroup; title: string }[] = [
	{ group: 'conflicts', title: 'Conflicts' },
	{ group: 'staged', title: 'Staged' },
	{ group: 'unstaged', title: 'Changes' },
];

/** Which repositories compare with a base branch, and which branch; kept in the settings. */
export interface BaseChoices {
	/** True when `repo` shows its changes against a base branch. */
	isOn(repo: GitRepo): boolean;
	setOn(repo: GitRepo, on: boolean): void;
	/** The base branch chosen for `repo`, or null for its default. */
	branch(repo: GitRepo): string | null;
	setBranch(repo: GitRepo, branch: string): void;
	/** Calls `listener` when any choice changes; returns an unsubscribe function. */
	onChange(listener: () => void): () => void;
}

export interface ChangesViewOptions {
	git: () => ExplorerGit | null;
	base: BaseChoices;
	/** Opens the diff of `entry` in `repoRel`; `newTab` for Mod-click. */
	openDiff: (repoRel: string, entry: ChangeEntry, newTab: boolean) => void;
	/** Opens the changed file itself. */
	openFile: (vaultPath: string, newTab: boolean) => void;
}

/**
 * Right-sidebar list of the changes in every repository in the vault:
 * uncommitted changes grouped like a source control panel, or, per
 * repository, everything changed since it branched off a base branch.
 * Selecting a change opens its diff in a tab. Read-only: Heron never
 * stages or commits.
 */
export class ChangesView extends ItemView {
	private listEl!: HTMLElement;
	private collapsed = new Set<string>();
	private comparisons = new BaseComparisons(() => this.render());

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
		this.register(() => this.comparisons.clear());
		this.register(this.opts.base.onChange(() => this.render()));
		this.app.workspace.onLayoutReady(() => {
			const git = this.opts.git();
			if (git) this.register(git.onChange(() => this.render()));
			this.render();
		});
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.render()));
		return Promise.resolve();
	}

	/** Switches `repo` between uncommitted changes and changes against its base branch. */
	toggleBase(repo: GitRepo) {
		this.opts.base.setOn(repo, !this.opts.base.isOn(repo));
	}

	private render() {
		if (!this.listEl) return;
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
		const { repo, status } = snapshot;
		const baseOn = this.opts.base.isOn(repo);
		const base = baseOn ? this.baseView(repo, status) : null;
		if (!baseOn) this.comparisons.drop(repo.commonDir);

		const { branch, files } = status;
		const branchText = branch.head ?? (branch.oid ? `detached ${branch.oid.slice(0, 7)}` : 'no commits');
		const sync = [branch.ahead ? `↑${branch.ahead}` : '', branch.behind ? `↓${branch.behind}` : ''].filter(Boolean).join(' ');
		header.createSpan({ cls: 'heron-changes-branch', text: sync ? `${branchText} ${sync}` : branchText });
		const count = base ? (base.kind === 'ok' ? base.entries.length : null) : files.length;
		header.createSpan({ cls: 'heron-changes-count', text: count === null ? '…' : String(count) });
		this.renderBaseToggle(header, repo, baseOn);
		if (collapsed) return;

		if (base) {
			this.renderBase(section, rel, repo, base);
			return;
		}
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

	/** The comparison for `repo`, starting or refreshing it as needed. */
	private baseView(repo: GitRepo, status: RepoStatus): BaseView {
		this.comparisons.update(repo.commonDir, repo, status, this.opts.base.branch(repo));
		return this.comparisons.view(repo.commonDir) ?? { kind: 'loading', ref: null };
	}

	/** The header button that switches between uncommitted changes and changes against the base branch. */
	private renderBaseToggle(header: HTMLElement, repo: GitRepo, on: boolean) {
		const label = on ? 'Show uncommitted changes' : 'Compare with base branch';
		const button = header.createSpan({
			cls: `heron-changes-base-toggle clickable-icon${on ? ' is-active' : ''}`,
			attr: { role: 'button', tabindex: '0', 'aria-label': label, 'aria-pressed': String(on) },
		});
		setIcon(button, 'git-compare');
		const toggle = (evt: Event) => {
			evt.stopPropagation();
			this.toggleBase(repo);
		};
		this.registerDomEvent(button, 'click', toggle);
		this.registerDomEvent(button, 'keydown', (evt) => { if (evt.key === 'Enter') toggle(evt); });
	}

	/** The "Against <branch> · N commits" line, then every file changed since the merge base. */
	private renderBase(section: HTMLElement, rel: string, repo: GitRepo, base: BaseView) {
		const line = section.createDiv({ cls: 'heron-changes-base tree-item-self is-clickable', attr: { role: 'button', tabindex: '0', 'aria-haspopup': 'menu' } });
		setIcon(line.createSpan({ cls: 'heron-changes-base-icon' }), 'git-compare');
		line.createSpan({ cls: 'heron-changes-base-label', text: 'Against' });
		line.createSpan({ cls: 'heron-changes-base-ref', text: base.ref ?? (base.kind === 'loading' ? 'base branch' : 'no base branch') });
		if (base.kind === 'ok') {
			const commits = base.ahead === 1 ? '1 commit' : `${base.ahead} commits`;
			line.createSpan({ cls: 'heron-changes-base-ahead', text: commits });
			line.title = `Changes since ${base.ref} at ${base.commit.slice(0, 7)}: ${commits} plus uncommitted changes.\nSelect to choose another base branch.`;
		} else {
			line.title = 'Select to choose a base branch';
		}
		setIcon(line.createSpan({ cls: 'heron-changes-chevron' }), 'chevron-down');
		const choose = () => { void this.chooseBase(line, repo, base.ref); };
		this.registerDomEvent(line, 'click', choose);
		this.registerDomEvent(line, 'keydown', (evt) => { if (evt.key === 'Enter') choose(); });

		if (base.kind === 'loading') {
			section.createDiv({ cls: 'heron-panel-empty', text: 'Comparing…' });
			return;
		}
		if (base.kind === 'error') {
			section.createDiv({ cls: 'heron-panel-empty heron-changes-base-error', text: base.message });
			return;
		}
		if (!base.entries.length) {
			section.createDiv({ cls: 'heron-panel-empty', text: `No changes against ${base.ref}.` });
			return;
		}
		for (const entry of base.entries) this.renderEntry(section, rel, entry);
	}

	/** Lists the repository's branches below `anchor` and compares with the one chosen. */
	private async chooseBase(anchor: HTMLElement, repo: GitRepo, current: string | null) {
		let branches: string[];
		try {
			branches = await repo.branches();
		} catch (err) {
			new Notice(`Cannot list branches: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		const rect = anchor.getBoundingClientRect();
		showBaseMenu(anchor.doc, { x: rect.left, y: rect.bottom }, branches, current, (branch) => this.opts.base.setBranch(repo, branch));
	}

	private renderEntry(parent: HTMLElement, repoRel: string, entry: ChangeEntry) {
		const vaultPath = `${repoRel}/${entry.file.path}`;
		const row = parent.createDiv({ cls: `heron-change tree-item-self is-clickable heron-kind-${entry.kind}`, attr: { role: 'button', tabindex: '0' } });
		row.title = entry.file.origPath ? `${entry.file.origPath} → ${entry.file.path}` : entry.file.path;
		row.createSpan({ cls: 'heron-change-letter', text: badgeFor(entry.kind) });
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
