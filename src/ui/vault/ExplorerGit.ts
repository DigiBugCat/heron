import { App, Component, debounce, TFolder } from 'obsidian';
import { promises as fsp } from 'fs';
import * as path from 'path';
import type { GitRepo } from '../../git/GitRepo';
import { ChangeKind, primaryKind } from '../../git/status';
import { RepoSnapshot, RepoState } from '../../services/RepoState';
import { RepoWatcher } from '../../services/RepoWatcher';

/** How deep under the vault root to look for repositories. */
const MAX_REPO_DEPTH = 3;
/** Folders never searched for repositories (hidden folders are skipped too). */
const SKIP_DIRS = new Set(['node_modules']);

interface TrackedRepo {
	state: RepoState;
	watcher: RepoWatcher;
	/** Change kind by vault path. */
	kinds: Map<string, ChangeKind>;
	watching: boolean;
	snapshot: RepoSnapshot;
}

/** A repository in the vault and its latest git state. */
export interface VaultRepo {
	/** Vault path of the repository's folder. */
	rel: string;
	snapshot: RepoSnapshot;
}

/** Finds folders under `base` (up to `depth` levels) that hold a `.git` entry, as vault paths. */
export async function findRepos(base: string, depth = MAX_REPO_DEPTH): Promise<string[]> {
	const found: string[] = [];
	const visit = async (rel: string, level: number) => {
		let entries;
		try {
			entries = await fsp.readdir(path.join(base, rel), { withFileTypes: true });
		} catch {
			return;
		}
		if (rel && entries.some((e) => e.name === '.git')) {
			found.push(rel);
			return;
		}
		if (level >= depth) return;
		for (const e of entries) {
			if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) {
				await visit(rel ? `${rel}/${e.name}` : e.name, level + 1);
			}
		}
	};
	await visit('', 0);
	return found;
}

/** Every folder above `vaultPath` (exclusive), up to but excluding the vault root. */
export function parentFolders(vaultPath: string): string[] {
	const parts = vaultPath.split('/');
	const result: string[] = [];
	for (let i = parts.length - 1; i > 0; i--) result.push(parts.slice(0, i).join('/'));
	return result;
}

/**
 * Colours files in Obsidian's file explorer by git status, for repositories
 * that live inside the vault: modified orange, new green, and a dot on
 * folders that contain changes. Obsidian has no API for this, so it marks
 * the explorer's items by their `data-path` attribute and re-applies when
 * the explorer redraws.
 */
export class ExplorerGit extends Component {
	private repos = new Map<string, TrackedRepo>();
	private kinds = new Map<string, ChangeKind>();
	private dirty = new Set<string>();
	private observers: MutationObserver[] = [];
	private apply = debounce(() => this.decorate(), 50, true);
	private rediscover = debounce(() => { void this.discover(); }, 1000, true);
	private listeners = new Set<() => void>();

	constructor(private app: App, private basePath: string) {
		super();
	}

	onload() {
		this.app.workspace.onLayoutReady(() => {
			void this.discover();
			this.observeExplorers();
		});
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			this.observeExplorers();
			this.apply();
		}));
		this.registerEvent(this.app.vault.on('create', (f) => { if (f instanceof TFolder) this.rediscover(); }));
		this.registerEvent(this.app.vault.on('delete', (f) => { if (f instanceof TFolder) this.rediscover(); }));
	}

	onunload() {
		this.apply.cancel();
		this.rediscover.cancel();
		for (const o of this.observers) o.disconnect();
		for (const repo of this.repos.values()) repo.state.dispose();
		this.kinds.clear();
		this.dirty.clear();
		this.decorate();
	}

	/** Vault paths of the repositories being tracked. */
	trackedRepos(): string[] {
		return [...this.repos.keys()];
	}

	/** Every tracked repository with its latest state, in vault path order. */
	vaultRepos(): VaultRepo[] {
		return [...this.repos].map(([rel, repo]) => ({ rel, snapshot: repo.snapshot })).sort((a, b) => a.rel.localeCompare(b.rel));
	}

	/** The innermost readable repository holding `vaultPath`, or null. */
	repoAt(vaultPath: string): { rel: string; repo: GitRepo } | null {
		let best: { rel: string; repo: GitRepo } | null = null;
		for (const [rel, tracked] of this.repos) {
			const inside = vaultPath === rel || vaultPath.startsWith(`${rel}/`);
			if (!inside || tracked.snapshot.kind !== 'repo' || (best && best.rel.length >= rel.length)) continue;
			best = { rel, repo: tracked.snapshot.repo };
		}
		return best;
	}

	/** Calls `listener` whenever any repository's state changes; returns an unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Re-reads git status for every repository now. */
	refresh() {
		for (const repo of this.repos.values()) void repo.state.refresh();
	}

	/** Finds repositories in the vault and starts or stops tracking them. */
	async discover() {
		const found = new Set(await findRepos(this.basePath));
		for (const [rel, repo] of this.repos) {
			if (found.has(rel)) continue;
			repo.state.dispose();
			this.removeChild(repo.watcher);
			this.repos.delete(rel);
		}
		for (const rel of found) {
			if (!this.repos.has(rel)) this.track(rel);
		}
		this.recompute();
	}

	private track(rel: string) {
		const root = path.join(this.basePath, rel);
		const state = new RepoState();
		const tracked: TrackedRepo = {
			state,
			kinds: new Map(),
			watching: false,
			snapshot: { kind: 'none' },
			watcher: this.addChild(new RepoWatcher({
				isVisible: () => true,
				onGitChange: () => { void state.refresh(); },
				onTreeChange: () => { void state.refresh(); },
			})),
		};
		this.repos.set(rel, tracked);
		state.onChange((snapshot) => {
			tracked.snapshot = snapshot;
			tracked.kinds = new Map();
			if (snapshot.kind === 'repo') {
				for (const file of snapshot.status.files) {
					const abs = snapshot.repo.absPath(file.path);
					tracked.kinds.set(path.relative(this.basePath, abs).split(path.sep).join('/'), primaryKind(file));
				}
				if (!tracked.watching) tracked.watcher.watch(snapshot.folder, snapshot.repo);
				tracked.watching = true;
			}
			this.recompute();
		});
		void state.open(root);
	}

	private recompute() {
		this.kinds = new Map();
		this.dirty = new Set();
		for (const repo of this.repos.values()) {
			for (const [vaultPath, kind] of repo.kinds) {
				this.kinds.set(vaultPath, kind);
				for (const folder of parentFolders(vaultPath)) this.dirty.add(folder);
			}
		}
		this.apply();
		for (const listener of this.listeners) listener();
	}

	/** Watches each file explorer for redraws (expanding folders, scrolling, renames). */
	private observeExplorers() {
		for (const o of this.observers) o.disconnect();
		this.observers = this.app.workspace.getLeavesOfType('file-explorer').map((leaf) => {
			const observer = new MutationObserver(() => this.apply());
			observer.observe(leaf.view.containerEl, { childList: true, subtree: true });
			return observer;
		});
	}

	private decorate() {
		for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
			const items = leaf.view.containerEl.querySelectorAll<HTMLElement>('.nav-file-title[data-path], .nav-folder-title[data-path]');
			items.forEach((el) => {
				const vaultPath = el.dataset.path ?? '';
				const kind = this.kinds.get(vaultPath);
				if (kind) el.setAttribute('data-heron-git', kind);
				else el.removeAttribute('data-heron-git');
				el.toggleClass('heron-git-dirty', this.dirty.has(vaultPath));
			});
		}
	}
}
