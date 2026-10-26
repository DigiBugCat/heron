import { ItemView, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import { enclosingSymbols, OutlineNode } from '../../lsp/locations';
import { LatestRequest } from '../../utils/latest';
import type { CodeSurface } from './CodeSurface';
import { isCodeTab } from './codeTabs';

export const OUTLINE_VIEW_TYPE = 'heron-outline';

/** Short marks for symbol kinds, like an IDE's outline icons. */
const KIND_MARK: Record<string, string> = {
	class: 'C', interface: 'I', struct: 'S', enum: 'E', 'enum member': 'e', module: 'M', namespace: 'N', package: 'P',
	function: 'ƒ', method: 'm', constructor: 'c', property: 'p', field: 'f', variable: 'v', constant: 'K',
	'type parameter': 'T', event: '!', operator: 'o', key: 'k', object: '{', array: '[',
};

/** Groups kinds into a few colours. */
function kindClass(kind: string): string {
	if (['class', 'interface', 'struct', 'enum', 'type parameter'].includes(kind)) return 'is-type';
	if (['function', 'method', 'constructor', 'operator', 'event'].includes(kind)) return 'is-function';
	if (['module', 'namespace', 'package'].includes(kind)) return 'is-module';
	return 'is-value';
}

/**
 * Right-sidebar outline of the code file in the active tab: its classes,
 * functions and so on from the language server, like Obsidian's outline of
 * a note's headings. Selecting a symbol moves the cursor there; the symbol
 * around the cursor is highlighted.
 */
export class OutlineView extends ItemView {
	private surface: CodeSurface | null = null;
	private unsubscribe: (() => void) | null = null;
	private nodes: OutlineNode[] = [];
	private rows = new Map<OutlineNode, HTMLElement>();
	private request = new LatestRequest();
	private headerEl!: HTMLElement;
	private listEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType() { return OUTLINE_VIEW_TYPE; }

	getDisplayText() { return 'Code outline'; }

	getIcon() { return 'list'; }

	onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('heron-panel');
		this.headerEl = this.contentEl.createDiv({ cls: 'heron-panel-title' });
		this.listEl = this.contentEl.createDiv({ cls: 'heron-outline' });
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.follow()));
		this.app.workspace.onLayoutReady(() => this.follow());
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.bind(null);
		return Promise.resolve();
	}

	/** Shows the code tab most recently used in the main area, if any. */
	private follow() {
		const view = this.app.workspace.getMostRecentLeaf()?.view;
		this.bind(isCodeTab(view) ? view.codeSurface() : null);
	}

	private bind(surface: CodeSurface | null) {
		if (surface === this.surface) return;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.surface = surface;
		if (surface) {
			this.unsubscribe = surface.onChange((change) => {
				if (change === 'cursor') this.highlight();
				else void this.reload();
			});
		}
		void this.reload();
	}

	private async reload() {
		const token = this.request.next();
		const surface = this.surface;
		if (!surface?.absPath) {
			this.render([], 'Open a code file to see its outline.');
			return;
		}
		const nodes = await surface.outline();
		if (!this.request.isCurrent(token)) return;
		const status = surface.status;
		const empty = nodes === null
			? status?.kind === 'starting' || (status?.kind === 'ready' && status.busy) ? 'Loading…' : 'No language server for this file.'
			: 'No symbols in this file.';
		this.render(nodes ?? [], empty, path.basename(surface.absPath ?? ''));
	}

	private render(nodes: OutlineNode[], empty: string, title = '') {
		this.nodes = nodes;
		this.rows.clear();
		this.headerEl.setText(title);
		this.headerEl.toggle(!!title);
		this.listEl.empty();
		if (!nodes.length) {
			this.listEl.createDiv({ cls: 'heron-panel-empty', text: empty });
			return;
		}
		const add = (node: OutlineNode, depth: number) => {
			const row = this.listEl.createDiv({ cls: 'heron-outline-row tree-item-self is-clickable', attr: { role: 'button', tabindex: '0' } });
			row.setCssProps({ '--heron-depth': String(depth) });
			row.createSpan({ cls: `heron-kind ${kindClass(node.kind)}`, text: KIND_MARK[node.kind] ?? '·', attr: { 'aria-label': node.kind } });
			row.createSpan({ cls: 'heron-outline-name', text: node.name });
			if (node.detail) row.createSpan({ cls: 'heron-outline-detail', text: node.detail });
			const go = () => this.reveal(node);
			this.registerDomEvent(row, 'click', go);
			this.registerDomEvent(row, 'keydown', (evt) => { if (evt.key === 'Enter') go(); });
			this.rows.set(node, row);
			for (const child of node.children) add(child, depth + 1);
		};
		for (const node of nodes) add(node, 0);
		this.highlight();
	}

	/** Marks the innermost symbol around the cursor. */
	private highlight() {
		const cursor = this.surface?.code.cursor();
		const chain = cursor ? enclosingSymbols(this.nodes, cursor) : [];
		const current = chain[chain.length - 1];
		for (const [node, row] of this.rows) row.toggleClass('is-active', node === current);
	}

	private reveal(node: OutlineNode) {
		const surface = this.surface;
		if (!surface) return;
		surface.moveCursor(node.position);
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });
		surface.code.editor()?.focus();
	}
}
