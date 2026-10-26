import { App, FuzzySuggestModal, Modal, Setting, TFolder } from 'obsidian';

/** Folders never offered for a map: hidden ones and dependency folders. */
const SKIPPED = /(?:^|\/)(?:\.|node_modules(?:\/|$)|__pycache__(?:\/|$))/;

/** Folders of the vault worth mapping, optionally only those inside `within`. */
export function mappableFolders(app: App, within: TFolder | null = null): TFolder[] {
	return app.vault.getAllFolders(false)
		.filter((f) => !SKIPPED.test(f.path))
		.filter((f) => !within || (f !== within && f.path.startsWith(`${within.path}/`)))
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** Fuzzy picker of folders. */
export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private folders: TFolder[], placeholder: string, private onChoose: (folder: TFolder) => void) {
		super(app);
		this.setPlaceholder(placeholder);
		this.emptyStateText = 'No folders found.';
	}

	getItems(): TFolder[] {
		return this.folders;
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onChoose(folder);
	}
}

export type LargeMapChoice = 'folders' | 'subfolder' | 'files';

/** Asks how to map a folder with more files than a readable file map holds. */
export class LargeMapModal extends Modal {
	constructor(app: App, private name: string, private files: number, private limit: number, private onChoose: (choice: LargeMapChoice) => void) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText('Large folder');
		this.contentEl.createEl('p', {
			text: `${this.name} has ${this.files} source files. Maps of more than ${this.limit} files are hard to read, so you can map its folders instead, or map one subfolder.`,
		});
		const choose = (choice: LargeMapChoice) => {
			this.close();
			this.onChoose(choice);
		};
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText('Map all files').onClick(() => choose('files')))
			.addButton((b) => b.setButtonText('Choose a subfolder…').onClick(() => choose('subfolder')))
			.addButton((b) => b.setButtonText('Map folders').setCta().onClick(() => choose('folders')));
	}

	onClose() {
		this.contentEl.empty();
	}
}
