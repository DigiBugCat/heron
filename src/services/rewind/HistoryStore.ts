import { createHash } from 'crypto';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { gunzip, gzip } from 'zlib';
import { FileRecord, LogRecord, parseRecord } from './records';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const LOG_FILE = 'log.jsonl';
const STATE_FILE = 'state.json';
const BLOB_DIR = 'blobs';

/** How long and how much history to keep. */
export interface RetentionLimits {
	maxAgeMs: number;
	maxBytes: number;
}

export const DEFAULT_MAX_AGE_DAYS = 14;
export const DEFAULT_MAX_SIZE_MB = 200;

/** SHA-256 of `text` as UTF-8, in hex. */
export function hashText(text: string): string {
	return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Rewind's history of file contents in one folder outside the vault:
 * gzipped blobs addressed by their SHA-256 (so identical content is stored
 * once) and an append-only log of records that refer to them. The log is
 * kept in memory; writes are serialized.
 */
export class HistoryStore {
	private log: LogRecord[] = [];
	/** Content each file had in its latest record: a hash, or null when deleted. */
	private latest = new Map<string, string | null>();
	/** Compressed size of each blob on disk. */
	private blobSizes = new Map<string, number>();
	private logBytes = 0;
	private queue: Promise<unknown> = Promise.resolve();
	private listeners = new Set<(records: LogRecord[]) => void>();
	private state: Record<string, unknown> = {};
	/** Blobs written since the last prune, which a record may be about to refer to. */
	private fresh = new Set<string>();

	private constructor(readonly dir: string) {}

	/** Opens (creating if needed) the store in `dir`. Malformed log lines are skipped. */
	static async open(dir: string): Promise<HistoryStore> {
		const store = new HistoryStore(dir);
		await fsp.mkdir(path.join(dir, BLOB_DIR), { recursive: true });
		await store.load();
		return store;
	}

	private async load() {
		let text = '';
		try {
			text = await fsp.readFile(path.join(this.dir, LOG_FILE), 'utf-8');
		} catch { /* new store */ }
		this.logBytes = Buffer.byteLength(text);
		for (const line of text.split('\n')) {
			const rec = parseRecord(line);
			if (rec) this.remember(rec);
		}
		try {
			const raw: unknown = JSON.parse(await fsp.readFile(path.join(this.dir, STATE_FILE), 'utf-8'));
			if (raw && typeof raw === 'object' && !Array.isArray(raw)) this.state = raw as Record<string, unknown>;
		} catch { /* no state yet */ }
		for (const prefix of await fsp.readdir(path.join(this.dir, BLOB_DIR)).catch(() => [] as string[])) {
			const sub = path.join(this.dir, BLOB_DIR, prefix);
			for (const name of await fsp.readdir(sub).catch(() => [] as string[])) {
				const stat = await fsp.stat(path.join(sub, name)).catch(() => null);
				if (stat?.isFile()) this.blobSizes.set(prefix + name.replace(/\.gz$/, ''), stat.size);
			}
		}
	}

	private remember(rec: LogRecord) {
		this.log.push(rec);
		if (rec.type !== 'file') return;
		if (rec.oldPath && rec.oldPath !== rec.path) this.latest.set(rec.oldPath, null);
		this.latest.set(rec.path, rec.after);
	}

	/** Every record, oldest first. */
	records(): readonly LogRecord[] { return this.log; }

	/** File records only, oldest first. */
	fileRecords(): FileRecord[] {
		return this.log.filter((r): r is FileRecord => r.type === 'file');
	}

	/**
	 * The content hash a file had in its latest record, null if it was
	 * deleted, or undefined when Rewind has never seen it.
	 */
	lastKnown(vaultPath: string): string | null | undefined {
		return this.latest.get(vaultPath);
	}

	/** Vault paths with a known current content. */
	knownPaths(): string[] {
		return [...this.latest].filter(([, hash]) => hash !== null).map(([p]) => p);
	}

	/** Total size on disk: compressed blobs plus the log, in bytes. */
	sizeOnDisk(): number {
		let total = this.logBytes;
		for (const size of this.blobSizes.values()) total += size;
		return total;
	}

	/** Calls `listener` with each batch of appended records; returns an unsubscribe function. */
	onAppend(listener: (records: LogRecord[]) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Small persistent values (e.g. how far the hook log was read). */
	getState(key: string): unknown { return this.state[key]; }

	setState(key: string, value: unknown): Promise<void> {
		this.state[key] = value;
		const snapshot = JSON.stringify(this.state);
		return this.serial(() => this.writeAtomic(STATE_FILE, snapshot));
	}

	/** Stores `text` (once per distinct content) and returns its hash. */
	putText(text: string): Promise<string> {
		const hash = hashText(text);
		if (this.blobSizes.has(hash)) return Promise.resolve(hash);
		return this.serial(async () => {
			if (this.blobSizes.has(hash)) return hash;
			const data = await gzipAsync(Buffer.from(text, 'utf-8'));
			await fsp.mkdir(path.dirname(this.blobPath(hash)), { recursive: true });
			await fsp.writeFile(this.blobPath(hash), data);
			this.blobSizes.set(hash, data.length);
			this.fresh.add(hash);
			return hash;
		});
	}

	/** The text stored under `hash`, or null when it is missing (e.g. pruned). */
	async readText(hash: string): Promise<string | null> {
		try {
			return (await gunzipAsync(await fsp.readFile(this.blobPath(hash)))).toString('utf-8');
		} catch {
			return null;
		}
	}

	/** True when the blob for `hash` is stored. */
	hasBlob(hash: string): boolean { return this.blobSizes.has(hash); }

	/** Appends records to the log. */
	append(records: LogRecord[]): Promise<void> {
		if (!records.length) return Promise.resolve();
		return this.serial(async () => {
			const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
			await fsp.appendFile(path.join(this.dir, LOG_FILE), text, 'utf-8');
			this.logBytes += Buffer.byteLength(text);
			for (const r of records) this.remember(r);
			for (const listener of this.listeners) listener(records);
		});
	}

	/**
	 * Drops history older than `maxAgeMs`, then the oldest changes until the
	 * store fits in `maxBytes`, and deletes blobs nothing refers to. The
	 * latest content of each file is kept as a baseline while space allows,
	 * so its next change can still be diffed.
	 */
	prune(limits: RetentionLimits, now = Date.now()): Promise<{ removed: number }> {
		return this.serial(async () => {
			const kept = planPrune(this.log, this.blobSizes, limits, now);
			const removed = this.log.length - kept.length;
			const referenced = new Set<string>();
			for (const r of kept) {
				if (r.type !== 'file') continue;
				if (r.before) referenced.add(r.before);
				if (r.after) referenced.add(r.after);
			}
			const unreferenced = [...this.blobSizes.keys()].filter((h) => !referenced.has(h) && !this.fresh.has(h));
			this.fresh.clear();
			if (removed === 0 && unreferenced.length === 0) return { removed: 0 };
			const text = kept.map((r) => JSON.stringify(r) + '\n').join('');
			await this.writeAtomic(LOG_FILE, text);
			for (const hash of unreferenced) {
				await fsp.rm(this.blobPath(hash), { force: true });
				this.blobSizes.delete(hash);
			}
			this.log = [];
			this.latest.clear();
			this.logBytes = Buffer.byteLength(text);
			for (const r of kept) this.remember(r);
			return { removed };
		});
	}

	private blobPath(hash: string): string {
		return path.join(this.dir, BLOB_DIR, hash.slice(0, 2), `${hash.slice(2)}.gz`);
	}

	private async writeAtomic(name: string, text: string) {
		const target = path.join(this.dir, name);
		const tmp = `${target}.tmp`;
		await fsp.writeFile(tmp, text, 'utf-8');
		await fsp.rename(tmp, target);
	}

	/** Runs `task` after every earlier write has finished. */
	private serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task, task);
		this.queue = run.catch(() => undefined);
		return run;
	}
}

/**
 * Which records survive pruning, in order. Pure, for testing:
 * 1. Records older than the age limit go, except each file's latest
 *    record, which becomes a baseline (its content, not a change).
 * 2. While the blobs still referenced exceed `maxBytes`, the oldest file
 *    records go (baselines kept from step 1 are among the oldest).
 */
export function planPrune(
	log: readonly LogRecord[],
	blobSizes: ReadonlyMap<string, number>,
	limits: RetentionLimits,
	now: number,
): LogRecord[] {
	const cutoff = now - limits.maxAgeMs;
	const newestByPath = new Map<string, FileRecord>();
	for (const r of log) if (r.type === 'file') newestByPath.set(r.path, r);

	let kept: LogRecord[] = [];
	for (const r of log) {
		if (r.t >= cutoff) {
			kept.push(r);
		} else if (r.type === 'file' && newestByPath.get(r.path) === r && r.after) {
			kept.push({ v: 1, type: 'file', id: r.id, t: r.t, repo: r.repo, path: r.path, kind: 'baseline', before: null, after: r.after });
		}
	}

	const refs = new Map<string, number>();
	const ref = (hash: string | null, delta: number) => {
		if (hash) refs.set(hash, (refs.get(hash) ?? 0) + delta);
	};
	for (const r of kept) {
		if (r.type !== 'file') continue;
		ref(r.before, 1);
		ref(r.after, 1);
	}
	let bytes = 0;
	for (const hash of refs.keys()) bytes += blobSizes.get(hash) ?? 0;
	if (bytes <= limits.maxBytes) return kept;

	const dropped = new Set<LogRecord>();
	const drop = (r: FileRecord) => {
		dropped.add(r);
		for (const hash of [r.before, r.after]) {
			if (!hash) continue;
			const n = (refs.get(hash) ?? 0) - 1;
			refs.set(hash, n);
			if (n === 0) bytes -= blobSizes.get(hash) ?? 0;
		}
	};
	const oldestFirst = kept.filter((r): r is FileRecord => r.type === 'file').sort((a, b) => a.t - b.t);
	for (const r of oldestFirst) {
		if (bytes <= limits.maxBytes) break;
		drop(r);
	}
	kept = kept.filter((r) => !dropped.has(r));
	return kept;
}
