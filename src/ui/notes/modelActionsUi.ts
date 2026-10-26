import { App, Notice, requestUrl, TFile } from 'obsidian';
import * as path from 'path';
import { GitRepo } from '../../git/GitRepo';
import { apiClient, cliClient, ModelClient } from '../../model/client';
import { renderDiagramNote } from '../../notes/diagramNote';
import { diagramPath } from '../../notes/notePaths';
import type { ModelSettings } from '../../notes/settings';
import { ActionSource, diagram, explainSelection, findSimilar } from '../../services/modelActions';
import { readViewableFile } from '../../utils/content';
import { displayPath, findRepoRoot } from '../../utils/paths';
import { LocationModal } from '../locationModals';
import type { FileLocation } from '../../lsp/locations';
import type { ModelRuns } from './ModelRuns';
import { NotesController, today } from './NotesController';
import { codeLink, ensureFolders, toVaultPath } from './vaultNotes';

export interface ModelActionsHost {
	app: App;
	settings(): ModelSettings;
	/** Folder of the code notes. */
	notesFolder(): string;
	/** The vault's folder on disk. */
	base(): string;
	runs: ModelRuns;
	/** Opens a location in the controller's tab. */
	open(controller: NotesController, loc: FileLocation): void;
	/** Shows the Code notes panel. */
	showPanel(): void;
}

/** The API key from Obsidian's secret storage, or null without one. */
export function apiKey(app: App, secretName: string): string | null {
	return secretName ? app.secretStorage.getSecret(secretName) : null;
}

/** A client for the configured transport. */
export function modelClient(app: App, settings: ModelSettings): ModelClient {
	if (settings.transport === 'api') {
		return apiClient({
			model: settings.model,
			apiKey: () => apiKey(app, settings.apiKeySecret),
			post: async (req) => {
				const res = await requestUrl({ ...req, throw: false });
				return { status: res.status, text: res.text };
			},
		});
	}
	return cliClient({ model: settings.model, command: settings.cliCommand });
}

/** What a model action knows about the file in `controller`'s tab. Reads happen when asked. */
export function actionSource(controller: NotesController, base: string): ActionSource | null {
	const { surface } = controller;
	const absPath = surface.absPath;
	if (!absPath) return null;
	return {
		absPath,
		text: surface.text(),
		language: path.extname(absPath).slice(1).toLowerCase(),
		label: (p) => displayPath(p, base),
		outline: () => surface.outline(),
		server: () => surface.server(),
		readLines: async (p) => {
			const content = await readViewableFile(p);
			return content.kind === 'text' ? content.text.split(/\r\n?|\n/) : null;
		},
		grep: async (word, limit, signal) => {
			const root = await findRepoRoot(path.dirname(absPath));
			const opened = root ? await GitRepo.open(root) : null;
			if (opened?.kind !== 'repo') return [];
			const { hits } = await opened.repo.grep({ pattern: word, syntax: 'fixed', caseSensitive: true, wholeWord: true }, limit, signal);
			return hits.map((hit) => ({ absPath: opened.repo.absPath(hit.path), line: hit.line - 1, text: hit.text }));
		},
	};
}

/**
 * The model actions as the user runs them: checks, progress and
 * cancellation (through `ModelRuns`), then saving or showing the result.
 */
export class ModelActionsUi {
	constructor(private host: ModelActionsHost) {}

	/** A client, or null (with a notice) while model actions are off. */
	private client(): ModelClient | null {
		const settings = this.host.settings();
		if (!settings.enabled) {
			new Notice('Turn on model actions in the plugin settings first');
			return null;
		}
		return modelClient(this.host.app, settings);
	}

	/** Explains the selection and saves the answer as a model note tagged #explain. */
	async explain(controller: NotesController) {
		const range = controller.selection();
		if (!range) {
			new Notice('Select code to explain');
			return;
		}
		if (!controller.target) {
			new Notice('Only code files in the vault can have notes');
			return;
		}
		const model = this.client();
		const source = actionSource(controller, this.host.base());
		if (!model || !source) return;
		// Anchor in the text that was explained, even if it is edited meanwhile.
		const anchor = controller.anchorFor(range);
		const body = await this.host.runs.run('Explaining selection', (signal, progress) => explainSelection(source, range, { model, signal, progress }));
		if (body === null) return;
		await controller.addAnchored(anchor, { colour: 'blue', author: 'model', tags: ['explain'], body });
		this.host.showPanel();
	}

	/** Lists code like the selection, ranked by the model, in a picker. */
	async findSimilar(controller: NotesController) {
		const range = controller.selection();
		if (!range) {
			new Notice('Select code to find similar code');
			return;
		}
		const model = this.client();
		const source = actionSource(controller, this.host.base());
		if (!model || !source) return;
		const results = await this.host.runs.run('Finding similar code', (signal, progress) => findSimilar(source, range, { model, signal, progress }));
		if (results === null) return;
		if (!results.length) {
			new Notice('No similar code found');
			return;
		}
		const items = results.map((r) => ({ ...r, detail: r.reason }));
		new LocationModal(this.host.app, items, `${items.length} similar…`, (item) => this.host.open(controller, item)).open();
	}

	/** Draws the file, or the symbol at the cursor, and saves the diagram next to the notes. */
	async diagram(controller: NotesController, symbol: boolean) {
		const target = controller.target;
		if (!target) {
			new Notice('Only code files in the vault can be drawn');
			return;
		}
		const model = this.client();
		const source = actionSource(controller, this.host.base());
		if (!model || !source) return;
		const cursor = controller.surface.code.editor()?.state.selection.main;
		const range = symbol ? controller.selection() ?? (cursor ? { from: cursor.head, to: cursor.head } : null) : null;
		const label = symbol ? 'Drawing this symbol' : 'Drawing this file';
		const result = await this.host.runs.run(label, (signal, progress) => diagram(source, range, { model, signal, progress }));
		if (result === null) return;
		const { app } = this.host;
		const base = this.host.base();
		const notePath = diagramPath(this.host.notesFolder(), target, result.symbol, (p) => !!app.vault.getAbstractFileByPath(p));
		let commit = '';
		if (target.repo) {
			const opened = await GitRepo.open(path.join(base, target.repo));
			if (opened.kind === 'repo') commit = (await opened.repo.head()) ?? '';
		}
		const text = renderDiagramNote({
			repo: target.repo,
			file: target.file,
			commit,
			symbol: result.symbol,
			subject: result.subject,
			model: this.host.settings().model,
			date: today(),
			mermaid: result.mermaid,
			codeLinks: result.files.map((abs) => {
				const vaultPath = toVaultPath(base, abs);
				return vaultPath ? codeLink(app, vaultPath, notePath, displayPath(abs, base)) : `\`${displayPath(abs, base)}\``;
			}),
		});
		try {
			await ensureFolders(app, notePath);
			const file = await app.vault.create(notePath, text);
			if (file instanceof TFile) await app.workspace.getLeaf('split', 'vertical').openFile(file);
		} catch (err) {
			new Notice(`Cannot save the diagram: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
