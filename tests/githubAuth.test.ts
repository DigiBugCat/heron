import { readFileSync, statSync } from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	fileTokenStore, ghTokenReader, secretId, secretStorageStore, TokenResolver, TokenStore, tokenStoreFor,
} from '../src/github/auth';
import { GitHubService } from '../src/github/service';
import type { HttpRequest, HttpResponse } from '../src/github/client';
import { remove, tempDir } from './helpers';

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) remove(cleanup.pop() ?? ''); });

function memoryStore(initial: Record<string, string> = {}): TokenStore {
	const tokens = { ...initial };
	return {
		kind: 'keychain',
		get: (host) => Promise.resolve(tokens[host] || null),
		set: (host, token) => {
			tokens[host] = token;
			return Promise.resolve();
		},
	};
}

describe('token resolution', () => {
	it('prefers a pasted token over the GitHub CLI', async () => {
		const gh = vi.fn(() => Promise.resolve('gho_cli'));
		const resolver = new TokenResolver(memoryStore({ 'github.com': 'ghp_pasted' }), gh);
		expect(await resolver.resolve('github.com')).toEqual({ token: 'ghp_pasted', source: 'settings' });
		expect(gh).not.toHaveBeenCalled();
	});

	it('falls back to the GitHub CLI for the same host, asking it once', async () => {
		const gh = vi.fn((host: string) => Promise.resolve(host === 'github.example.com' ? 'gho_cli' : null));
		const resolver = new TokenResolver(memoryStore(), gh);
		expect(await resolver.resolve('github.example.com')).toEqual({ token: 'gho_cli', source: 'gh' });
		expect(await resolver.resolve('github.example.com')).toEqual({ token: 'gho_cli', source: 'gh' });
		expect(gh).toHaveBeenCalledTimes(1);
		expect(gh).toHaveBeenCalledWith('github.example.com');
		resolver.forget('github.example.com');
		await resolver.resolve('github.example.com');
		expect(gh).toHaveBeenCalledTimes(2);
	});

	it('reports no token when neither source has one, even if the CLI fails', async () => {
		const resolver = new TokenResolver(memoryStore(), () => Promise.reject(new Error('boom')));
		expect(await resolver.resolve('github.com')).toEqual({ token: null, source: 'none' });
	});

	it('uses a newly pasted token and goes back to the CLI when it is removed', async () => {
		const resolver = new TokenResolver(memoryStore(), () => Promise.resolve('gho_cli'));
		await resolver.save('github.com', '  ghp_new  ');
		expect(await resolver.resolve('github.com')).toEqual({ token: 'ghp_new', source: 'settings' });
		await resolver.save('github.com', '');
		expect(await resolver.resolve('github.com')).toEqual({ token: 'gho_cli', source: 'gh' });
	});
});

describe('GitHub CLI tokens', () => {
	it('runs gh auth token for the host with the login shell PATH', async () => {
		const exec = vi.fn((_file: string, _args: string[], _opts: { env: NodeJS.ProcessEnv }, cb: (err: Error | null, stdout: string) => void) => cb(null, 'gho_abc\n'));
		const read = ghTokenReader(exec, () => Promise.resolve('/opt/homebrew/bin:/usr/bin'));
		expect(await read('github.example.com')).toBe('gho_abc');
		const [file, args, opts] = exec.mock.calls[0] ?? [];
		expect(file).toBe('gh');
		expect(args).toEqual(['auth', 'token', '--hostname', 'github.example.com']);
		expect(opts?.env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
	});

	it('resolves null when gh is missing, not logged in, or prints something odd', async () => {
		const failing = ghTokenReader((_f, _a, _o, cb) => cb(new Error('ENOENT'), ''), () => Promise.resolve(''));
		expect(await failing('github.com')).toBeNull();
		const odd = ghTokenReader((_f, _a, _o, cb) => cb(null, 'not logged in to any hosts'), () => Promise.resolve(''));
		expect(await odd('github.com')).toBeNull();
	});
});

describe('token storage', () => {
	it('names secrets with lower-case letters, digits and dashes', () => {
		expect(secretId('github.com')).toBe('heron-github-github-com');
		expect(secretId('GHE.Corp.net:8443')).toBe('heron-github-ghe-corp-net-8443');
	});

	it('keeps tokens in Obsidian secret storage when the app has it', async () => {
		const secrets = new Map<string, string>();
		const storage = { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, v: string) => { secrets.set(id, v); } };
		const store = tokenStoreFor({ secretStorage: storage });
		expect(store.kind).toBe('keychain');
		await store.set('github.com', 'ghp_x');
		expect(secrets.get('heron-github-github-com')).toBe('ghp_x');
		expect(await store.get('github.com')).toBe('ghp_x');
		await store.set('github.com', '');
		expect(await secretStorageStore(storage).get('github.com')).toBeNull();
	});

	it('falls back to a private file outside the vault', async () => {
		expect(tokenStoreFor({}).kind).toBe('file');
		const dir = tempDir('heron-tokens-');
		cleanup.push(dir);
		const file = path.join(dir, 'heron', 'github-tokens.json');
		const store = fileTokenStore(file);
		expect(await store.get('github.com')).toBeNull();
		await store.set('github.com', 'ghp_a');
		await store.set('github.example.com', 'ghp_b');
		expect(await store.get('github.com')).toBe('ghp_a');
		if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
		await store.set('github.com', '');
		expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ 'github.example.com': 'ghp_b' });
	});
});

describe('GitHub service', () => {
	const okUser = (req: HttpRequest): Promise<HttpResponse> => Promise.resolve({
		status: req.headers.Authorization === 'Bearer good' ? 200 : 401,
		headers: {},
		text: JSON.stringify({ login: 'octocat', message: 'Bad credentials' }),
		arrayBuffer: new ArrayBuffer(0),
	});

	it('finds GitHub repositories from origin remotes and caches them per root', async () => {
		const read = vi.fn((root: string) => Promise.resolve(root === '/a' ? 'git@github.com:o/a.git' : root === '/b' ? 'https://gitlab.com/o/b' : null));
		const service = new GitHubService(new TokenResolver(memoryStore(), () => Promise.resolve(null)), okUser, read);
		expect(await service.repoFor('/a')).toEqual({ host: 'github.com', owner: 'o', name: 'a' });
		expect(await service.repoFor('/a')).toEqual({ host: 'github.com', owner: 'o', name: 'a' });
		expect(await service.repoFor('/b')).toBeNull();
		expect(await service.repoFor('/c')).toBeNull();
		expect(read).toHaveBeenCalledTimes(3);
	});

	it('has no client without a token, and tests connections with GET /user', async () => {
		const store = memoryStore();
		const service = new GitHubService(new TokenResolver(store, () => Promise.resolve(null)), okUser, () => Promise.resolve(null));
		expect(await service.client('github.com')).toBeNull();
		const none = await service.testConnection('github.com');
		expect(none.ok).toBe(false);
		await store.set('github.com', 'bad');
		const bad = await service.testConnection('github.com');
		expect(bad).toMatchObject({ ok: false, source: 'settings' });
		expect(bad.ok ? '' : bad.message).toMatch(/rejected the token/);
		expect(bad.ok ? '' : bad.message).not.toContain('bad ');
		await store.set('github.com', 'good');
		expect(await service.testConnection('github.com')).toEqual({ ok: true, login: 'octocat', source: 'settings' });
	});
});
