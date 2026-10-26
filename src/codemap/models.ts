import { CANVAS_COLORS, MapModel, stableId } from './canvas';
import type { CodeGraph, FileNode, FolderGraph } from './graph';

/** How a file changed in git, as far as the map is concerned. */
export type MapChange = 'added' | 'modified' | 'conflicted';

export interface MapContext {
	/** Path of the mapped folder relative to the repository root ('' for the root). */
	scope: string;
	/** Name shown for the mapped folder itself. */
	rootLabel: string;
	/** Vault path of a repository file, or null when it is outside the vault. */
	vaultPath(repoPath: string): string | null;
	/** How a repository file changed, if it did. */
	change(repoPath: string): MapChange | undefined;
	/** Shown in the legend. */
	now: Date;
}

const MAX_SYMBOL_CHARS = 44;
/** Characters that break a `[[link|alias]]`. */
const UNLINKABLE = /[|#^[\]]/;

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function basename(p: string): string {
	return p.slice(p.lastIndexOf('/') + 1);
}

function dirname(p: string): string {
	const i = p.lastIndexOf('/');
	return i < 0 ? '' : p.slice(0, i);
}

/** A wiki link to a vault file, showing `label`; bold text when it cannot be linked. */
export function fileLink(vaultPath: string | null, label: string): string {
	if (!vaultPath || UNLINKABLE.test(vaultPath) || UNLINKABLE.test(label)) return `**${label}**`;
	return `[[${vaultPath}|${label}]]`;
}

/** `scope`-relative form of a repository path. */
function inScope(repoPath: string, scope: string): string {
	return scope && repoPath.startsWith(`${scope}/`) ? repoPath.slice(scope.length + 1) : repoPath;
}

function colorFor(change: MapChange | undefined): string | undefined {
	if (change === 'conflicted') return CANVAS_COLORS.conflict;
	if (change === 'modified') return CANVAS_COLORS.modified;
	if (change === 'added') return CANVAS_COLORS.added;
	return undefined;
}

const CHANGE_LABEL: Record<MapChange, string> = { added: 'new', modified: 'changed', conflicted: 'conflict' };

/** Symbols as code, as many as fit on one line, then `+N`. */
function symbolLine(symbols: string[]): string {
	const shown: string[] = [];
	let length = 0;
	for (const s of symbols) {
		if (shown.length && length + s.length + 3 > MAX_SYMBOL_CHARS) break;
		shown.push(s);
		length += s.length + 3;
	}
	const more = symbols.length - shown.length;
	return shown.map((s) => `\`${s}\``).join(' · ') + (more > 0 ? ` +${more}` : '');
}

function fileText(node: FileNode, ctx: MapContext): string {
	const lines = [fileLink(ctx.vaultPath(node.path), basename(node.path))];
	if (node.symbols.length) lines.push(symbolLine(node.symbols));
	const facts = [plural(node.lines, 'line')];
	if (node.external.length) facts.push(plural(node.external.length, 'package'));
	if (node.outside) facts.push(`${node.outside} outside`);
	const change = ctx.change(node.path);
	if (change) facts.push(CHANGE_LABEL[change]);
	lines.push(facts.join(' · '));
	return lines.join('\n');
}

function legend(title: string, facts: string[], now: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
	return [`## ${title}`, facts.join(' · '), 'Orange: changed · Green: new · Red: conflict', `Updated ${stamp}`].join('\n');
}

/** A card per file, grouped by folder, with an arrow from each file to the files it imports. */
export function fileMapModel(graph: CodeGraph, ctx: MapContext): MapModel {
	const groupLabels = new Map<string, string>();
	const nodes = graph.nodes.map((node) => {
		const folder = dirname(inScope(node.path, ctx.scope));
		groupLabels.set(folder, folder || ctx.rootLabel);
		return { id: stableId('f', node.path), text: fileText(node, ctx), group: folder, color: colorFor(ctx.change(node.path)) };
	});
	const edges = graph.edges.map((e) => ({ from: stableId('f', e.from), to: stableId('f', e.to) }));
	const packages = new Set(graph.nodes.flatMap((n) => n.external)).size;
	const facts = [plural(graph.nodes.length, 'file'), plural(graph.edges.length, 'import'), plural(packages, 'package')];
	return { nodes, edges, groupLabels, legend: legend(`Code map: ${ctx.rootLabel}`, facts, ctx.now) };
}

/**
 * A card per folder, with arrows summing the imports between them. When the
 * map goes more than one level deep, each top-level folder's cards share a group.
 */
export function folderMapModel(graph: FolderGraph, ctx: MapContext): MapModel {
	const groupLabels = new Map<string, string>();
	const nodes = graph.nodes.map((folder) => {
		const parent = graph.depth > 1 && folder.key ? folder.key.split('/')[0] ?? null : null;
		if (parent !== null) groupLabels.set(parent, parent);
		const changes = folder.files.map((f) => ctx.change(f)).filter((c): c is MapChange => !!c);
		const change: MapChange | undefined = changes.includes('conflicted') ? 'conflicted'
			: changes.includes('modified') ? 'modified' : changes.length ? 'added' : undefined;
		const facts = [plural(folder.files.length, 'file'), plural(folder.lines, 'line')];
		if (folder.external.length) facts.push(plural(folder.external.length, 'package'));
		if (changes.length) facts.push(`${changes.length} changed`);
		const text = [`**${folder.key ? `${folder.key}/` : `${ctx.rootLabel}/`}**`, facts.join(' · ')].join('\n');
		return { id: stableId('d', folder.key), text, group: parent, color: colorFor(change) };
	});
	const edges = graph.edges.map((e) => ({
		from: stableId('d', e.from),
		to: stableId('d', e.to),
		label: e.weight > 1 ? plural(e.weight, 'import') : undefined,
	}));
	const files = graph.nodes.reduce((sum, f) => sum + f.files.length, 0);
	const facts = [plural(graph.nodes.length, 'folder'), plural(files, 'file'), `${graph.depth} ${graph.depth === 1 ? 'level' : 'levels'} deep`];
	return { nodes, edges, groupLabels, legend: legend(`Code map: ${ctx.rootLabel} (folders)`, facts, ctx.now) };
}
