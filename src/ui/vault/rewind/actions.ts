import { App, Modal, Notice, Setting, TFile, TFolder } from 'obsidian';
import * as path from 'path';
import type { Moment, MomentFile } from '../../../services/rewind/moments';
import { newId } from '../../../services/rewind/records';
import {
	applyRestore, lastUndoable, planFileRestore, planUndoMoment, RESTORE_GROUP_PREFIX, RestoreError, RestoreOp, RestoreVault, touchedPaths,
} from '../../../services/rewind/restore';
import { CODE_VIEW_TYPE, CodeFileView } from '../codeTabs';
import type { Rewind } from './Rewind';

/** "14:03" today, "12 Oct, 14:03" on other days. */
export function momentTime(ms: number, now = Date.now()): string {
	const date = new Date(ms);
	const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	if (new Date(now).toDateString() === date.toDateString()) return time;
	return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

/** Writes through Obsidian's vault, so other views and plugins see the change. */
export function obsidianVault(app: App): RestoreVault {
	const fileAt = (p: string) => {
		const f = app.vault.getAbstractFileByPath(p);
		return f instanceof TFile ? f : null;
	};
	const ensureFolder = async (p: string) => {
		const dir = path.posix.dirname(p);
		if (dir === '.' || app.vault.getAbstractFileByPath(dir) instanceof TFolder) return;
		await app.vault.createFolder(dir);
	};
	return {
		exists: (p) => !!fileAt(p),
		read: async (p) => {
			const f = fileAt(p);
			return f ? app.vault.read(f) : '';
		},
		write: async (p, text) => {
			const f = fileAt(p);
			if (f) {
				await app.vault.modify(f, text);
				return;
			}
			await ensureFolder(p);
			await app.vault.create(p, text);
		},
		remove: async (p) => {
			const f = fileAt(p);
			if (f) await app.fileManager.trashFile(f);
		},
		move: async (from, to) => {
			const f = fileAt(from);
			if (!f) return;
			await ensureFolder(to);
			await app.fileManager.renameFile(f, to);
		},
	};
}

/** Asks before replacing unsaved edits; resolves to the answer. */
class ConfirmModal extends Modal {
	private answered = false;

	constructor(app: App, private title: string, private message: string, private action: string, private resolve: (ok: boolean) => void) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.title);
		this.contentEl.createEl('p', { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.answer(false)))
			.addButton((b) => b.setButtonText(this.action).setWarning().onClick(() => this.answer(true)));
	}

	onClose() {
		this.contentEl.empty();
		if (!this.answered) this.resolve(false);
	}

	private answer(ok: boolean) {
		this.answered = true;
		this.resolve(ok);
		this.close();
	}
}

export function confirm(app: App, title: string, message: string, action: string): Promise<boolean> {
	return new Promise((resolve) => new ConfirmModal(app, title, message, action, resolve).open());
}

/** Heron code tabs with unsaved edits to any of `paths`. */
function dirtyTabs(app: App, paths: string[]): CodeFileView[] {
	return app.workspace.getLeavesOfType(CODE_VIEW_TYPE)
		.map((leaf) => leaf.view)
		.filter((v): v is CodeFileView => v instanceof CodeFileView && !!v.file && paths.includes(v.file.path) && v.codeSurface().isDirty);
}

/** Restores, undoes and steps back through history, with confirmation and notices. */
export class RewindActions {
	constructor(private app: App, private rewind: Rewind) {}

	restoreFile(moment: Moment, file: MomentFile, side: 'before' | 'after') {
		const name = path.posix.basename(file.path);
		const when = momentTime(moment.start);
		const label = side === 'after' ? `Restored ${name} to ${when}` : `Restored ${name} to before ${when}`;
		return this.run(planFileRestore(file, side), label);
	}

	undoMoment(moment: Moment) {
		return this.run(planUndoMoment(moment), `Undid “${moment.label}”`);
	}

	/** Puts `vaultPath` back to before the latest moment that left it as it is; repeat to step further back. */
	async undoLastInFile(vaultPath: string): Promise<boolean> {
		await this.rewind.flush();
		const current = await this.rewind.currentHash(vaultPath);
		if (current === undefined) {
			new Notice('Rewind cannot read this file');
			return false;
		}
		const found = lastUndoable(this.rewind.moments(), vaultPath, current);
		if (!found) {
			new Notice(`Nothing to undo in ${path.posix.basename(vaultPath)}`);
			return false;
		}
		return this.run(planFileRestore(found.file, 'before'), `Undid “${found.moment.label}” in ${path.posix.basename(vaultPath)}`);
	}

	private async run(ops: RestoreOp[], label: string): Promise<boolean> {
		const store = this.rewind.store;
		const recorder = this.rewind.recorder;
		if (!store || !recorder) {
			new Notice('Rewind is not recording');
			return false;
		}
		const dirty = dirtyTabs(this.app, touchedPaths(ops));
		if (dirty.length) {
			const names = dirty.map((v) => v.file?.name ?? '').join(', ');
			const ok = await confirm(this.app, 'Replace unsaved edits?', `${names} ${dirty.length === 1 ? 'has' : 'have'} unsaved edits. Restoring replaces them.`, 'Restore');
			if (!ok) return false;
			for (const view of dirty) view.codeSurface().markSaved();
		}
		try {
			const changed = await applyRestore(ops, {
				vault: obsidianVault(this.app), store, recorder, label, group: `${RESTORE_GROUP_PREFIX}${newId()}`,
			});
			for (const view of dirty) await view.reloadFromDisk();
			await this.rewind.flush();
			new Notice(changed.length ? label : 'Already up to date');
			return changed.length > 0;
		} catch (err) {
			new Notice(err instanceof RestoreError ? err.message : `Cannot restore: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}
}
