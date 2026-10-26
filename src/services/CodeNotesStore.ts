import { MarginNote, newNoteId, NoteDocument, NoteFrontmatter } from '../notes/noteFormat';
import { CodeTarget, notePath } from '../notes/notePaths';

/** The vault operations the store needs; the plugin adapts Obsidian's vault, tests use a map. */
export interface NotesVault {
	/** The file's text, or null when it does not exist. */
	read(path: string): Promise<string | null>;
	/** Creates the file (and its folders) with `text`; fails if it exists. */
	create(path: string, text: string): Promise<void>;
	/** Rewrites an existing file from its current text, atomically where the vault allows. */
	process(path: string, fn: (text: string) => string): Promise<void>;
	exists(path: string): boolean;
}

/** What a new note file records about where it came from. */
export interface NoteOrigin {
	commit: string;
	/** Markdown link to the code file, for the note's first line. */
	codeLink: string;
}

/**
 * Reads and writes margin notes, one markdown note per code file. Every
 * change re-reads the note file first, so edits made by hand in between are
 * kept; nothing is cached.
 */
export class CodeNotesStore {
	constructor(private vault: NotesVault, private folder: () => string) {}

	/** Vault path of the note file for `target`. */
	pathFor(target: CodeTarget): string {
		return notePath(this.folder(), target);
	}

	/** The notes for `target`, or null when it has no note file. */
	async load(target: CodeTarget): Promise<NoteDocument | null> {
		const text = await this.vault.read(this.pathFor(target));
		return text === null ? null : NoteDocument.parse(text);
	}

	/**
	 * Adds a note (its id is chosen here) and returns it. Creates the note
	 * file, recording the commit, when this is the file's first note.
	 */
	async add(target: CodeTarget, note: Omit<MarginNote, 'id'>, origin: () => Promise<NoteOrigin>): Promise<MarginNote> {
		const path = this.pathFor(target);
		if (!this.vault.exists(path)) {
			const { commit, codeLink } = await origin();
			const meta: NoteFrontmatter = { repo: target.repo, file: target.file, commit };
			const doc = NoteDocument.create(meta, codeLink);
			const created = { ...note, id: newNoteId([]) };
			doc.add(created);
			// Another note may have created the file meanwhile; fall through to adding to it.
			if (!this.vault.exists(path)) {
				await this.vault.create(path, doc.serialize());
				return created;
			}
		}
		let added: MarginNote | null = null;
		await this.vault.process(path, (text) => {
			const doc = NoteDocument.parse(text);
			added = { ...note, id: newNoteId(doc.notes.map((n) => n.id)) };
			doc.add(added);
			return doc.serialize();
		});
		if (!added) throw new Error('The note was not added');
		return added;
	}

	/** Changes a note; returns false when it no longer exists. */
	async update(target: CodeTarget, id: string, patch: Partial<Omit<MarginNote, 'id'>>): Promise<boolean> {
		return this.change(target, (doc) => doc.update(id, patch));
	}

	/** Removes a note; returns false when it no longer exists. */
	async remove(target: CodeTarget, id: string): Promise<boolean> {
		return this.change(target, (doc) => doc.remove(id));
	}

	private async change(target: CodeTarget, apply: (doc: NoteDocument) => boolean): Promise<boolean> {
		const path = this.pathFor(target);
		if (!this.vault.exists(path)) return false;
		let changed = false;
		await this.vault.process(path, (text) => {
			const doc = NoteDocument.parse(text);
			changed = apply(doc);
			return changed ? doc.serialize() : text;
		});
		return changed;
	}
}
