import { App, SecretComponent, Setting } from 'obsidian';
import type SourceObserverPlugin from '../../main';
import { DEFAULT_MODEL } from '../../model/client';
import { DEFAULT_NOTES_FOLDER } from '../../notes/notePaths';

/** The **Code notes** and **Model** sections of Heron's settings. */
export function displayCodeNoteSettings(app: App, containerEl: HTMLElement, plugin: SourceObserverPlugin, redisplay: () => void) {
	const notes = plugin.settings.codeNotes;
	const model = plugin.settings.model;

	new Setting(containerEl).setName('Code notes').setHeading();

	new Setting(containerEl)
		.setName('Notes folder')
		.setDesc('Margin notes on a code file are saved as a note in this folder, by repository and path.')
		.addText((text) => {
			text.setPlaceholder(DEFAULT_NOTES_FOLDER).setValue(notes.folder);
			text.inputEl.addEventListener('change', () => {
				notes.folder = text.getValue().trim().replace(/^\/+|\/+$/g, '') || DEFAULT_NOTES_FOLDER;
				void plugin.saveSettings();
			});
		});

	new Setting(containerEl).setName('Model').setHeading();

	new Setting(containerEl)
		.setName('Use a model')
		.setDesc('Adds explain selection, find similar code and diagrams. The code involved is sent to Anthropic, only when you run one of these actions.')
		.addToggle((toggle) => toggle.setValue(model.enabled).onChange(async (value) => {
			model.enabled = value;
			await plugin.saveSettings();
			redisplay();
		}));

	if (!model.enabled) return;

	new Setting(containerEl)
		.setName('Connect with')
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- Claude Code is a product name
		.setDesc('Claude Code uses your Claude Code login, so no key is needed. The API needs an Anthropic API key.')
		.addDropdown((dropdown) => dropdown
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- product name
			.addOption('cli', 'Claude Code')
			.addOption('api', 'Anthropic API')
			.setValue(model.transport)
			.onChange(async (value) => {
				model.transport = value === 'api' ? 'api' : 'cli';
				await plugin.saveSettings();
				redisplay();
			}));

	new Setting(containerEl)
		.setName('Model')
		.setDesc(`The model to use. Default: ${DEFAULT_MODEL}.`)
		.addText((text) => {
			text.setPlaceholder(DEFAULT_MODEL).setValue(model.model);
			text.inputEl.addEventListener('change', () => {
				model.model = text.getValue().trim() || DEFAULT_MODEL;
				void plugin.saveSettings();
			});
		});

	if (model.transport === 'cli') {
		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- product name
			.setName('Claude Code command')
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- product name
			.setDesc('How to run Claude Code. Heron finds it the way your terminal does.')
			.addText((text) => {
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- the command's name
				text.setPlaceholder('claude').setValue(model.cliCommand);
				text.inputEl.addEventListener('change', () => {
					model.cliCommand = text.getValue().trim() || 'claude';
					void plugin.saveSettings();
				});
			});
		return;
	}

	new Setting(containerEl)
		.setName('API key')
		.setDesc('Kept in Obsidian\'s secret storage, not in the vault, so it does not sync with your notes.')
		.addComponent((el) => new SecretComponent(app, el)
			.setValue(model.apiKeySecret)
			.onChange(async (value) => {
				model.apiKeySecret = value;
				await plugin.saveSettings();
			}));
}
