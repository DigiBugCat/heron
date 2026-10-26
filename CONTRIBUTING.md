# Contributing to Heron

## Development setup

You need Node.js 20 or later and git.

```bash
npm install
npm run build
npm run dev:vault
```

`npm run dev:vault` creates `test-vault/` (git-ignored), links the build into `test-vault/.obsidian/plugins/heron` and enables it. Open that folder as a vault in Obsidian and turn off restricted mode once in **Settings → Community plugins**. Clone a repository into the test vault to try the code features.

| Command | What it does |
| --- | --- |
| `npm run dev` | Rebuilds `main.js` on every change. Reload the plugin (or Obsidian) to pick it up. |
| `npm run dev:vault` | Links the build into `test-vault/`. |
| `npm run build` | Type-checks and makes a production build. |
| `npm run lint` | ESLint, including Obsidian's plugin rules. |
| `npm test` | Unit, git integration and DOM tests with Vitest. |

CI runs build, lint and tests on Node 20, 22 and 24 for every push and pull request.

## Tests

Tests live in `tests/` and run in Node, with jsdom for UI tests:

- **Parsers** (`git status`, `log`, `blame`, `grep`, `diff --name-status`) are pure functions with plain string fixtures.
- **Git integration tests** create real temporary repositories with `tests/helpers.ts` (`makeRepo`, `write`, `git`), so they need `git` on your `PATH`.
- **UI tests** render real components against `tests/obsidian-shim.ts`, a small stand-in for the parts of the Obsidian API the plugin uses: DOM helpers, `Component`, `ItemView` and `FileView` without a workspace, modals that record themselves, menus that record their items. Views are tested by constructing them with a fake `app` and calling `load()` and `onOpen()`. If you use a new Obsidian API, add it to the shim.

Please add or update tests with every behaviour change; bug fixes should come with a regression test.

## Architecture

Heron works on code that lives in the vault. Code files open in tabs (`ui/vault/codeTabs.ts`), the right sidebar has the panels, and everything else hangs off those two.

```
src/
  main.ts                     plugin lifecycle: views, panels, links, settings tab; opening diffs, files and search
  commands.ts                 command palette commands (IDs are stable)
  settings.ts                 settings model, defaults, validation
  links/
    sourceLink.ts             link, embed and code block formats; embed parsing
    register.ts               obsidian:// handler and code block processor
  lsp/
    framing.ts                LSP base protocol framing (Content-Length headers), pure
    servers.ts                built-in servers, file → server mapping, command parsing
    shellEnv.ts               the login shell's PATH, so GUI-launched Obsidian finds servers
    transport.ts              stdio transport for @codemirror/lsp-client; answers some server requests
    workspace.ts              lsp-client Workspace for an editor that is reused across files
    locations.ts              normalizes definition, reference and symbol responses, pure
    LspManager.ts             starts/stops one server per type and root; status and progress
    callHierarchy.ts          call graph around a symbol from callHierarchy requests
    requests.ts               raw server access for model actions; hover and call hierarchy parsing, pure
  codemap/                    code maps, pure (no Obsidian imports)
    mask.ts                   blanks comments and strings so keyword searches stay in code
    imports.ts                import parsers for TS/JS, Python, Go and Rust
    resolve.ts                resolves imports to repository files (tsconfig paths, packages, modules)
    tsconfig.ts               tsconfig/jsconfig `paths`, `baseUrl` and `extends`; JSON with comments
    outline.ts                top-level symbols from a quick declaration scan
    graph.ts                  file graph, and the folder graph for large folders
    layout.ts                 deterministic layered layout with folder groups
    canvas.ts                 JSON Canvas output, stable ids, and the merge that keeps moved cards
    models.ts, callMap.ts     card texts and colours for file, folder and call maps
  github/
    remote.ts                 remote URL → host/owner/name; API bases for github.com and Enterprise, pure
    auth.ts                   token per host: pasted (secret storage or private file), then `gh auth token`
    client.ts                 read-only REST/GraphQL client: pagination, ETags, rate limits, errors
    parse.ts                  API responses → pull requests, files, checks, review threads, pure
    service.ts                clients per host and GitHub repositories per local repository
  notes/
    anchor.ts                 text-quote anchoring of margin notes (exact, whitespace-insensitive, approximate), pure
    noteFormat.ts             the Markdown format of a code file's notes; tolerant, lossless parse and serialize
    notePaths.ts              where notes and diagrams live in the vault
    diagramNote.ts            the note a model-drawn diagram is saved as
    settings.ts               code notes and model settings, defaults, validation
  model/
    client.ts                 LLM client: Anthropic Messages API (injected HTTP) or `claude -p`
    context.ts                identifiers, imports and outlines to tell the model about, pure
    prompts.ts                prompts for explain, find similar and diagram, with size caps, pure
    parse.ts                  reading model replies (explanations, rankings, Mermaid), pure
  git/
    GitRepo.ts                resolves root/git dir/prefix; runs git with --no-optional-locks
    status.ts                 pure parser for `git status --porcelain=v2`; change groups and kinds
    baseDiff.ts               pure parser for `git diff --name-status` against a merge base
    diffSources.ts            loads the two sides of a diff (changes, base changes and commits)
    grep.ts                   `git grep` arguments and output parsing
    history.ts                pure parser for a file's `git log --follow`
    blame.ts                  pure parser for `git blame --porcelain`
  services/
    RepoState.ts              single-flight status refresh with stale-result protection
    RepoWatcher.ts            watches the git dir and working tree
    BaseComparison.ts         changes since the merge base with a base branch; one comparison per repository
    ContentSearch.ts          search in code: `git grep` per repository, capped across repositories; match previews
    folderWalk.ts             bounded folder walk, for code maps of folders git cannot list
    rewind/                   Rewind local history: records (log format), HistoryStore (blobs + log,
                              pruning), Recorder (vault events → records), attribution and moments
                              (pure), restore plans, timeline, and the Claude Code hook script and log
    CodeMapSource.ts          reads a folder for a code map and builds the canvas text
    CodeNotesStore.ts         reads and writes margin notes through a small vault interface
    actionSource.ts           what model actions work on (file, server, grep) and shared helpers
    modelActions.ts           explain and find similar: gather context, ask the model
    modelDiagram.ts           diagrams from the outline, imports and call hierarchy
  ui/
    SettingTab.ts             the settings tab
    locationModals.ts         pickers for references, definitions and symbols
    pane/                     renderers (code, diff, message) and codeIntel.ts, the language server
                              navigation a code view gets
    editor/                   CodeMirror theme, languages, diff stats, blame gutter
    embed/                    live code embeds rendered inside notes
    vault/
      codeTabs.ts             code tabs: vault files (CodeFileView) and files outside the vault (ExternalCodeView)
      CodeSurface.ts          one code editor with language servers, blame, find and links, as a tab shows it
      openCode.ts             opening a file in a code tab at a cursor or lines; links and embeds
      CodeSearchModal.ts      Search in code
      ExplorerGit.ts          finds the vault's repositories, tracks their status, colours the file explorer
      ChangesView.ts          Code changes panel, with the per-repository base branch toggle (baseMenu.ts)
      DiffView.ts             diff tabs: uncommitted changes, changes against a base branch, one commit's change
      OutlineView.ts          Code outline panel
      rewind/                 Rewind's capture wiring, the Rewind panel (moments and the Commits scope),
                              diff and "as of" tabs
    notes/                    margin notes in code tabs (decorations, controller, Code notes panel,
                              comment modal) and the model actions' UI (progress, cancel, settings)
    github/                   Pull requests panel, pull request and file diff tabs, settings, commands
    codemap/                  code map commands, folder picker, and writing canvases to the vault
  utils/                      file reading, icons, paths, request tokens, OS integration
```

A few principles hold the design together:

- **Read-only git.** Only read-only git commands are used, always with `--no-optional-locks`, so the plugin never writes to a repository — not even `.git/index`. New git features must keep this promise; the README's privacy section lists every command.
- **Layers.** `git/` runs and parses git, `services/` holds state and change detection, and `ui/` renders. Parsers are pure functions so they can be tested without git.
- **Native Obsidian.** Code is shown in Obsidian tabs and panels, never in a view of Heron's own: files open with `openFile` (or an external code tab for files outside the vault), cursors and highlighted lines travel as ephemeral state (`heronCursor`, `heronLines`), and back and forward are Obsidian's. Use only the public API in `obsidian.d.ts`.
- **Components own their cleanup.** Every renderer, panel and embed is an Obsidian `Component`; replacing what is shown tears down the previous editor, DOM and listeners. Register listeners with `registerDomEvent`, `registerEvent` or `register`.
- **Latest request wins.** Async loads go through a `LatestRequest` token (`utils/latest.ts`), so a slow load can never replace a newer one.
- **Bounded work.** File sizes, search results, history and file lists are capped.

`AGENTS.md` sums up these conventions for coding agents, together with Obsidian API and git pitfalls that are easy to hit — worth a read for human contributors too.

### Rewind

Rewind's history lives outside the vault, in `utils/appData.ts`'s `rewindDir`. `services/rewind/` has no Obsidian imports: the recorder is fed vault events by `ui/vault/rewind/Rewind.ts`, and attribution, grouping and restore planning are pure functions over log records, so evidence that arrives late (a Claude Code hook line) still counts. Tests use temporary folders and repositories (`tests/rewind*.test.ts`). The hook log format is in `docs/claude-hooks.md`. The panel's **Commits** scope reads `git log --follow` through `ExplorerGit.repoAt` and opens commits in diff tabs (`tests/commits.test.ts`).

### Language servers

`@codemirror/lsp-client` handles the protocol, document sync and hover. Heron does definitions, references and symbols itself (`ui/pane/codeIntel.ts`): the library's reference panel can only show files open in an editor. A jump to another file goes through the code tab, which opens it in the same tab, so Obsidian's history records it. `tests/fixtures/fake-lsp.mjs` is a tiny server used by `tests/codeNav.test.ts`, which drives a `CodeSurface` with a small fake tab. `tests/realServers.test.ts` runs against the real `typescript-language-server` and `basedpyright` dev dependencies (or the folder in `HERON_LSP_PATH`), and `npm run dev:vault` points the test vault at the same servers on its first run.

### Margin notes and model actions

Margin notes are anchored by quoted text and context (`notes/anchor.ts`, after the MIT-licensed [Lectern](https://github.com/sqxirts/lectern) plugin), never by line numbers, and re-anchored whenever the code or its note file changes. The model actions build their prompts and read replies in pure functions; tests use a fake model and the fake language server, and `tests/fixtures/fake-claude.mjs` stands in for `claude -p`. Tests never reach the network. The CLI transport runs `claude -p` in the temp folder with no tools, settings, MCP servers or skills: without those flags every call carries the user's whole Claude Code setup (hundreds of thousands of tokens).

## Pull requests

- Keep each pull request focused on one change, and describe what it does and how you tested it.
- Make sure `npm run build`, `npm run lint` and `npm test` pass.
- Update the README when you add a feature users should know about, and its privacy section if you run a new git command. Keep it short.
- UI text uses sentence case and Obsidian's style: "select" rather than "click", and **bold** for labels.
- Don't commit build output (`main.js`) or `node_modules/`.

## Releasing

Maintainers release from `master`:

1. Run `npm version minor` (or `patch`/`major`). This updates `package.json`, `manifest.json` and `versions.json`, commits, and creates a tag without a `v` prefix.
2. Push the commit and the tag: `git push && git push --tags`.
3. The release workflow builds the plugin and creates a **draft** GitHub release with `main.js`, `manifest.json` and `styles.css`. Add release notes and publish it; Obsidian picks up the new version from there.

If a release needs a newer Obsidian API, raise `minAppVersion` in `manifest.json` before running `npm version`.
