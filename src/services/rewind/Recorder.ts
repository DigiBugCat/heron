import * as path from 'path';
import type { GitRepo } from '../../git/GitRepo';
import { MAX_VIEW_BYTES, readViewableFile } from '../../utils/content';
import { hashText, HistoryStore } from './HistoryStore';
import { FileRecord, newId } from './records';

/** How long Heron's own write is expected to show up as a file change, in ms. */
const EXPECT_MS = 10_000;
/** Folder names whose files are never recorded. */
const EXCLUDED_SEGMENTS = new Set(['node_modules', '.git']);
/** Cached `git check-ignore` answers kept before starting over. */
const MAX_IGNORE_CACHE = 20_000;

/** The tracked repository a file belongs to. */
export interface RepoRef {
	/** Vault path of the repository folder. */
	rel: string;
	/** The opened repository, or null while git status is still loading. */
	repo: GitRepo | null;
}

export interface RecorderHost {
	/** The vault's folder on disk. */
	basePath: string;
	/** The tracked repository containing `vaultPath`, or null to ignore the file. */
	repoFor(vaultPath: string): RepoRef | null;
	now?: () => number;
	/** Larger files are not recorded; defaults to the viewer's limit. */
	maxBytes?: number;
}

export type ChangeNotice = 'create' | 'modify' | 'delete' | 'rename';

interface Pending {
	kind: ChangeNotice;
	path: string;
	oldPath?: string;
	t: number;
}

interface Expectation {
	hash: string | null;
	label?: string;
	group?: string;
	until: number;
}

/** True for paths Rewind never records: anything inside `node_modules` or `.git`. */
export function isExcludedPath(vaultPath: string): boolean {
	return vaultPath.split('/').some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

type DiskState = { kind: 'text'; text: string } | { kind: 'missing' } | { kind: 'skip' };

/**
 * Turns file notifications (from Obsidian's vault events) into history
 * records. Notifications are queued and processed by `flush`, which compares
 * each file on disk with the last content Rewind knew, so bursts and
 * editors' save tricks (delete then create) collapse into one change.
 *
 * The first time a file is seen, its previous content comes from the git
 * index; files that are binary, too large, git-ignored or inside
 * `node_modules` are skipped.
 */
export class Recorder {
	private pending: Pending[] = [];
	private expectations = new Map<string, Expectation>();
	private ignoredCache = new Map<string, boolean>();
	private flushing: Promise<number> = Promise.resolve(0);

	constructor(private store: HistoryStore, private host: RecorderHost) {}

	private now(): number { return this.host.now?.() ?? Date.now(); }

	/** Queues a change to `vaultPath` (and from `oldPath`, for renames). */
	notify(kind: ChangeNotice, vaultPath: string, oldPath?: string) {
		if (isExcludedPath(vaultPath) && (!oldPath || isExcludedPath(oldPath))) return;
		if (!this.host.repoFor(vaultPath) && !(oldPath && this.host.repoFor(oldPath))) return;
		this.pending.push({ kind, path: vaultPath, oldPath, t: this.now() });
	}

	/** True when notifications are waiting for `flush`. */
	hasPending(): boolean { return this.pending.length > 0; }

	/**
	 * Heron is about to write `text` to `vaultPath` (null: delete it). The
	 * change is recorded as Heron's, with `label` and `group` if given.
	 */
	expect(vaultPath: string, text: string | null, meta: { label?: string; group?: string } = {}) {
		this.expectations.set(vaultPath, { hash: text === null ? null : hashText(text), ...meta, until: this.now() + EXPECT_MS });
	}

	/** Forgets cached `git check-ignore` answers, e.g. after a .gitignore changed. */
	clearIgnoreCache() { this.ignoredCache.clear(); }

	/** Processes queued notifications; resolves to the number of records written. */
	flush(): Promise<number> {
		const run = this.flushing.then(() => this.flushOnce(), () => this.flushOnce());
		this.flushing = run.catch(() => 0);
		return run;
	}

	/**
	 * Records the current content of files Rewind has never seen, so their
	 * first change can be diffed. Already known files are left alone.
	 */
	async baseline(vaultPaths: string[]): Promise<number> {
		const records: FileRecord[] = [];
		for (const vaultPath of vaultPaths) {
			const ref = this.host.repoFor(vaultPath);
			if (!ref || isExcludedPath(vaultPath) || this.store.lastKnown(vaultPath) !== undefined) continue;
			const disk = await this.readDisk(vaultPath);
			if (disk.kind !== 'text') continue;
			const after = await this.store.putText(disk.text);
			const t = this.now();
			records.push({ v: 1, type: 'file', id: newId(t), t, repo: ref.rel, path: vaultPath, kind: 'baseline', before: null, after });
		}
		await this.store.append(records);
		return records.length;
	}

	private async flushOnce(): Promise<number> {
		const batch = this.pending.splice(0);
		if (!batch.length) return 0;
		const now = this.now();
		for (const [p, e] of this.expectations) if (e.until < now) this.expectations.delete(p);

		// Net renames (a → b → c is a → c) and the first time each path was touched.
		const renames = new Map<string, { oldPath: string; t: number }>();
		const touched = new Map<string, number>();
		for (const n of batch) {
			if (!touched.has(n.path)) touched.set(n.path, n.t);
			if (n.kind !== 'rename' || !n.oldPath) continue;
			if (!touched.has(n.oldPath)) touched.set(n.oldPath, n.t);
			const earlier = renames.get(n.oldPath);
			renames.delete(n.oldPath);
			renames.set(n.path, { oldPath: earlier?.oldPath ?? n.oldPath, t: earlier?.t ?? n.t });
		}

		const ignored = await this.ignoredPaths([...touched.keys()]);
		const skip = (p: string) => isExcludedPath(p) || ignored.has(p) || !this.host.repoFor(p);
		const records: FileRecord[] = [];
		const handled = new Set<string>();

		for (const [to, { oldPath, t }] of renames) {
			handled.add(to);
			handled.add(oldPath);
			if (skip(to) && skip(oldPath)) continue;
			if (oldPath === to) {
				handled.delete(to);
				continue;
			}
			const disk = await this.readDisk(to);
			if (disk.kind === 'skip') continue;
			const before = await this.knownContent(oldPath);
			const after = disk.kind === 'text' ? await this.store.putText(disk.text) : null;
			if (before === undefined && after === null) continue;
			const ref = this.host.repoFor(to) ?? this.host.repoFor(oldPath);
			if (!ref) continue;
			records.push(this.record(t, ref.rel, to, after === null ? 'delete' : 'rename', before ?? null, after, oldPath));
		}

		for (const [p, t] of touched) {
			if (handled.has(p) || skip(p)) continue;
			const ref = this.host.repoFor(p);
			if (!ref) continue;
			const disk = await this.readDisk(p);
			if (disk.kind === 'skip') continue;
			const after = disk.kind === 'text' ? await this.store.putText(disk.text) : null;
			const before = await this.knownContent(p);
			if (before === undefined && after === null) continue;
			if ((before ?? null) === after) continue;
			const kind = before == null ? 'create' : after === null ? 'delete' : 'modify';
			records.push(this.record(t, ref.rel, p, kind, before ?? null, after));
		}

		await this.store.append(records);
		return records.length;
	}

	private record(t: number, repo: string, vaultPath: string, kind: FileRecord['kind'], before: string | null, after: string | null, oldPath?: string): FileRecord {
		const rec: FileRecord = { v: 1, type: 'file', id: newId(t), t, repo, path: vaultPath, kind, before, after };
		if (oldPath) rec.oldPath = oldPath;
		const expected = this.expectations.get(vaultPath);
		if (expected && expected.hash === after) {
			this.expectations.delete(vaultPath);
			rec.source = 'heron';
			if (expected.label) rec.label = expected.label;
			if (expected.group) rec.group = expected.group;
		}
		return rec;
	}

	/**
	 * The content a file had before this change: the last one recorded, else
	 * the git index's copy (stored as a blob), else null for a file git does
	 * not know. Undefined when there is nothing to go on.
	 */
	private async knownContent(vaultPath: string): Promise<string | null | undefined> {
		const known = this.store.lastKnown(vaultPath);
		if (known !== undefined) return known;
		const ref = this.host.repoFor(vaultPath);
		const repo = ref?.repo;
		if (!repo) return undefined;
		const repoPath = repo.repoPath(path.join(this.host.basePath, vaultPath));
		if (!repoPath) return undefined;
		const blob = await repo.readBlob(`:${repoPath}`);
		if (blob.kind === 'text') return this.store.putText(blob.text);
		return blob.kind === 'missing' ? null : undefined;
	}

	private async readDisk(vaultPath: string): Promise<DiskState> {
		const content = await readViewableFile(path.join(this.host.basePath, vaultPath), this.host.maxBytes ?? MAX_VIEW_BYTES);
		if (content.kind === 'text') return content;
		if (content.kind === 'missing') return content;
		return { kind: 'skip' };
	}

	/** Vault paths among `vaultPaths` that git ignores, asking git once per uncached path. */
	private async ignoredPaths(vaultPaths: string[]): Promise<Set<string>> {
		const byRepo = new Map<GitRepo, Map<string, string>>();
		if (this.ignoredCache.size > MAX_IGNORE_CACHE) this.ignoredCache.clear();
		for (const p of vaultPaths) {
			if (this.ignoredCache.has(p) || isExcludedPath(p)) continue;
			const repo = this.host.repoFor(p)?.repo;
			const repoPath = repo?.repoPath(path.join(this.host.basePath, p));
			if (!repo || !repoPath) continue;
			let paths = byRepo.get(repo);
			if (!paths) byRepo.set(repo, paths = new Map<string, string>());
			paths.set(repoPath, p);
		}
		for (const [repo, paths] of byRepo) {
			const ignored = await repo.ignored([...paths.keys()]);
			for (const [repoPath, vaultPath] of paths) this.ignoredCache.set(vaultPath, ignored.has(repoPath));
		}
		return new Set(vaultPaths.filter((p) => this.ignoredCache.get(p) === true));
	}
}
