import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';

/**
 * Apps started from the Dock or Finder get a minimal PATH, so language
 * servers installed with Homebrew, npm, cargo or go would not be found.
 * Like VS Code, ask the user's login shell for its PATH once, and add the
 * usual install folders as a fallback.
 */

const MARKER = '__HERON_PATH__';
const SHELL_TIMEOUT_MS = 5000;

let cached: Promise<string> | null = null;

/** The PATH to start language servers with. Resolved once per session. */
export function serverPath(): Promise<string> {
	return (cached ??= resolvePath());
}

async function resolvePath(): Promise<string> {
	const fromShell = process.platform === 'win32' ? '' : await loginShellPath();
	return mergePaths(fromShell, process.env.PATH ?? '', fallbackDirs().join(path.delimiter));
}

function loginShellPath(): Promise<string> {
	const shell = process.env.SHELL || '/bin/zsh';
	return new Promise((resolve) => {
		execFile(
			shell,
			['-ilc', `printf '%s%s' '${MARKER}' "$PATH"`],
			{ timeout: SHELL_TIMEOUT_MS, windowsHide: true },
			(err, stdout) => {
				if (err) {
					resolve('');
					return;
				}
				resolve(pathFromShellOutput(stdout));
			},
		);
	});
}

/** Extracts the PATH printed after the marker; shell startup files may print other text first. */
export function pathFromShellOutput(stdout: string): string {
	const at = stdout.lastIndexOf(MARKER);
	return at < 0 ? '' : stdout.slice(at + MARKER.length).trim();
}

function fallbackDirs(): string[] {
	const home = os.homedir();
	return [
		'/opt/homebrew/bin',
		'/usr/local/bin',
		path.join(home, '.local', 'bin'),
		path.join(home, '.cargo', 'bin'),
		path.join(home, 'go', 'bin'),
		path.join(home, '.npm-global', 'bin'),
		path.join(home, '.bun', 'bin'),
		path.join(home, '.volta', 'bin'),
	];
}

/** Joins PATH strings, keeping the first occurrence of each folder. */
export function mergePaths(...paths: string[]): string {
	const seen = new Set<string>();
	for (const p of paths) {
		for (const dir of p.split(path.delimiter)) if (dir) seen.add(dir);
	}
	return [...seen].join(path.delimiter);
}
