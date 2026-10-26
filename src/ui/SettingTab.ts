import { App, PluginSettingTab, Setting } from 'obsidian';
import type SourceObserverPlugin from '../main';
import { BUILTIN_SERVERS } from '../lsp/servers';
import { DEFAULT_SETTINGS, DiffLayout, FONT_SIZE_RANGE, sanitizeVaultFolder } from '../settings';
import { renderRewindSettings } from './vault/rewind/settingsSection';
import { renderGitHubSettings } from './github/settings';

/** Obsidian settings tab for Heron. */
export class SourceObserverSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: SourceObserverPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;

		new Setting(containerEl)
			.setName('Font size')
			.setDesc('Font size of the code and diff viewer, in pixels.')
			.addSlider((slider) =>
				slider
					.setLimits(FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max, 1)
					.setValue(settings.fontSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.fontSize = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Word wrap')
			.setDesc('Wrap long lines in files and diffs instead of scrolling sideways.')
			.addToggle((toggle) =>
				toggle.setValue(settings.wordWrap).onChange(async (value) => {
					settings.wordWrap = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Diff layout')
			.setDesc('Show changes in one column, or the old and new versions side by side.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('unified', 'Unified')
					.addOption('split', 'Side by side')
					.setValue(settings.diffLayout)
					.onChange(async (value) => {
						settings.diffLayout = value as DiffLayout;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Show hidden files')
			.setDesc('Show files and folders whose names start with a dot.')
			.addToggle((toggle) =>
				toggle
					.setValue(settings.showHidden)
					.onChange(async (value) => {
						settings.showHidden = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Open code files for')
			.setDesc('Reading opens code read-only. Switch a tab to editing with the pencil in its header. Edits are saved when you press the save shortcut or leave the tab.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('read', 'Reading')
					.addOption('edit', 'Editing')
					.setValue(settings.codeMode)
					.onChange(async (value) => {
						settings.codeMode = value === 'edit' ? 'edit' : 'read';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Code map folder')
			.setDesc('Folder where code maps and call graphs are saved.')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.codeMapFolder)
					.setValue(settings.codeMapFolder)
					.onChange(async (value) => {
						settings.codeMapFolder = sanitizeVaultFolder(value, DEFAULT_SETTINGS.codeMapFolder);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Language servers').setHeading();

		new Setting(containerEl)
			.setName('Use language servers')
			.setDesc('Go to definition, hover, references and symbol search. Servers are programs you install; Heron starts them in the opened project and stops them when you switch projects.')
			.addToggle((toggle) =>
				toggle.setValue(settings.languageServers).onChange(async (value) => {
					settings.languageServers = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (settings.languageServers) {
			for (const spec of BUILTIN_SERVERS) {
				const override = settings.serverCommands[spec.id];
				const enabled = override !== '';
				const extensions = Object.keys(spec.languages).map((e) => `.${e}`).join(' ');
				new Setting(containerEl)
					.setName(spec.name)
					.setDesc(`${extensions}. Leave the command empty to use \`${spec.defaultCommand}\`.`)
					.addText((text) => {
						text
							.setPlaceholder(spec.defaultCommand)
							.setValue(enabled ? override ?? '' : '')
							.setDisabled(!enabled);
						// Saved when the field loses focus: saving restarts servers, which
						// must not happen for every keystroke of a half-typed command.
						text.inputEl.addEventListener('change', () => {
							const value = text.getValue().trim();
							const commands = { ...settings.serverCommands };
							if (value) commands[spec.id] = value;
							else delete commands[spec.id];
							settings.serverCommands = commands;
							void this.plugin.saveSettings();
						});
					})
					.addToggle((toggle) =>
						toggle.setValue(enabled).setTooltip(enabled ? 'Turn off' : 'Turn on').onChange(async (value) => {
							const commands = { ...settings.serverCommands };
							if (value) delete commands[spec.id];
							else commands[spec.id] = '';
							settings.serverCommands = commands;
							await this.plugin.saveSettings();
							this.display();
						}),
					);
			}
		}

		renderRewindSettings(containerEl, this.plugin);
		renderGitHubSettings(containerEl, this.plugin.github);

		new Setting(containerEl).setName('Folders').setHeading();

		const count = settings.recentFolders.length;
		new Setting(containerEl)
			.setName('Recent folders')
			.setDesc(count ? `${count} folder${count === 1 ? '' : 's'} remembered.` : 'No folders remembered.')
			.addButton((btn) =>
				btn
					.setButtonText('Clear')
					.setDisabled(count === 0)
					.onClick(async () => {
						settings.recentFolders = [];
						await this.plugin.saveSettings();
						this.display();
					}),
			);
	}
}
