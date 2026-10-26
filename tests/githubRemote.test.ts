import { afterEach, describe, expect, it } from 'vitest';
import { GitRepo } from '../src/git/GitRepo';
import { endpointsFor, isPossiblyGitHub, parseRemoteUrl, pullRequestUrl } from '../src/github/remote';
import { git, makeRepo, remove } from './helpers';

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) remove(cleanup.pop() ?? ''); });

const COM = { host: 'github.com', owner: 'octocat', name: 'heron' };

describe('remote URL parsing', () => {
	it.each([
		'https://github.com/octocat/heron',
		'https://github.com/octocat/heron.git',
		'https://github.com/octocat/heron/',
		'https://user:secret@github.com/octocat/heron.git',
		'http://github.com/octocat/heron',
		'ssh://git@github.com/octocat/heron.git',
		'ssh://git@ssh.github.com:443/octocat/heron.git',
		'git+ssh://git@github.com/octocat/heron',
		'git://github.com/octocat/heron.git',
		'git@github.com:octocat/heron.git',
		'git@github.com:octocat/heron',
		'github.com:octocat/heron.git',
		'git@github.com-work:octocat/heron.git',
		'  https://GitHub.com/octocat/heron.git\n',
	])('reads github.com from %s', (url) => {
		expect(parseRemoteUrl(url)).toEqual(COM);
	});

	it('treats other hosts as GitHub Enterprise, keeping HTTPS ports but not SSH ones', () => {
		expect(parseRemoteUrl('git@github.example.com:team/app.git')).toEqual({ host: 'github.example.com', owner: 'team', name: 'app' });
		expect(parseRemoteUrl('https://ghe.corp.net:8443/team/app.git')).toEqual({ host: 'ghe.corp.net:8443', owner: 'team', name: 'app' });
		expect(parseRemoteUrl('ssh://git@ghe.corp.net:2222/team/app.git')).toEqual({ host: 'ghe.corp.net', owner: 'team', name: 'app' });
		expect(parseRemoteUrl('https://octo.ghe.com/team/app')).toEqual({ host: 'octo.ghe.com', owner: 'team', name: 'app' });
	});

	it('rejects local paths, other forges, SSH aliases and URLs without owner and name', () => {
		for (const url of [
			'', '/srv/git/app.git', 'file:///srv/git/app.git', 'C:/repos/app', '../app',
			'https://gitlab.com/group/app.git', 'git@bitbucket.org:team/app.git', 'https://gitlab.example.com/group/app',
			'git@work:team/app.git', 'https://github.com/only-owner', 'https://github.com/',
		]) {
			expect(parseRemoteUrl(url), url).toBeNull();
		}
	});

	it('knows which hosts may be GitHub', () => {
		expect(isPossiblyGitHub('github.com')).toBe(true);
		expect(isPossiblyGitHub('github.example.com')).toBe(true);
		expect(isPossiblyGitHub('codeberg.org')).toBe(false);
		expect(isPossiblyGitHub('gitea.example.com')).toBe(false);
	});
});

describe('API endpoints', () => {
	it('uses api.github.com for github.com', () => {
		expect(endpointsFor('github.com')).toEqual({ rest: 'https://api.github.com', graphql: 'https://api.github.com/graphql', web: 'https://github.com' });
	});

	it('uses /api/v3 and /api/graphql on GitHub Enterprise Server', () => {
		expect(endpointsFor('github.example.com')).toEqual({
			rest: 'https://github.example.com/api/v3',
			graphql: 'https://github.example.com/api/graphql',
			web: 'https://github.example.com',
		});
		expect(endpointsFor('ghe.corp.net:8443').rest).toBe('https://ghe.corp.net:8443/api/v3');
	});

	it('uses api.<host> on GitHub Enterprise Cloud with data residency', () => {
		expect(endpointsFor('octo.ghe.com')).toEqual({ rest: 'https://api.octo.ghe.com', graphql: 'https://api.octo.ghe.com/graphql', web: 'https://octo.ghe.com' });
	});

	it('builds pull request links', () => {
		expect(pullRequestUrl({ host: 'github.example.com', owner: 'team', name: 'app' }, 7)).toBe('https://github.example.com/team/app/pull/7');
	});
});

describe('reading the origin remote', () => {
	it('returns the origin URL, or null without one', async () => {
		const root = makeRepo({ 'a.txt': 'a' });
		cleanup.push(root);
		const opened = await GitRepo.open(root);
		if (opened.kind !== 'repo') throw new Error('not a repo');
		expect(await opened.repo.remoteUrl()).toBeNull();
		git(root, 'remote', 'add', 'origin', 'https://github.example.com/team/app.git');
		expect(await opened.repo.remoteUrl()).toBe('https://github.example.com/team/app.git');
		expect(await opened.repo.remoteUrl('upstream')).toBeNull();
	});
});
