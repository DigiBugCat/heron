# Heron

Heron is the interface between you and the code an LLM writes, built into Obsidian. Keep your repositories inside the vault: their code opens in ordinary tabs with syntax highlighting and language servers, the sidebar shows what changed and who changed it, and your notes can link to, embed and comment on the code.

Heron began as a fork of Source Observer by Iskandar Sitdikov (MIT).

## Features

- **Code in the vault.** Code files open as Obsidian tabs, for reading or editing. The file explorer is coloured by git status.
- **Language servers.** Go to definition, find references, hover documentation, symbols in the file or project, autocomplete and error marks while editing.
- **Search in code.** Full-text search across the vault's repositories with `git grep`, which Obsidian's search does not cover.
- **Changes.** Uncommitted changes in every repository, or everything a branch changed since it left its base branch, with unified or side-by-side diffs.
- **History.** Rewind keeps a local history of every change (yours, Claude Code's, git's), with diffs, restore and undo. The **Commits** scope lists a file's git history; blame shows who last changed each line.
- **Pull requests.** GitHub and GitHub Enterprise pull requests in the sidebar, with checks, changed files and review threads (read-only).
- **Notes on code.** Links and live embeds of code in notes, margin notes that follow the code as it changes, and code maps on canvases.
- **Model actions** (off by default). Explain a selection, find similar code, and draw diagrams.

## Code in the vault

Clone or move a repository into the vault, for example into a `Code/` folder. Heron finds git repositories up to three folders deep (skipping hidden folders and `node_modules`), colours their files in the file explorer (modified orange, new green, a dot on folders with changes) and opens their code files in tabs.

Code opens for reading. Select the pencil in a tab's header (or press <kbd>Mod</kbd>+<kbd>E</kbd>) to edit: you get undo, bracket closing, autocomplete and signature help from the language server, and error marks. Edits are saved with <kbd>Mod</kbd>+<kbd>S</kbd> and when you leave the tab, not while you type. If the file changes outside Obsidian, Heron reloads it, or keeps your unsaved edits and tells you. Choose whether code opens for reading or editing in **Settings → Heron**.

A code tab's header has buttons for blame, code navigation and links. While a code tab is focused:

- <kbd>Mod</kbd>+<kbd>F</kbd> finds in the file, and **Go to line** jumps to a line.
- <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> opens **Search in code**.
- <kbd>F12</kbd> or <kbd>Mod</kbd>+click goes to a definition and <kbd>Shift</kbd>+<kbd>F12</kbd> finds references. Jumps to another file open it in the same tab, so Obsidian's back and forward return to where you were.

All actions are also commands under **Heron:** in the command palette.

## Panels

Heron adds these panels to the right sidebar:

- **Code outline**: the symbols of the active code file, from its language server.
- **Code changes**: each repository's uncommitted changes, grouped into conflicts, staged and changes. Select a change to see its diff in a tab, or the file icon to open the file. The compare button in a repository's header switches it to **changes against its base branch**: everything the branch changed since it branched off, committed or not. The line below the header names the base branch; select it to choose another. Heron uses the remote's default branch, or `main` or `master`, until you choose.
- **Rewind**: the active file's history (see below).
- **Code notes**: the margin notes of the active code file.
- **Pull requests**: the pull requests of the active file's repository.

## Search in code

Run **Search in code** (or press <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> in a code tab). Results appear as you type, as `file:line` with the matching line, from every repository in the vault, the active file's first. The buttons next to the input match case, whole words or a regular expression. Selected text on one line fills in the search. Choose a result to open the file at that line; <kbd>Mod</kbd>+<kbd>Enter</kbd> opens it in a new tab. A search stops after 2,000 results.

## Rewind and commits

Rewind keeps a local history of every change to files in the vault's git repositories, like an IDE's local history. It works without commits. The **Rewind** panel lists the active file's changes, newest first, grouped into moments: one Claude Code prompt ("Claude: add retry to mail sender · 4 files"), one save ("You saved CodeSurface.ts"), one git operation ("git checkout main · 12 files"), or a burst of other edits. Select **Repository** at the top to see every change in that repository, or **Commits** for the file's git history (`git log --follow`, so renames are followed). Selecting a commit shows the change it made to the file in a diff tab; so does selecting a line in the blame gutter. **Show file history** opens the **Commits** scope.

Select a moment or one of its files to see its diff. Its menu (**⋯** or right-click) has **Restore file to this moment**, **Restore file to before this moment**, **Undo this moment** (all its files) and **View file as of this moment**, which shows that version read-only with buttons to step to the previous or next moment. A restore writes through Obsidian and is recorded as a moment of its own, so it can be undone too. Commands: **Show Rewind** and **Undo last moment in this file** (repeat it to step further back).

Each change is labelled with its source:

- **Heron**: saved from a Heron code tab, or restored by Rewind.
- **Claude Code**: written by Claude's **Edit**, **Write** or **MultiEdit** tools, matched by file and time once the hooks below are installed.
- **Git**: a checkout, pull, reset, merge or rebase, from the repository's reflog.
- **Outside Heron**: anything else, such as another editor or a shell command.

**What is stored and where.** Rewind stores a compressed copy of each version of a changed file (identical content is stored once) and a log of changes, in your system's app data folder, not in the vault, so it never syncs: `~/Library/Application Support/Heron/rewind/` on macOS, `%APPDATA%\Heron\rewind\` on Windows, `~/.local/share/Heron/rewind/` on Linux, one folder per vault. Files in `node_modules`, git-ignored files, binary files and files over 2 MB are skipped. The first time Rewind sees a file it records its current content (or the git index's copy), so the first change can be diffed. History older than 14 days is removed, and the oldest history goes first when it grows past 200 MB; change both, or turn Rewind off, in **Settings → Heron → Rewind**.

**Claude Code hooks.** Run **Set up Claude Code hooks for Rewind**. It saves a small Node.js script to Heron's app data folder and shows the hook settings to add to `~/.claude/settings.json` (or a project's `.claude/settings.json`); **Copy settings** copies them. The `UserPromptSubmit` hook records each prompt and the `PostToolUse` hook records which files Claude's edit tools wrote, as JSON lines in `claude-events.jsonl` next to the script. The script prints nothing and always succeeds, so it never changes what Claude does. The log format is described in [docs/claude-hooks.md](docs/claude-hooks.md). Changes Claude makes through shell commands show as **Outside Heron**.

## Language servers

Heron starts a language server for the code file you open, in its repository's root. Install the servers you need:

| Language | Default command | Install |
| --- | --- | --- |
| Python | `basedpyright-langserver --stdio` | `pipx install basedpyright` or `npm i -g basedpyright` |
| TypeScript, JavaScript | `typescript-language-server --stdio` | `npm i -g typescript-language-server typescript` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |

Change a command, or turn a server off, in **Settings → Heron → Language servers**. Heron finds servers through your login shell's `PATH`, so anything you can run in a terminal works. The status bar shows the active code tab's server and whether it is starting, loading the project, or unavailable (hover it for the reason).

Navigation commands: **Go to definition**, **Go to type definition**, **Go to implementation**, **Go to declaration**, **Find references**, **Go to symbol in file…**, **Go to symbol in project…** and **Restart language servers**.

## Links and embeds

To reference code from a note, select lines in a code tab and use the link button in its header: **Copy link to selection**, **Copy embed of selection** or **Copy selection as code block** (the whole file when nothing is selected), or **Copy link to file** for an ordinary Obsidian link to a file in the vault. The first three are also commands. An embed shows the lines live and looks like this:

````markdown
```heron
folder: /Users/me/vault/Code/my-project
file: src/server.ts
lines: 40-75
```
````

`file` can be relative to `folder` or absolute, and `lines` is optional. Links look like `obsidian://heron?folder=…&file=…&lines=40-75`. Selecting a link, or an embed's header, opens the file in a code tab with the lines highlighted: a file in the vault in its usual tab, any other file in a read-only code tab. Links and embeds use absolute paths, so they only work on the computer that made them.

## Margin notes

Select code in a code tab and choose **Comment** (the speech bubble in the tab's header, the right-click menu, or **Heron: Comment on selection**). Pick a highlight colour and, optionally, write a note and add tags; a note without text is a plain highlight. The code shows the highlight with a badge in the gutter, and hovering it shows the note. The **Code notes** panel lists the active file's notes in file order; select one to jump to its code, or **Open in note** to see it in its Markdown file.

Notes are saved as Markdown, one note per code file, in `Code notes/<repository>/<path>.md` (change the folder in **Settings → Heron → Code notes**). Each margin note is a `## Note <id>` section with its colour, author, tags, the quoted code and your text, so you can read, link, search and edit them like any other note. Heron finds a note's code by the quoted text and the text around it, not by line numbers, so notes follow the code when it is edited, reformatted, moved or rewritten by an agent. If the quoted code is gone, the note is listed as **Orphaned** at the end of the panel; it is never deleted.

## Model actions

Turn on **Settings → Heron → Model → Use a model** to add these actions to the sparkles button in a code tab's header, the right-click menu and the command palette:

- **Explain selection** asks the model to explain the selected code, using what the language server knows (enclosing symbols, hover text, definitions and callers), and saves the answer as a margin note by the model, tagged `#explain`.
- **Find similar code** collects candidates from references, workspace symbols and `git grep`, and lists the ones the model judges to be the same pattern, with its reason for each.
- **Diagram this file** and **Diagram this symbol** draw a Mermaid diagram from the outline, calls, references and imports, and save it as a note next to the code notes, with links back to the code.

The default model is `claude-haiku-5-5`. Heron reaches it through **Claude Code** (it runs `claude -p` with your Claude Code login, so no key is needed) or the **Anthropic API** with an API key, which is kept in Obsidian's secret storage rather than in the vault. Each action shows its progress in a notice with a **Cancel** button.

## Pull requests

For repositories in the vault whose `origin` remote is on GitHub (github.com or a GitHub Enterprise host), run **Heron: Show pull requests**. The **Pull requests** panel lists the open pull requests of the repository of the active file (pick another from its menu), grouped into **Review requested**, **Yours** and **Others**, with check status, unresolved review threads and when each was last updated. It loads when you open it, when Obsidian regains focus (at most once a minute) and when you select the refresh button.

Selecting a pull request opens a tab with its description, checks, changed files and review threads. Selecting a file opens its diff, fetched from GitHub at the pull request's commits (nothing is checked out), with review threads marked in the gutter and listed below. **Heron: Open pull request for current branch** finds the pull request for the branch you have checked out, and **Heron: Copy pull request link** copies its link. Commenting and reviewing are not supported yet.

Heron needs a token for each host. It uses, in this order:

1. A token pasted in **Settings → Heron → GitHub**. Heron keeps it in Obsidian's secret storage (Obsidian 1.11.4 and later), or else in a file only you can read, `~/.config/heron/github-tokens.json` — never in the vault.
2. Your [GitHub CLI](https://cli.github.com) login: `gh auth login` for github.com, `gh auth login --hostname github.example.com` for GitHub Enterprise.

A classic token needs the `repo` scope for private repositories; a fine-grained token needs read access to pull requests, contents, commit statuses and checks. On GitHub Enterprise Server, Heron uses `https://<host>/api/v3` and `https://<host>/api/graphql`. **Test connection** in settings checks a token by asking GitHub which account it belongs to.

## Code maps

A code map is a canvas of a folder's source files and the imports between them, to see how a codebase fits together and what changed. Run **Generate code map for this repository** (the repository of the active file), **Generate code map for folder…**, or select **Generate code map** on a folder in the file explorer. The map is saved as `Code maps/<folder>.canvas`; choose another folder in **Settings → Heron**.

- Each file is a card with a link to it, its top-level symbols, its line count and how many outside packages it uses. Cards sit in a group per folder, and arrows point from a file to the files it imports.
- Changed files are orange, new files green and conflicts red, from git status.
- Imports are read from TypeScript, JavaScript, Python, Go and Rust files, including `tsconfig.json` path aliases, Python packages, Go modules and Rust modules. Language servers are not needed.
- A folder with more than 150 source files can be mapped as folders instead (arrows count the imports between them), or you can choose a subfolder.
- Run **Update code map** in an open map after the code changes: cards you moved stay where you put them, new files appear near their folder, deleted ones disappear and colours are refreshed. Cards and arrows you added yourself are kept.

With a language server running, put the cursor on a function and run **Show call graph for symbol at cursor** to draw what it calls and what calls it, two calls deep each way, grouped by file. Saved as `Code maps/Call graph - <name>.canvas`.

## Installation

Build with `npm run build` and copy `main.js`, `manifest.json` and `styles.css` to `<vault>/.obsidian/plugins/heron/`. For development, `npm run dev:vault` links them into the test vault (see [CONTRIBUTING.md](CONTRIBUTING.md)).

Requires desktop Obsidian 1.11.4+. Git features need `git` on your `PATH`.

## Privacy

Heron writes a code file only when you save it in editing mode or restore it with Rewind, and writes code maps only to the canvases you generate; it never runs git commands that change a repository. Rewind keeps copies of changed files in your system's app data folder, outside the vault (see **Rewind and commits** above), and reads the Claude Code hook log there if you install the hooks; nothing leaves your computer. Delete that folder to remove the history. Language servers are programs you install; Heron runs them with the repository as their working directory and talks to them over standard input and output. They read the project, and some keep caches or download dependencies (for example `gopls` may fetch Go modules). Heron turns off rust-analyzer's `cargo check` and build scripts so reading a Rust project does not build it. Turn language servers off in settings if you don't want this.

Model actions are off by default. When you turn them on and run one, the code involved (the selection or file, and context from the language server and `git grep`) is sent to Anthropic, through the Claude Code CLI or the Anthropic API. Nothing is sent in the background. Margin notes and diagrams are written to the notes folder in your vault.

Heron contacts GitHub only for repositories with a GitHub remote, and only while you use the pull request features: the **Pull requests** panel while it is shown, pull request tabs, the pull request commands and **Test connection**. It only reads (GET requests and GraphQL queries) and never changes anything on GitHub. To find a token it may run `gh auth token`. It only runs read-only git commands (`status`, `ls-files`, `cat-file`, `grep`, `log` (including `log -g` for the reflog), `blame`, `diff`, `merge-base`, `rev-parse`, `rev-list`, `for-each-ref`, `symbolic-ref`, `remote get-url`) with `--no-optional-locks`, so it never writes to your repository. Apart from GitHub and the model actions, Heron makes no network requests and collects no telemetry.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
