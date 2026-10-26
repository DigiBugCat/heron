import { describe, expect, it } from 'vitest';
import { attribute, AttributedChange, changesFiles, gitOpLabel } from '../src/services/rewind/attribution';
import { groupMoments, momentsForFile, momentsForRepo, netFiles, QUIET_GAP_MS } from '../src/services/rewind/moments';
import type { ClaudeRecord, FileRecord, GitRecord } from '../src/services/rewind/records';
import { buildMoments } from '../src/services/rewind/timeline';

const H = (c: string) => c.repeat(64);
const [A, B, C, D] = [H('a'), H('b'), H('c'), H('d')];

let seq = 0;
function change(t: number, p: string, before: string | null, after: string | null, extra: Partial<FileRecord> = {}): FileRecord {
	return {
		v: 1, type: 'file', id: `f${++seq}`, t, repo: 'Code/app', path: `Code/app/${p}`,
		kind: before === null ? 'create' : after === null ? 'delete' : 'modify', before, after, ...extra,
	};
}

function claude(t: number, files: string[], turn: number | null = 1, prompt: string | null = 'add retry to mail sender', session = 's1'): ClaudeRecord {
	return { v: 1, type: 'claude', id: `c${++seq}`, t, session, turn, prompt, tool: 'Edit', files: files.map((f) => `Code/app/${f}`) };
}

function git(t: number, subject: string, repo = 'Code/app'): GitRecord {
	return { v: 1, type: 'git', id: `g${++seq}`, t, repo, subject, head: null, oid: null };
}

function external(c: FileRecord): AttributedChange {
	return { ...c, source: 'external' };
}

describe('attribution', () => {
	it('credits Claude when its hook line follows the change to that file', () => {
		const edit = change(10_000, 'mail.ts', A, B);
		const other = change(10_000, 'other.ts', A, B);
		const tooEarly = change(10_000 - 30_000, 'mail.ts', B, C);
		const [e, o, early] = attribute([edit, other, tooEarly], [claude(11_000, ['mail.ts'])], []);
		expect(e?.source).toBe('claude');
		expect(e?.claude?.prompt).toBe('add retry to mail sender');
		expect(o?.source).toBe('external');
		expect(early?.source).toBe('external');
	});

	it('picks the closest hook line when several match', () => {
		const edit = change(10_000, 'mail.ts', A, B);
		const near = claude(10_500, ['mail.ts'], 2, 'second');
		const [e] = attribute([edit], [claude(18_000, ['mail.ts'], 1, 'first'), near], []);
		expect(e?.claude).toBe(near);
	});

	it('credits git for changes around a HEAD move in the same repository', () => {
		const changes = [change(1_000, 'a.ts', A, B), change(9_000, 'b.ts', A, B), change(30_000, 'c.ts', A, B)];
		const op = git(10_000, 'checkout: moving from main to feature');
		const result = attribute(changes, [], [op, git(10_000, 'pull: Fast-forward', 'Code/other')]);
		expect(result.map((r) => r.source)).toEqual(['git', 'git', 'external']);
		expect(result[0]?.git).toBe(op);
	});

	it('trusts Heron’s own writes over any other evidence, and skips baselines', () => {
		const save = change(10_000, 'mail.ts', A, B, { source: 'heron' });
		const base = change(5_000, 'x.ts', null, A, { kind: 'baseline' });
		const result = attribute([save, base], [claude(10_000, ['mail.ts'])], [git(10_000, 'reset: moving to HEAD~1')]);
		expect(result).toHaveLength(1);
		expect(result[0]?.source).toBe('heron');
	});

	it('labels git operations from the reflog', () => {
		expect(gitOpLabel('checkout: moving from main to feature/x')).toBe('git checkout feature/x');
		expect(gitOpLabel('reset: moving to HEAD~1')).toBe('git reset HEAD~1');
		expect(gitOpLabel('pull: Fast-forward')).toBe('git pull');
		expect(gitOpLabel('pull --rebase (finish): returning to refs/heads/main')).toBe('git pull');
		expect(gitOpLabel('merge feature: Merge made by the \'ort\' strategy.')).toBe('git merge feature');
		expect(gitOpLabel('rebase (finish): returning to refs/heads/main')).toBe('git rebase');
		expect(changesFiles('commit: Fix the thing')).toBe(false);
		expect(changesFiles('commit (amend): Fix')).toBe(false);
		expect(changesFiles('checkout: moving from a to b')).toBe(true);
	});
});

describe('moments', () => {
	it('groups one Claude turn into one moment, even with other changes in between', () => {
		const c1 = claude(1_000, ['a.ts', 'b.ts'], 3);
		const changes: AttributedChange[] = [
			{ ...change(900, 'a.ts', A, B), source: 'claude', claude: c1 },
			{ ...change(2_000, 'notes.ts', A, B), source: 'heron' },
			{ ...change(95_000, 'b.ts', null, C), source: 'claude', claude: { ...c1, id: 'later', t: 95_000 } },
			{ ...change(120_000, 'c.ts', A, B), source: 'claude', claude: claude(120_000, ['c.ts'], 4, 'now do the tests') },
		];
		const moments = groupMoments(changes);
		expect(moments.map((m) => m.label)).toEqual([
			'Claude: now do the tests · c.ts',
			'Claude: add retry to mail sender · 2 files',
			'You saved notes.ts',
		]);
		expect(moments[1]?.files.map((f) => [f.path, f.kind])).toEqual([['Code/app/a.ts', 'modify'], ['Code/app/b.ts', 'create']]);
		expect(moments[1]?.start).toBe(900);
		expect(moments[1]?.end).toBe(95_000);
	});

	it('splits saves and outside edits at a quiet gap', () => {
		const t0 = 1_000_000;
		const changes = [
			external(change(t0, 'a.ts', A, B)),
			external(change(t0 + 10_000, 'b.ts', A, B)),
			external(change(t0 + 10_000 + QUIET_GAP_MS + 1, 'a.ts', B, C)),
		];
		const moments = groupMoments(changes);
		expect(moments.map((m) => m.label)).toEqual(['Changed a.ts', 'Changed 2 files']);
	});

	it('groups a git operation and labels it', () => {
		const op = git(5_000, 'checkout: moving from feature to main');
		const changes: AttributedChange[] = ['a.ts', 'b.ts', 'c.ts'].map((p, i) => ({ ...change(4_000 + i, p, A, B), source: 'git', git: op }));
		expect(groupMoments(changes).map((m) => m.label)).toEqual(['git checkout main · 3 files']);
	});

	it('keeps a restore together under its label', () => {
		const changes: AttributedChange[] = [
			{ ...change(1_000, 'a.ts', B, A, { label: 'Undid “Claude: x”', group: 'restore:1' }), source: 'heron' },
			{ ...change(1_200, 'b.ts', C, null, { label: 'Undid “Claude: x”', group: 'restore:1' }), source: 'heron' },
			{ ...change(1_100, 'c.ts', A, B), source: 'heron' },
		];
		expect(groupMoments(changes).map((m) => m.label)).toEqual(['Undid “Claude: x”', 'You saved c.ts']);
	});

	it('labels single outside changes by what happened', () => {
		const label = (c: FileRecord) => groupMoments([external(c)])[0]?.label;
		expect(label(change(1, 'new.ts', null, A))).toBe('Created new.ts');
		expect(label(change(1, 'old.ts', A, null))).toBe('Deleted old.ts');
		expect(label(change(1, 'b.ts', A, A, { kind: 'rename', oldPath: 'Code/app/a.ts' }))).toBe('Renamed a.ts → b.ts');
	});

	it('follows renames and drops files that end where they started', () => {
		const files = netFiles([
			external(change(1, 'a.ts', A, B)),
			external(change(2, 'b.ts', B, C, { kind: 'rename', oldPath: 'Code/app/a.ts' })),
			external(change(3, 'x.ts', A, B)),
			external(change(4, 'x.ts', B, A)),
		]);
		expect(files).toEqual([{ path: 'Code/app/b.ts', oldPath: 'Code/app/a.ts', kind: 'rename', before: A, after: C }]);
		expect(groupMoments([external(change(3, 'x.ts', A, B)), external(change(4, 'x.ts', B, A))])).toEqual([]);
	});

	it('filters moments by file (including its old name) and by repository', () => {
		const moments = groupMoments([
			external(change(1, 'b.ts', A, A, { kind: 'rename', oldPath: 'Code/app/a.ts' })),
			{ ...external(change(100_000, 'z.ts', A, D)), repo: 'Code/other', path: 'Code/other/z.ts' },
		]);
		expect(momentsForFile(moments, 'Code/app/a.ts')).toHaveLength(1);
		expect(momentsForFile(moments, 'Code/app/b.ts')).toHaveLength(1);
		expect(momentsForRepo(moments, 'Code/other').map((m) => m.label)).toEqual(['Changed z.ts']);
	});

	it('builds moments from a raw log', () => {
		const log = [
			change(1_000, 'mail.ts', A, B),
			claude(1_500, ['mail.ts'], 1, 'add retry'),
			change(60_000, 'mail.ts', B, C, { source: 'heron' }),
		];
		expect(buildMoments(log).map((m) => [m.source, m.label])).toEqual([
			['heron', 'You saved mail.ts'],
			['claude', 'Claude: add retry · mail.ts'],
		]);
	});

	it('shortens long prompts in labels', () => {
		const prompt = 'please refactor the entire mail sender module so that it retries with exponential backoff';
		const [m] = groupMoments([{ ...change(1, 'mail.ts', A, B), source: 'claude', claude: claude(1, ['mail.ts'], 1, prompt) }]);
		expect(m?.label).toMatch(/^Claude: please refactor .{20,}… · mail\.ts$/);
		expect(m?.label.length).toBeLessThan(80);
	});
});
