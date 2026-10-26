import { Component, debounce, TFile } from 'obsidian';
import { promises as fsp } from 'fs';
import * as path from 'path';
import type HeronPlugin from '../../../main';
import { changesFiles } from '../../../services/rewind/attribution';
import { HOOK_LOG_NAME, hookLogEnd, readHookLog } from '../../../services/rewind/claudeHook';
import { hashText, HistoryStore } from '../../../services/rewind/HistoryStore';
import type { Moment } from '../../../services/rewind/moments';
import { ClaudeRecord, newId } from '../../../services/rewind/records';
import { Recorder, RepoRef } from '../../../services/rewind/Recorder';
import { buildMoments, claudeRecordFrom } from '../../../services/rewind/timeline';
import { heronDataDir, rewindDir } from '../../../utils/appData';
import { readViewableFile } from '../../../utils/content';
import type { ExplorerGit } from '../ExplorerGit';

/** Quiet period before queued file changes are recorded, in ms. */
const FLUSH_MS = 500;
/** How often the Claude Code hook log is checked for new lines, in ms. */
const HOOK_POLL_MS = 1500;
/** How often history is pruned, in ms. */
const PRUNE_MS = 60 * 60 * 1000;
/** At most this many uncommitted files per repository get a baseline at startup. */
const MAX_DIRTY_BASELINES = 300;
/** At most this many known files are checked for changes made while Obsidian was closed. */
const MAX_RECONCILE = 5000;
const HOOK_OFFSET_KEY = 'claudeHookOffset';

/**
 * Rewind's capture side: records every change to files in the vault's
 * repositories (from Obsidian's vault events), marks git operations and
 * reads Claude Code's hook log. Owns the history store; views read moments
 * from here.
 */
export class Rewind extends Component {
	store: HistoryStore | null = null;
	recorder: Recorder | null = null;
	private starting: Promise<void> | null = null;
	private repos: { rel: string; ref: RepoRef }[] = [];
	private heads = new Map<string, string>();
	private seenRepos = new Set<string>();
	private cached: Moment[] | null = null;
	private listeners = new Set<() => void>();
	private flushSoon = debounce(() => { void this.recorder?.flush(); }, FLUSH_MS, false);
	private notifySoon = debounce(() => { for (const l of this.listeners) l(); }, 200, false);
	private hookFile = path.join(heronDataDir(), HOOK_LOG_NAME);
	private hookOffset = 0;
	private pollingHook = false;

	constructor(private plugin: HeronPlugin, private basePath: string, private git: ExplorerGit) {
		super();
	}

	get enabled(): boolean { return this.plugin.settings.rewind; }

	onload() {
		const app = this.plugin.app;
		app.workspace.onLayoutReady(() => { if (this.enabled) void this.start(); });
		let limits = this.limitsKey();
		this.registerEvent(this.plugin.settingsEvents.on('changed', () => {
			const key = this.limitsKey();
			if (this.enabled) void this.start().then(() => { if (key !== limits) void this.prune(); });
			limits = key;
			this.notifySoon();
		}));
		const notify = (kind: 'create' | 'modify' | 'delete' | 'rename', file: unknown, oldPath?: string) => {
			if (!(file instanceof TFile) || !this.recorder || !this.enabled) return;
			if (file.name === '.gitignore') this.recorder.clearIgnoreCache();
			this.recorder.notify(kind, file.path, oldPath);
			this.flushSoon();
		};
		this.registerEvent(app.vault.on('create', (f) => notify('create', f)));
		this.registerEvent(app.vault.on('modify', (f) => notify('modify', f)));
		this.registerEvent(app.vault.on('delete', (f) => notify('delete', f)));
		this.registerEvent(app.vault.on('rename', (f, oldPath) => notify('rename', f, oldPath)));
		this.registerEvent(app.workspace.on('file-open', (file) => {
			if (file && this.recorder && this.enabled) void this.recorder.baseline([file.path]);
		}));
		this.register(this.git.onChange(() => this.reposChanged()));
		this.registerInterval(window.setInterval(() => { void this.pollHook(); }, HOOK_POLL_MS));
		this.registerInterval(window.setInterval(() => { void this.prune(); }, PRUNE_MS));
	}

	onunload() {
		this.flushSoon.cancel();
		this.notifySoon.cancel();
		void this.recorder?.flush();
	}

	/** Opens the history store and starts recording. */
	start(): Promise<void> {
		this.starting ??= this.open().catch((err) => {
			console.error('Heron: cannot open Rewind history', err);
			this.starting = null;
		});
		return this.starting;
	}

	private async open() {
		const dir = rewindDir(this.basePath);
		const store = await HistoryStore.open(dir);
		await fsp.writeFile(path.join(dir, 'vault.json'), JSON.stringify({ vault: this.basePath }), 'utf-8');
		this.store = store;
		this.recorder = new Recorder(store, { basePath: this.basePath, repoFor: (p) => this.repoFor(p) });
		this.register(store.onAppend(() => this.invalidate()));
		const offset = store.getState(HOOK_OFFSET_KEY);
		if (typeof offset === 'number') this.hookOffset = offset;
		else await store.setState(HOOK_OFFSET_KEY, this.hookOffset = await hookLogEnd(this.hookFile));
		await this.prune();
		this.reposChanged();
		this.invalidate();
	}

	/** Calls `listener` when the history changes; returns an unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Every moment, newest first. */
	moments(): Moment[] {
		if (!this.store) return [];
		this.cached ??= buildMoments(this.store.records());
		return this.cached;
	}

	/** Stored content for `hash`, or null. */
	async readText(hash: string): Promise<string | null> {
		// Tabs restored with the workspace may ask before recording has started.
		if (!this.store) await this.start();
		return this.store?.readText(hash) ?? null;
	}

	/** Vault path of the tracked repository containing `vaultPath`, or null. */
	repoOf(vaultPath: string): string | null {
		return this.repoFor(vaultPath)?.rel ?? null;
	}

	/** Heron's code tab is about to save `text` to `vaultPath`. */
	expectWrite(vaultPath: string, text: string) {
		if (this.enabled) this.recorder?.expect(vaultPath, text);
	}

	/** Content hash of the file on disk now; null when missing, undefined when unreadable. */
	async currentHash(vaultPath: string): Promise<string | null | undefined> {
		const content = await readViewableFile(path.join(this.basePath, vaultPath));
		if (content.kind === 'text') return hashText(content.text);
		return content.kind === 'missing' ? null : undefined;
	}

	/** Records pending changes now (e.g. right after a restore). */
	async flush() {
		this.flushSoon.cancel();
		await this.recorder?.flush();
	}

	private invalidate() {
		this.cached = null;
		this.notifySoon();
	}

	private repoFor(vaultPath: string): RepoRef | null {
		return this.repos.find((r) => vaultPath.startsWith(`${r.rel}/`))?.ref ?? null;
	}

	/**
	 * Keeps the repository list current, and for each repository: the first
	 * time it is seen, catch up on changes made while Obsidian was closed and
	 * take baselines of uncommitted files; when HEAD moves, record the git
	 * operation from the reflog.
	 */
	private reposChanged() {
		const repos = this.git.vaultRepos();
		this.repos = repos.map(({ rel, snapshot }) => ({ rel, ref: { rel, repo: snapshot.kind === 'repo' ? snapshot.repo : null } }));
		if (!this.recorder || !this.enabled) return;
		for (const { rel, snapshot } of repos) {
			if (snapshot.kind !== 'repo') continue;
			const head = `${snapshot.status.branch.head ?? ''}@${snapshot.status.branch.oid ?? ''}`;
			const previous = this.heads.get(rel);
			this.heads.set(rel, head);
			if (previous !== undefined && previous !== head) {
				void this.recordGitOp(rel, snapshot.repo, snapshot.status.branch.head, snapshot.status.branch.oid);
			}
			if (!this.seenRepos.has(rel)) {
				this.seenRepos.add(rel);
				const dirty = snapshot.status.files
					.filter((f) => f.worktree !== 'D' && f.index !== 'D' && !f.path.endsWith('/'))
					.slice(0, MAX_DIRTY_BASELINES)
					.map((f) => path.relative(this.basePath, snapshot.repo.absPath(f.path)).split(path.sep).join('/'));
				void this.catchUp(rel, dirty);
			}
		}
	}

	private async catchUp(rel: string, dirty: string[]) {
		const store = this.store;
		const recorder = this.recorder;
		if (!store || !recorder) return;
		for (const p of store.knownPaths().filter((k) => k.startsWith(`${rel}/`)).slice(0, MAX_RECONCILE)) {
			recorder.notify('modify', p);
		}
		await recorder.flush();
		await recorder.baseline(dirty);
	}

	private async recordGitOp(rel: string, repo: NonNullable<RepoRef['repo']>, head: string | null, oid: string | null) {
		const subject = await repo.reflogSubject();
		if (!subject || !changesFiles(subject) || !this.store) return;
		const t = Date.now();
		await this.store.append([{ v: 1, type: 'git', id: newId(t), t, repo: rel, subject, head, oid }]);
	}

	/** Reads new Claude Code hook lines and keeps those about files in the vault. */
	private async pollHook() {
		const store = this.store;
		if (!store || !this.enabled || this.pollingHook) return;
		this.pollingHook = true;
		try {
			const { lines, offset } = await readHookLog(this.hookFile, this.hookOffset);
			if (offset === this.hookOffset) return;
			this.hookOffset = offset;
			const records = lines
				.map((line) => claudeRecordFrom(line, (abs) => this.toVaultPath(abs)))
				.filter((r): r is ClaudeRecord => !!r);
			await store.append(records);
			await store.setState(HOOK_OFFSET_KEY, offset);
		} catch (err) {
			console.error('Heron: cannot read the Claude Code hook log', err);
		} finally {
			this.pollingHook = false;
		}
	}

	private toVaultPath(absPath: string): string | null {
		const rel = path.relative(this.basePath, absPath);
		if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
		const vaultPath = rel.split(path.sep).join('/');
		return this.repoFor(vaultPath) ? vaultPath : null;
	}

	private limitsKey(): string {
		return `${this.plugin.settings.rewindMaxAgeDays}/${this.plugin.settings.rewindMaxSizeMb}`;
	}

	private async prune() {
		const store = this.store;
		if (!store) return;
		const { rewindMaxAgeDays, rewindMaxSizeMb } = this.plugin.settings;
		const { removed } = await store.prune({ maxAgeMs: rewindMaxAgeDays * 24 * 3600 * 1000, maxBytes: rewindMaxSizeMb * 1024 * 1024 });
		if (removed) this.invalidate();
	}
}
