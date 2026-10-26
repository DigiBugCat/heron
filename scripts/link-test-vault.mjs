// Links the built plugin into ./test-vault so it can be opened in Obsidian.
// Run after `npm run build` (or alongside `npm run dev`); safe to run again.
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');
const vault = path.join(root, 'test-vault');
const pluginDir = path.join(vault, '.obsidian', 'plugins', 'heron');

fs.mkdirSync(pluginDir, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
	const target = path.join(root, file);
	const link = path.join(pluginDir, file);
	fs.rmSync(link, { force: true });
	fs.symlinkSync(target, link);
}

const enabled = path.join(vault, '.obsidian', 'community-plugins.json');
if (!fs.existsSync(enabled)) fs.writeFileSync(enabled, JSON.stringify(['heron'], null, 2) + '\n');

// First run: open Heron's own source, with the dev-dependency language servers.
const data = path.join(pluginDir, 'data.json');
if (!fs.existsSync(data)) {
	const bin = (name) => `"${path.join(root, 'node_modules', '.bin', name)}" --stdio`;
	fs.writeFileSync(data, JSON.stringify({
		lastOpenedPath: root,
		serverCommands: {
			typescript: bin('typescript-language-server'),
			python: bin('basedpyright-langserver'),
		},
	}, null, 2) + '\n');
}

const welcome = path.join(vault, 'Welcome.md');
if (!fs.existsSync(welcome)) {
	fs.writeFileSync(welcome, '# Heron test vault\n\nRun **Heron: Open** from the command palette, then **Open folder…**.\n');
}

console.log(`Linked plugin into ${pluginDir}`);
