# Heron

An Obsidian plugin for reading local code: open any folder, read files with syntax highlighting, navigate with language servers, and review git changes. Read-only.

Heron is a fork of [Source Observer](https://github.com/IceKhan13/obsidian-source-observer) by Iskandar Sitdikov (MIT). The `upstream` remote points there.

![Heron](docs/images/hero.png)

## Features

- File tree with git status, syntax highlighting, find in file and go to line
- Code navigation with language servers: go to definition (<kbd>F12</kbd> or <kbd>Mod</kbd>+click), find references (<kbd>Shift</kbd>+<kbd>F12</kbd>), hover documentation, symbols in the file or project, and back/forward
- Changes grouped into conflicts, staged and unstaged, with unified or side-by-side diffs
- Changes against a base branch: everything a branch or worktree changed since it branched off, committed or not (toggle in the **Changes** header)
- Search in files (`git grep` in repositories)
- File history and blame
- Worktree switcher: select the branch name in **Changes**
- Links and live embeds of code in notes
- Rewind: a local history of every change to code in the vault, with who made it (you, Claude Code, git or something else), diffs and restore

## Usage

Run **Heron: Open**, then select **Open folder…** at the top of the sidebar. All actions are also available as commands under **Heron:** in the command palette. In the viewer, <kbd>Mod</kbd>+<kbd>F</kbd> finds in the open file and <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> searches all files.

### Code files in the vault

Code files inside the vault (for example a repository cloned into a `Code/` folder) open as ordinary tabs. Git status colours them in the file explorer, and the right sidebar has a **Code outline** of the active file and **Code changes** for every repository in the vault.

Code opens for reading. Select the pencil in a tab's header (or press <kbd>Mod</kbd>+<kbd>E</kbd>) to edit it: you get undo, bracket closing, autocomplete and signature help from the language server, and error marks. Edits are saved with <kbd>Mod</kbd>+<kbd>S</kbd> and when you leave the tab, not while you type. If the file changes outside Obsidian, Heron reloads it, or keeps your unsaved edits and tells you. Choose whether code opens for reading or editing in **Settings → Heron**.

### Rewind

Rewind keeps a local history of every change to files in the vault's git repositories, like an IDE's local history. It works without commits. The **Rewind** panel in the right sidebar lists the active file's changes, newest first, grouped into moments: one Claude Code prompt ("Claude: add retry to mail sender · 4 files"), one save ("You saved ContentPane.ts"), one git operation ("git checkout main · 12 files"), or a burst of other edits. Select **Repository** at the top to see every change in that repository.

Select a moment or one of its files to see its diff. Its menu (**⋯** or right-click) has **Restore file to this moment**, **Restore file to before this moment**, **Undo this moment** (all its files) and **View file as of this moment**, which shows that version read-only with buttons to step to the previous or next moment. A restore writes through Obsidian and is recorded as a moment of its own, so it can be undone too. Commands: **Show Rewind** and **Undo last moment in this file** (repeat it to step further back).

Each change is labelled with its source:

- **Heron**: saved from a Heron code tab, or restored by Rewind.
- **Claude Code**: written by Claude's **Edit**, **Write** or **MultiEdit** tools, matched by file and time once the hooks below are installed.
- **Git**: a checkout, pull, reset, merge or rebase, from the repository's reflog.
- **Outside Heron**: anything else, such as another editor or a shell command.

**What is stored and where.** Rewind stores a compressed copy of each version of a changed file (identical content is stored once) and a log of changes, in your system's app data folder, not in the vault, so it never syncs: `~/Library/Application Support/Heron/rewind/` on macOS, `%APPDATA%\Heron\rewind\` on Windows, `~/.local/share/Heron/rewind/` on Linux, one folder per vault. Files in `node_modules`, git-ignored files, binary files and files over 2 MB are skipped. The first time Rewind sees a file it records its current content (or the git index's copy), so the first change can be diffed. History older than 14 days is removed, and the oldest history goes first when it grows past 200 MB; change both, or turn Rewind off, in **Settings → Heron → Rewind**.

**Claude Code hooks.** Run **Set up Claude Code hooks for Rewind**. It saves a small Node.js script to Heron's app data folder and shows the hook settings to add to `~/.claude/settings.json` (or a project's `.claude/settings.json`); **Copy settings** copies them. The `UserPromptSubmit` hook records each prompt and the `PostToolUse` hook records which files Claude's edit tools wrote, as JSON lines in `claude-events.jsonl` next to the script. The script prints nothing and always succeeds, so it never changes what Claude does. The log format is described in [docs/claude-hooks.md](docs/claude-hooks.md). Changes Claude makes through shell commands show as **Outside Heron**.

### Language servers

Heron starts a language server for the file you open, in the repository root (or the opened folder), and stops it when you open another folder. Install the servers you need:

| Language | Default command | Install |
| --- | --- | --- |
| Python | `basedpyright-langserver --stdio` | `pipx install basedpyright` or `npm i -g basedpyright` |
| TypeScript, JavaScript | `typescript-language-server --stdio` | `npm i -g typescript-language-server typescript` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |

Change a command, or turn a server off, in **Settings → Heron → Language servers**. Heron finds servers through your login shell's `PATH`, so anything you can run in a terminal works. The server's name in the viewer header shows whether it is starting, loading the project, or unavailable (hover it for the reason).

Navigation commands are under **Heron:** in the command palette: **Go to definition**, **Go to type definition**, **Go to implementation**, **Find references**, **Go to symbol in file…**, **Go to symbol in project…**, **Go back**, **Go forward** and **Restart language servers**. <kbd>Mod</kbd>+<kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> and the mouse's back and forward buttons also move through the history.

### Links and embeds

To reference code from a note, select lines and use the link icon in the viewer header: **Copy link**, **Copy embed** or **Copy as code block**. An embed looks like this:

````markdown
```heron
folder: /Users/me/code/my-project
file: src/server.ts
lines: 40-75
```
````

`file` can be relative to `folder` or absolute. `lines` is optional. Links and embeds use absolute paths, so they only work on the computer that made them.

## Installation

Build with `npm run build` and copy `main.js`, `manifest.json` and `styles.css` to `<vault>/.obsidian/plugins/heron/`. For development, `npm run dev:vault` links them into the test vault (see [CONTRIBUTING.md](CONTRIBUTING.md)).

Requires desktop Obsidian 1.7.2+. Git features need `git` on your `PATH`.

## Privacy

Heron writes a code file only when you save it in editing mode or restore it with Rewind; it never runs git commands that change a repository. Rewind keeps copies of changed files in your system's app data folder, outside the vault (see **Rewind** above), and reads the Claude Code hook log there if you install the hooks; nothing leaves your computer. Delete that folder to remove the history. Language servers are programs you install; Heron runs them with the project folder as their working directory and talks to them over standard input and output. They read the project, and some keep caches or download dependencies (for example `gopls` may fetch Go modules). Heron turns off rust-analyzer's `cargo check` and build scripts so reading a Rust project does not build it. Turn language servers off in settings if you don't want this.

Source Observer makes no network requests. It only runs read-only git commands (`status`, `ls-files`, `cat-file`, `grep`, `log` (including `log -g` for the reflog), `blame`, `diff`, `merge-base`, `rev-parse`, `rev-list`, `for-each-ref`, `symbolic-ref`, `worktree list`) with `--no-optional-locks`, so it never writes to your repository.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
