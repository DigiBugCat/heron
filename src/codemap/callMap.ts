import type { CallGraph } from '../lsp/callHierarchy';
import { CANVAS_COLORS, MapModel, stableId } from './canvas';
import { fileLink } from './models';

export interface CallMapContext {
	/** Vault path of an absolute path, or null when it is outside the vault. */
	vaultPath(absPath: string): string | null;
	/** Short name for a file, for group labels. */
	label(absPath: string): string;
}

function basename(p: string): string {
	return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
}

/** A card per function, grouped by file, with an arrow from each caller to what it calls. */
export function callMapModel(graph: CallGraph, ctx: CallMapContext): MapModel {
	const groupLabels = new Map<string, string>();
	const nodes = graph.items.map((item) => {
		const file = item.absPath;
		if (file) groupLabels.set(file, ctx.label(file));
		const where = file ? `${fileLink(ctx.vaultPath(file), basename(file))} · line ${item.line + 1}` : `line ${item.line + 1}`;
		const lines = [`**${item.name}**`, [item.kind, where].filter(Boolean).join(' · ')];
		return {
			id: stableId('c', item.key),
			text: lines.join('\n'),
			group: file,
			color: item.key === graph.root ? CANVAS_COLORS.focus : undefined,
		};
	});
	const edges = graph.edges.map((e) => ({ from: stableId('c', e.from), to: stableId('c', e.to) }));
	const root = graph.items.find((i) => i.key === graph.root);
	const facts = [`${graph.items.length} symbols`, `${graph.edges.length} calls`, ...(graph.truncated ? ['limited to the nearest calls'] : [])];
	const legend = [`## Call graph: ${root?.name ?? 'symbol'}`, facts.join(' · '), 'Purple: the symbol · arrows point from caller to callee'].join('\n');
	return { nodes, edges, groupLabels, legend };
}
