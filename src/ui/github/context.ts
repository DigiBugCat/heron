import type { App } from 'obsidian';
import type { GitHubRepoRef } from '../../github/remote';
import type { GitHubService } from '../../github/service';
import type { DiffLayout } from '../../settings';

/** A repository in the vault whose `origin` is on GitHub. */
export interface VaultGitHubRepo {
	/** Vault path of the repository folder. */
	rel: string;
	ref: GitHubRepoRef;
	/** Checked-out branch, or null when detached or unknown. */
	branch: string | null;
}

/** Identifies a pull request in tab state. */
export interface PullRef {
	host: string;
	owner: string;
	name: string;
	number: number;
}

export function isPullRef(state: unknown): state is PullRef {
	const s = state as Partial<PullRef> | null;
	return !!s && typeof s.host === 'string' && typeof s.owner === 'string' && typeof s.name === 'string'
		&& typeof s.number === 'number' && Number.isInteger(s.number) && s.number > 0;
}

export function repoOf(pull: PullRef): GitHubRepoRef {
	return { host: pull.host, owner: pull.owner, name: pull.name };
}

/** What the pull request views need from the plugin. */
export interface GitHubViewContext {
	app: App;
	service: GitHubService;
	/** Repositories in the vault with a GitHub remote. */
	repos(): Promise<VaultGitHubRepo[]>;
	/** The GitHub repository of the active file, if any. */
	repoOfActiveFile(): Promise<VaultGitHubRepo | null>;
	/** Calls `listener` when repositories in the vault change; returns an unsubscribe function. */
	onReposChange(listener: () => void): () => void;
	openPull(pull: PullRef, newTab: boolean): void;
	/** Opens one file's diff; `line` scrolls to a line on the head side. */
	openPullFile(pull: PullRef, path: string, newTab: boolean, line?: number): void;
	fontSize(): number;
	wordWrap(): boolean;
	layout(): DiffLayout;
	setLayout(layout: DiffLayout): void;
}
