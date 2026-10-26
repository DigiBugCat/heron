import { Setting } from 'obsidian';
import type HeronPlugin from '../../../main';
import { clamp, REWIND_AGE_RANGE, REWIND_SIZE_RANGE } from '../../../settings';
import { revealInSystem } from '../../../utils/system';

/** The Rewind section of Heron's settings tab. */
export function renderRewindSettings(containerEl: HTMLElement, plugin: HeronPlugin) {
	const settings = plugin.settings;
	new Setting(containerEl).setName('Rewind').setHeading();

	new Setting(containerEl)
		.setName('Record local history')
		.setDesc('Keep a copy of every change to files in the vault’s repositories, who made it, and when, so you can diff and restore any point. Stored outside the vault.')
		.addToggle((toggle) =>
			toggle.setValue(settings.rewind).onChange(async (value) => {
				settings.rewind = value;
				await plugin.saveSettings();
			}),
		);

	const number = (name: string, desc: string, key: 'rewindMaxAgeDays' | 'rewindMaxSizeMb', range: { min: number; max: number }) => {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) => {
				text.setValue(String(settings[key]));
				text.inputEl.type = 'number';
				text.inputEl.addEventListener('change', () => {
					const value = Number(text.getValue());
					if (!Number.isFinite(value)) return;
					settings[key] = clamp(Math.round(value), range.min, range.max);
					text.setValue(String(settings[key]));
					void plugin.saveSettings();
				});
			});
	};
	number('Keep history for', 'Days. Older changes are removed.', 'rewindMaxAgeDays', REWIND_AGE_RANGE);
	number('Maximum history size', 'Megabytes. The oldest changes are removed first.', 'rewindMaxSizeMb', REWIND_SIZE_RANGE);

	const dir = plugin.rewind?.store?.dir;
	if (dir) {
		new Setting(containerEl)
			.setName('History folder')
			.setDesc(dir)
			.addButton((btn) => btn.setButtonText('Show').onClick(() => revealInSystem(dir)));
	}
}
