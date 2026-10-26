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
- Margin notes: highlight code and comment on it; notes are ordinary Markdown in the vault and survive edits
- Optional model actions: explain a selection, find similar code, and draw diagrams (off until you turn them on)

## Usage

Run **Heron: Open**, then select **Open folder…** at the top of the sidebar. All actions are also available as commands under **Heron:** in the command palette. In the viewer, <kbd>Mod</kbd>+<kbd>F</kbd> finds in the open file and <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> searches all files.

### Code files in the vault

Code files inside the vault (for example a repository cloned into a `Code/` folder) open as ordinary tabs. Git status colours them in the file explorer, and the right sidebar has a **Code outline** of the active file and **Code changes** for every repository in the vault.

Code opens for reading. Select the pencil in a tab's header (or press <kbd>Mod</kbd>+<kbd>E</kbd>) to edit it: you get undo, bracket closing, autocomplete and signature help from the language server, and error marks. Edits are saved with <kbd>Mod</kbd>+<kbd>S</kbd> and when you leave the tab, not while you type. If the file changes outside Obsidian, Heron reloads it, or keeps your unsaved edits and tells you. Choose whether code opens for reading or editing in **Settings → Heron**.

### Margin notes

Select code in a code tab and choose **Comment** (the speech bubble in the tab's header, the right-click menu, or **Heron: Comment on selection**). Pick a highlight colour and, optionally, write a note and add tags; a note without text is a plain highlight. The code shows the highlight with a badge in the gutter, and hovering it shows the note. The **Code notes** panel in the right sidebar lists the active file's notes in file order; select one to jump to its code, or **Open in note** to see it in its Markdown file.

Notes are saved as Markdown, one note per code file, in `Code notes/<repository>/<path>.md` (change the folder in **Settings → Heron → Code notes**). Each margin note is a `## Note <id>` section with its colour, author, tags, the quoted code and your text, so you can read, link, search and edit them like any other note. Heron finds a note's code by the quoted text and the text around it, not by line numbers, so notes follow the code when it is edited, reformatted, moved or rewritten by an agent. If the quoted code is gone, the note is listed as **Orphaned** at the end of the panel; it is never deleted.

### Model actions

Turn on **Settings → Heron → Model → Use a model** to add these actions to the sparkles button in a code tab's header, the right-click menu and the command palette:

- **Explain selection** asks the model to explain the selected code, using what the language server knows (enclosing symbols, hover text, definitions and callers), and saves the answer as a margin note by the model, tagged `#explain`.
- **Find similar code** collects candidates from references, workspace symbols and `git grep`, and lists the ones the model judges to be the same pattern, with its reason for each.
- **Diagram this file** and **Diagram this symbol** draw a Mermaid diagram from the outline, calls, references and imports, and save it as a note next to the code notes, with links back to the code.

The default model is `claude-haiku-5-5`. Heron reaches it through **Claude Code** (it runs `claude -p` with your Claude Code login, so no key is needed) or the **Anthropic API** with an API key, which is kept in Obsidian's secret storage rather than in the vault. Each action shows its progress in a notice with a **Cancel** button.

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

Requires desktop Obsidian 1.11.4+. Git features need `git` on your `PATH`.

## Privacy

Heron writes a code file only when you save it in editing mode; it never runs git commands that change a repository. Language servers are programs you install; Heron runs them with the project folder as their working directory and talks to them over standard input and output. They read the project, and some keep caches or download dependencies (for example `gopls` may fetch Go modules). Heron turns off rust-analyzer's `cargo check` and build scripts so reading a Rust project does not build it. Turn language servers off in settings if you don't want this.

Heron makes no network requests of its own except the model actions, which are off by default. When you turn them on and run one, the code involved (the selection or file, and context from the language server and `git grep`) is sent to Anthropic, through the Claude Code CLI or the Anthropic API. Nothing is sent in the background. Margin notes and diagrams are written to the notes folder in your vault.

Heron only runs read-only git commands (`status`, `ls-files`, `cat-file`, `grep`, `log`, `blame`, `diff`, `merge-base`, `rev-parse`, `rev-list`, `for-each-ref`, `symbolic-ref`, `worktree list`) with `--no-optional-locks`, so it never writes to your repository.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
