import { appendFileSync, readdirSync } from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashText, HistoryStore, planPrune } from '../src/services/rewind/HistoryStore';
import { FileRecord, LogRecord, parseRecord } from '../src/services/rewind/records';
import { sanitizeSettings } from '../src/settings';
import { appDataDir, rewindDir } from '../src/utils/appData';
import { remove, tempDir } from './helpers';

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) remove(cleanup.pop() ?? ''); });

function storeDir(): string {
	const dir = tempDir('heron-rewind-');
	cleanup.push(dir);
	return dir;
}

const DAY = 24 * 3600 * 1000;

function file(id: string, t: number, p: string, before: string | null, after: string | null, extra: Partial<FileRecord> = {}): FileRecord {
	return { v: 1, type: 'file', id, t, repo: 'Code/app', path: p, kind: before === null ? 'create' : after === null ? 'delete' : 'modify', before, after, ...extra };
}

function blobCount(dir: string): number {
	return readdirSync(path.join(dir, 'blobs')).reduce((n, sub) => n + readdirSync(path.join(dir, 'blobs', sub)).length, 0);
}

describe('history store', () => {
	it('stores each distinct content once and reads it back', async () => {
		const dir = storeDir();
		const store = await HistoryStore.open(dir);
		const a = await store.putText('hello\n');
		const again = await store.putText('hello\n');
		const b = await store.putText('world\n');
		expect(a).toBe(hashText('hello\n'));
		expect(again).toBe(a);
		expect(b).not.toBe(a);
		expect(blobCount(dir)).toBe(2);
		expect(await store.readText(a)).toBe('hello\n');
		expect(await store.readText('0'.repeat(64))).toBeNull();
	});

	it('keeps the log across reopening and skips malformed lines', async () => {
		const dir = storeDir();
		const store = await HistoryStore.open(dir);
		const h1 = await store.putText('one');
		const h2 = await store.putText('two');
		await store.append([file('1', 1000, 'Code/app/a.ts', null, h1), file('2', 2000, 'Code/app/a.ts', h1, h2)]);
		appendFileSync(path.join(dir, 'log.jsonl'), 'not json\n{"v":99,"type":"file"}\n{"v":1,"type":"fi');
		await store.setState('offset', 42);

		const reopened = await HistoryStore.open(dir);
		expect(reopened.records().map((r) => r.id)).toEqual(['1', '2']);
		expect(reopened.lastKnown('Code/app/a.ts')).toBe(h2);
		expect(reopened.lastKnown('Code/app/other.ts')).toBeUndefined();
		expect(reopened.getState('offset')).toBe(42);
		expect(reopened.sizeOnDisk()).toBeGreaterThan(0);
	});

	it('tracks the latest content through renames and deletes', async () => {
		const store = await HistoryStore.open(storeDir());
		const h = await store.putText('x');
		await store.append([
			file('1', 1, 'Code/app/a.ts', null, h),
			{ ...file('2', 2, 'Code/app/b.ts', h, h), kind: 'rename', oldPath: 'Code/app/a.ts' },
			file('3', 3, 'Code/app/c.ts', null, h),
			file('4', 4, 'Code/app/c.ts', h, null),
		]);
		expect(store.lastKnown('Code/app/a.ts')).toBeNull();
		expect(store.lastKnown('Code/app/b.ts')).toBe(h);
		expect(store.lastKnown('Code/app/c.ts')).toBeNull();
		expect(store.knownPaths()).toEqual(['Code/app/b.ts']);
	});

	it('tells listeners about appended records', async () => {
		const store = await HistoryStore.open(storeDir());
		const seen: LogRecord[][] = [];
		const off = store.onAppend((records) => seen.push(records));
		await store.append([file('1', 1, 'Code/app/a.ts', null, null)]);
		off();
		await store.append([file('2', 2, 'Code/app/a.ts', null, null)]);
		expect(seen.map((batch) => batch.map((r) => r.id))).toEqual([['1']]);
	});
});

describe('pruning', () => {
	it('drops old changes but keeps each file’s latest content as a baseline', async () => {
		const dir = storeDir();
		const store = await HistoryStore.open(dir);
		const now = 100 * DAY;
		const v1 = await store.putText('v1');
		const v2 = await store.putText('v2');
		const v3 = await store.putText('v3');
		const old = await store.putText('only in an old change');
		await store.append([
			file('1', now - 30 * DAY, 'Code/app/a.ts', null, v1),
			file('2', now - 20 * DAY, 'Code/app/a.ts', v1, v2),
			file('3', now - 1 * DAY, 'Code/app/a.ts', v2, v3),
			file('4', now - 40 * DAY, 'Code/app/b.ts', old, v1),
			{ v: 1, type: 'git', id: 'g', t: now - 30 * DAY, repo: 'Code/app', subject: 'checkout: moving from a to b', head: 'b', oid: null },
		]);
		await store.putText('written but never referenced');

		const { removed } = await store.prune({ maxAgeMs: 14 * DAY, maxBytes: 1e9 }, now);
		expect(removed).toBe(3);
		const records = store.records();
		expect(records.map((r) => r.id)).toEqual(['3', '4']);
		expect(records[1]).toMatchObject({ kind: 'baseline', path: 'Code/app/b.ts', before: null, after: v1 });
		expect(store.lastKnown('Code/app/b.ts')).toBe(v1);
		// Blobs written since the last prune are kept, since a record may be about to use them.
		expect(store.hasBlob(old)).toBe(true);
		expect(store.hasBlob(hashText('written but never referenced'))).toBe(true);

		const reopened = await HistoryStore.open(dir);
		expect(reopened.records().map((r) => r.id)).toEqual(['3', '4']);
		await reopened.prune({ maxAgeMs: 14 * DAY, maxBytes: 1e9 }, now);
		// v2 is still referenced by change 3; blobs nothing refers to are gone.
		expect(await reopened.readText(v2)).toBe('v2');
		expect(await reopened.readText(old)).toBeNull();
		expect(reopened.hasBlob(hashText('written but never referenced'))).toBe(false);
		expect(blobCount(dir)).toBe(3);
	});

	it('drops the oldest records first to fit the size limit', () => {
		const sizes = new Map([['a'.repeat(64), 100], ['b'.repeat(64), 100], ['c'.repeat(64), 100], ['d'.repeat(64), 100]]);
		const [a, b, c, d] = [...sizes.keys()] as [string, string, string, string];
		const log: LogRecord[] = [
			{ ...file('base', 1, 'Code/app/x.ts', null, d), kind: 'baseline' },
			file('1', 2, 'Code/app/a.ts', null, a),
			file('2', 3, 'Code/app/a.ts', a, b),
			file('3', 4, 'Code/app/a.ts', b, c),
		];
		const limits = (maxBytes: number) => ({ maxAgeMs: 1e12, maxBytes });
		expect(planPrune(log, sizes, limits(400), 10).map((r) => r.id)).toEqual(['base', '1', '2', '3']);
		// Dropping the baseline frees d; change 1 frees nothing (a is still used by 2); change 2 frees a.
		expect(planPrune(log, sizes, limits(300), 10).map((r) => r.id)).toEqual(['1', '2', '3']);
		expect(planPrune(log, sizes, limits(200), 10).map((r) => r.id)).toEqual(['3']);
	});
});

describe('records and settings', () => {
	it('parses valid records and rejects malformed ones', () => {
		const h = 'e'.repeat(64);
		expect(parseRecord(JSON.stringify(file('1', 5, 'a', null, h, { source: 'heron', label: 'Restored a', group: 'restore:1' }))))
			.toMatchObject({ source: 'heron', label: 'Restored a', group: 'restore:1' });
		expect(parseRecord(JSON.stringify({ ...file('1', 5, 'a', null, 'nothex'), after: 'nothex' }))).toBeNull();
		expect(parseRecord(JSON.stringify({ v: 1, type: 'claude', id: 'c', t: 1, session: 's', tool: 'Edit', files: ['a', 3] })))
			.toMatchObject({ files: ['a'], turn: null, prompt: null });
		expect(parseRecord(JSON.stringify({ v: 1, type: 'unknown', id: 'x', t: 1 }))).toBeNull();
		expect(parseRecord('')).toBeNull();
	});

	it('defaults and clamps the retention settings', () => {
		expect(sanitizeSettings({})).toMatchObject({ rewind: true, rewindMaxAgeDays: 14, rewindMaxSizeMb: 200, rewindPanelAdded: false });
		expect(sanitizeSettings({ rewind: false, rewindMaxAgeDays: 0, rewindMaxSizeMb: 1e9 })).toMatchObject({ rewind: false, rewindMaxAgeDays: 1, rewindMaxSizeMb: 10000 });
	});

	it('keeps history outside the vault, in a folder per vault', () => {
		expect(appDataDir({}, 'darwin')).toMatch(/Library[/\\]Application Support$/);
		expect(appDataDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32')).toBe('C:\\Users\\me\\AppData\\Roaming');
		expect(appDataDir({ XDG_DATA_HOME: '/data' }, 'linux')).toBe('/data');
		const a = rewindDir('/vaults/one', '/root');
		expect(a).toMatch(/^[/\\]root[/\\]rewind[/\\][0-9a-f]{16}$/);
		expect(rewindDir('/vaults/one', '/root')).toBe(a);
		expect(rewindDir('/vaults/two', '/root')).not.toBe(a);
	});
});
