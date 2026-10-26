import { Notice } from 'obsidian';
import type SourceObserverPlugin from '../../main';
import type { PullRequest } from '../../github/types';
import { copyToClipboard } from '../../utils/system';
import type { VaultGitHubRepo } from './context';
import type { GitHubFeature } from './GitHubFeature';
import { PULL_REQUESTS_VIEW_TYPE } from './PullRequestsView';
import { PullRequestFileView } from './PullRequestFileView';
import { PullRequestView } from './PullRequestView';

/** The repository of the active file, else the one the panel shows, else the vault's only one. */
async function targetRepo(feature: GitHubFeature): Promise<VaultGitHubRepo | null> {
	const active = await feature.repoOfActiveFile();
	if (active) return active;
	const shown = feature.panel()?.currentRepo();
	if (shown) return shown;
	const repos = await feature.repos();
	return repos.length === 1 ? repos[0] ?? null : null;
}

/** The pull request whose head is the checked-out branch, with a notice when there is none. */
async function pullForCurrentBranch(feature: GitHubFeature): Promise<{ repo: VaultGitHubRepo; pull: PullRequest } | null> {
	const repo = await targetRepo(feature);
	if (!repo) {
		new Notice('Open a file in a repository with a GitHub remote first');
		return null;
	}
	if (!repo.branch) {
		new Notice(`${repo.rel} is not on a branch`);
		return null;
	}
	try {
		const client = await feature.service.requireClient(repo.ref.host);
		const pull = await client.pullForBranch(repo.ref, repo.branch);
		if (!pull) new Notice(`No pull request for ${repo.branch}`);
		return pull ? { repo, pull } : null;
	} catch (err) {
		new Notice(err instanceof Error ? err.message : String(err));
		return null;
	}
}

/** Registers the pull request commands. IDs are stable; do not rename them. */
export function registerGitHubCommands(plugin: SourceObserverPlugin, feature: GitHubFeature) {
	plugin.addCommand({
		id: 'show-pull-requests',
		name: 'Show pull requests',
		callback: () => { void plugin.revealPanel(PULL_REQUESTS_VIEW_TYPE); },
	});

	plugin.addCommand({
		id: 'open-pull-request-for-branch',
		name: 'Open pull request for current branch',
		callback: () => {
			void pullForCurrentBranch(feature).then((found) => {
				if (found) feature.openPull({ ...found.repo.ref, number: found.pull.number }, false);
			});
		},
	});

	plugin.addCommand({
		id: 'copy-pull-request-link',
		name: 'Copy pull request link',
		callback: () => {
			const view = plugin.app.workspace.getMostRecentLeaf()?.view;
			const shown = view instanceof PullRequestView || view instanceof PullRequestFileView ? view.webUrl() : null;
			if (shown) {
				void copyToClipboard(shown, 'Pull request link copied');
				return;
			}
			void pullForCurrentBranch(feature).then((found) => {
				if (found) void copyToClipboard(found.pull.url, `Link to #${found.pull.number} copied`);
			});
		},
	});
}
