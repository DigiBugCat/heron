import { Setting } from 'obsidian';
import { defaultTokenFile, TokenSource } from '../../github/auth';
import { GITHUB_COM } from '../../github/remote';
import type { GitHubFeature } from './GitHubFeature';

/** Where a host's token comes from, in words. */
export function tokenSourceText(host: string, source: TokenSource): string {
	switch (source) {
		case 'settings': return 'Using the token pasted here.';
		case 'gh': return 'Using your GitHub CLI login (gh).';
		default: return `Not connected. Run "gh auth login --hostname ${host}" in a terminal, or paste a token that can read repositories.`;
	}
}

/** Hosts to list: github.com, then every host found in the vault's remotes. */
export function settingsHosts(detected: string[]): string[] {
	return [GITHUB_COM, ...[...new Set(detected)].filter((h) => h !== GITHUB_COM).sort()];
}

/**
 * The **GitHub** section of Heron's settings: each host with where its
 * token comes from, a field to paste one, and **Test connection**. Tokens
 * are never shown, not even masked.
 */
export function renderGitHubSettings(containerEl: HTMLElement, feature: GitHubFeature) {
	new Setting(containerEl).setName('GitHub').setHeading();
	const where = feature.service.tokens.storeKind === 'keychain'
		? 'Obsidian\'s secret storage'
		: `a private file outside the vault (${defaultTokenFile()})`;
	containerEl.createDiv({
		cls: 'setting-item-description heron-gh-settings-intro',
		text: `Pull requests for repositories in the vault whose origin remote is on GitHub or GitHub Enterprise. Heron uses a token pasted here, or your GitHub CLI login. Pasted tokens are kept in ${where}.`,
	});
	const hostsEl = containerEl.createDiv();
	void feature.repos().then((repos) => {
		hostsEl.empty();
		for (const host of settingsHosts(repos.map((r) => r.ref.host))) renderHost(hostsEl, host, feature);
	});
}

function renderHost(parent: HTMLElement, host: string, feature: GitHubFeature) {
	const { service } = feature;
	const setting = new Setting(parent).setName(host === GITHUB_COM ? host : `${host} (Enterprise)`).setDesc('Checking…');
	const showSource = async () => {
		const { source } = await service.tokens.resolve(host);
		setting.setDesc(tokenSourceText(host, source));
	};
	setting.addText((text) => {
		text.inputEl.type = 'password';
		text.inputEl.autocomplete = 'off';
		text.setPlaceholder('Paste a token');
		// Saved when the field loses focus, then cleared so the token is never shown.
		text.inputEl.addEventListener('change', () => {
			const token = text.getValue().trim();
			text.setValue('');
			if (!token) return;
			void service.tokens.save(host, token).then(() => {
				service.reset(host);
				return showSource();
			});
		});
	});
	setting.addExtraButton((button) =>
		button.setIcon('trash').setTooltip('Remove the pasted token').onClick(() => {
			void service.tokens.save(host, '').then(() => {
				service.reset(host);
				return showSource();
			});
		}),
	);
	setting.addButton((button) =>
		button.setButtonText('Test connection').onClick(async () => {
			button.setDisabled(true);
			setting.setDesc('Testing…');
			const result = await service.testConnection(host);
			button.setDisabled(false);
			setting.setDesc(result.ok
				? `Connected as ${result.login}. ${tokenSourceText(host, result.source)}`
				: result.message);
			feature.panel()?.refresh();
		}),
	);
	void showSource();
}
