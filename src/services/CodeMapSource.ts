import { promises as fsp } from 'fs';
import * as path from 'path';
import { CodeMapMeta, mergeCanvas, parseCanvas, renderMap, stringifyCanvas } from '../codemap/canvas';
import { buildGraph, folderGraph, SourceInput } from '../codemap/graph';
import { languageOf } from '../codemap/mask';
import { fileMapModel, folderMapModel, MapChange } from '../codemap/models';
import { GitRepo } from '../git/GitRepo';
import { ChangedFile, primaryKind } from '../git/status';
import { isHiddenPath, MAX_INDEXED_FILES, walkFolder } from './FileIndex';

/** Most source files read for one map. */
export const MAX_MAP_SOURCES = 2000;
/** Larger source files are left out (generated or bundled code). */
export const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_CONFIGS = 100;
const MAX_CONFIG_BYTES = 256 * 1024;
const READ_CONCURRENCY = 16;
/** Never mapped. Outside git, also skipped while walking (git honours .gitignore instead). */
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'site-packages']);
const WALK_SKIP_DIRS = new Set([...SKIP_DIRS, 'dist', 'build', 'out', 'target', 'vendor', 'venv']);
const CONFIG_FILE = /^(?:[tj]sconfig(?:\.[\w.-]+)?\.json|go\.mod|Cargo\.toml)$/;

/** The files of the repository (or folder) a map is made from. */
export interface CodeMapListing {
	/** Absolute path imports are resolved within: the repository root, or the folder outside git. */
	root: string;
	/** The mapped folder relative to `root` ('' for the root itself). */
	scope: string;
	repo: GitRepo | null;
	/** Every file under `root`, relative to it. */
	files: string[];
	/** Source files in the mapped folder, sorted. */
	sources: string[];
	/** More source files than `MAX_MAP_SOURCES`; only the first are mapped. */
	truncated: boolean;
}

function hasSegment(rel: string, names: Set<string>): boolean {
	return rel.split('/').some((seg) => names.has(seg));
}

function toPosix(p: string): string {
	return p.split(path.sep).join('/');
}

/** Lists the files a map of `folder` (absolute) is built from. */
export async function listCodeMapFiles(folder: string): Promise<CodeMapListing> {
	const real = await fsp.realpath(folder).catch(() => path.resolve(folder));
	const opened = await GitRepo.open(real);
	let root = real;
	let repo: GitRepo | null = null;
	let files: string[] | null = null;
	if (opened.kind === 'repo') {
		const atRoot = await GitRepo.open(opened.repo.root);
		if (atRoot.kind === 'repo') {
			try {
				files = (await atRoot.repo.listFiles()).slice(0, MAX_INDEXED_FILES);
				root = atRoot.repo.root;
				repo = atRoot.repo;
			} catch {
				files = null;
			}
		}
	}
	if (!files) {
		files = (await walkFolder(real)).rels.filter((rel) => !hasSegment(rel, WALK_SKIP_DIRS));
		root = real;
		repo = null;
	}
	const relative = toPosix(path.relative(root, real));
	const scope = relative.startsWith('..') ? '' : relative;
	const inScope = (rel: string) => !scope || rel.startsWith(`${scope}/`);
	const all = files
		.filter((rel) => inScope(rel) && languageOf(rel) && !isHiddenPath(rel) && !hasSegment(rel, SKIP_DIRS))
		.sort();
	return { root, scope, repo, files, sources: all.slice(0, MAX_MAP_SOURCES), truncated: all.length > MAX_MAP_SOURCES };
}

async function readText(abs: string, maxBytes: number): Promise<string | null> {
	try {
		const stat = await fsp.stat(abs);
		if (!stat.isFile() || stat.size > maxBytes) return null;
		const text = await fsp.readFile(abs, 'utf-8');
		return text.includes('\0') ? null : text;
	} catch {
		return null;
	}
}

/** Reads `items` with a few reads in flight at once. */
async function readAll(root: string, items: string[], maxBytes: number): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const rel = items[next++] ?? '';
			const text = await readText(path.join(root, rel), maxBytes);
			if (text !== null) out.set(rel, text);
		}
	};
	await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
	return out;
}

/** Reads the listed source files and the config files that guide import resolution. */
export async function readCodeMapSources(listing: CodeMapListing): Promise<{ sources: SourceInput[]; configs: Map<string, string>; skipped: number }> {
	const configNames = listing.files
		.filter((rel) => CONFIG_FILE.test(path.posix.basename(rel)) && !hasSegment(rel, SKIP_DIRS))
		.sort()
		.slice(0, MAX_CONFIGS);
	const configs = await readAll(listing.root, configNames, MAX_CONFIG_BYTES);
	const texts = await readAll(listing.root, listing.sources, MAX_SOURCE_BYTES);
	const sources = listing.sources.filter((rel) => texts.has(rel)).map((rel) => ({ path: rel, text: texts.get(rel) ?? '' }));
	return { sources, configs, skipped: listing.sources.length - sources.length };
}

/** How each changed file shows on a map, by path relative to the repository root. */
export function mapChanges(files: ChangedFile[]): Map<string, MapChange> {
	const changes = new Map<string, MapChange>();
	for (const file of files) {
		const kind = primaryKind(file);
		if (kind === 'added' || kind === 'untracked') changes.set(file.path, 'added');
		else if (kind === 'modified' || kind === 'renamed') changes.set(file.path, 'modified');
		else if (kind === 'conflicted') changes.set(file.path, 'conflicted');
	}
	return changes;
}

export interface CodeMapRequest {
	listing: CodeMapListing;
	level: 'files' | 'folders';
	/** Vault path of the mapped folder ('' for the vault root). */
	folderVaultPath: string;
	/** Name shown for the mapped folder. */
	rootLabel: string;
	changes: ReadonlyMap<string, MapChange>;
	/** The text of the canvas being replaced, if any, so moved cards stay put. */
	previous: string | null;
	now: Date;
}

export interface CodeMapResult {
	text: string;
	files: number;
	imports: number;
	skipped: number;
}

/** Reads the sources, builds the graph and returns the canvas text, merged into `previous`. */
export async function buildCodeMap(req: CodeMapRequest): Promise<CodeMapResult> {
	const { listing } = req;
	const { sources, configs, skipped } = await readCodeMapSources(listing);
	const graph = buildGraph({ files: listing.files, configs, sources });
	const ctx = {
		scope: listing.scope,
		rootLabel: req.rootLabel,
		vaultPath: (repoPath: string) => {
			const rel = listing.scope ? repoPath.slice(listing.scope.length + 1) : repoPath;
			return req.folderVaultPath ? `${req.folderVaultPath}/${rel}` : rel;
		},
		change: (repoPath: string) => req.changes.get(repoPath),
		now: req.now,
	};
	const model = req.level === 'folders' ? folderMapModel(folderGraph(graph, listing.scope), ctx) : fileMapModel(graph, ctx);
	const meta: CodeMapMeta = { kind: 'code-map', version: 1, source: req.folderVaultPath, level: req.level };
	const merged = mergeCanvas(req.previous === null ? null : parseCanvas(req.previous), renderMap(model, meta));
	return { text: stringifyCanvas(merged), files: graph.nodes.length, imports: graph.edges.length, skipped };
}
