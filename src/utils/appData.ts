import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';

/**
 * The operating system's folder for application data: `~/Library/Application
 * Support` on macOS, `%APPDATA%` on Windows, `$XDG_DATA_HOME` or
 * `~/.local/share` elsewhere.
 */
export function appDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
	const home = os.homedir();
	if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
	if (platform === 'win32') return env.APPDATA || path.join(home, 'AppData', 'Roaming');
	return env.XDG_DATA_HOME || path.join(home, '.local', 'share');
}

/** Heron's own data folder, outside any vault so it never syncs. */
export function heronDataDir(): string {
	return path.join(appDataDir(), 'Heron');
}

/** Rewind's history folder for the vault at `vaultBase`, keyed by a hash of its path. */
export function rewindDir(vaultBase: string, root = heronDataDir()): string {
	const key = createHash('sha256').update(path.resolve(vaultBase)).digest('hex').slice(0, 16);
	return path.join(root, 'rewind', key);
}
