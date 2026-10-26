import { LSPPlugin, Workspace, WorkspaceFile } from '@codemirror/lsp-client';
import type { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

type FileUpdate = ReturnType<Workspace['syncFiles']>[number];

class ViewerFile implements WorkspaceFile {
	constructor(
		readonly uri: string,
		readonly languageId: string,
		public version: number,
		public doc: Text,
		readonly view: EditorView,
	) {}

	getView() { return this.view; }
}

/**
 * The files a language server sees: the ones currently shown in Heron's code
 * view. Heron reuses one editor across files, so opening a file in a view
 * replaces whatever that view held before. Cross-file jumps go through
 * `display`, which the code view provides.
 */
export class ViewerWorkspace extends Workspace {
	files: ViewerFile[] = [];
	private versions = new Map<string, number>();
	/** Shows a file and returns its editor; set by the code view. */
	display: ((uri: string) => Promise<EditorView | null>) | null = null;

	syncFiles(): readonly FileUpdate[] {
		const result: FileUpdate[] = [];
		for (const file of this.files) {
			const plugin = LSPPlugin.get(file.view);
			if (!plugin || plugin.unsyncedChanges.empty) continue;
			result.push({ changes: plugin.unsyncedChanges, file, prevDoc: file.doc });
			file.doc = file.view.state.doc;
			file.version = this.nextVersion(file.uri);
			plugin.clear();
		}
		return result;
	}

	openFile(uri: string, languageId: string, view: EditorView): void {
		for (const file of this.files.filter((f) => f.uri === uri || f.view === view)) this.closeFile(file.uri, file.view);
		const file = new ViewerFile(uri, languageId, this.nextVersion(uri), view.state.doc, view);
		this.files.push(file);
		// A server that just died throws on send; the editor must not break because of it.
		try {
			this.client.didOpen(file);
		} catch { /* reported by the manager when the process exits */ }
	}

	closeFile(uri: string, view: EditorView): void {
		const file = this.files.find((f) => f.uri === uri && f.view === view);
		if (!file) return;
		this.files = this.files.filter((f) => f !== file);
		try {
			this.client.didClose(uri);
		} catch { /* see openFile */ }
	}

	displayFile(uri: string): Promise<EditorView | null> {
		return this.display ? this.display(uri) : super.displayFile(uri);
	}

	private nextVersion(uri: string): number {
		const version = (this.versions.get(uri) ?? -1) + 1;
		this.versions.set(uri, version);
		return version;
	}
}
