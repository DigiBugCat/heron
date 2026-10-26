import { Component, Notice } from 'obsidian';
import { ModelCancelled } from '../../model/client';

interface Run {
	label: string;
	controller: AbortController;
	notice: Notice;
	statusEl: HTMLElement;
}

/**
 * Model actions in progress. Each shows a notice with what it is doing and
 * a **Cancel** button until it finishes, and a status bar item while it runs;
 * failures are shown as notices. Unloading cancels everything.
 */
export class ModelRuns extends Component {
	private runs = new Set<Run>();

	constructor(private statusBar: () => HTMLElement) {
		super();
	}

	onunload() {
		this.cancelAll();
	}

	get active(): number {
		return this.runs.size;
	}

	/** Cancels every running action; returns how many there were. */
	cancelAll(): number {
		const count = this.runs.size;
		for (const run of [...this.runs]) run.controller.abort();
		return count;
	}

	/**
	 * Runs `work` with progress reporting. Resolves to its result, or null
	 * when it failed (already reported) or was cancelled.
	 */
	async run<T>(label: string, work: (signal: AbortSignal, progress: (message: string) => void) => Promise<T>): Promise<T | null> {
		const controller = new AbortController();
		const doc = activeDocument;
		const message = doc.createDocumentFragment();
		const text = message.createSpan({ text: `${label}…` });
		const cancel = message.createEl('button', { cls: 'heron-model-cancel', text: 'Cancel' });
		const notice = new Notice(message, 0);
		const statusEl = this.statusBar();
		statusEl.addClass('heron-model-status');
		statusEl.setText(`${label}…`);
		const run: Run = { label, controller, notice, statusEl };
		this.runs.add(run);
		cancel.addEventListener('click', (evt) => {
			evt.stopPropagation();
			controller.abort();
		});
		const progress = (step: string) => {
			text.setText(`${label}: ${step}`);
			statusEl.setText(`${label}: ${step}`);
		};
		try {
			return await work(controller.signal, progress);
		} catch (err) {
			if (err instanceof ModelCancelled || controller.signal.aborted) new Notice(`${label} cancelled`);
			else new Notice(`${label} failed: ${err instanceof Error ? err.message : String(err)}`, 10_000);
			return null;
		} finally {
			this.runs.delete(run);
			notice.hide();
			statusEl.remove();
		}
	}
}
