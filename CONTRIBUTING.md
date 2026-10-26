# Contributing to Heron

Heron is a fork of [Source Observer](https://github.com/IceKhan13/obsidian-source-observer). The `upstream` remote points there; merge from it to pick up fixes.

## Development setup

You need Node.js 20 or later and git.

```bash
npm install
npm run build
npm run dev:vault
```

`npm run dev:vault` creates `test-vault/` (git-ignored), links the build into `test-vault/.obsidian/plugins/heron` and enables it. Open that folder as a vault in Obsidian and turn off restricted mode once in **Settings → Community plugins**.

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

- **Parsers** (`git status`, `log`, `blame`, `grep`, `worktree list`) are pure functions with plain string fixtures.
- **Git integration tests** create real temporary repositories with `tests/helpers.ts` (`makeRepo`, `write`, `git`), so they need `git` on your `PATH`.
- **UI tests** render real components against `tests/obsidian-shim.ts`, a small stand-in for the parts of the Obsidian API the plugin uses. If you use a new Obsidian API, add it to the shim.

Please add or update tests with every behaviour change; bug fixes should come with a regression test.

## Architecture

```
src/
  main.ts                     plugin lifecycle
  commands.ts                 command palette commands
  settings.ts                 settings model, defaults, validation
  links/
    sourceLink.ts             link, embed and code block formats; embed parsing
    register.ts               obsidian:// handler and code block processor
  lsp/
    framing.ts                LSP base protocol framing (Content-Length headers), pure
    servers.ts                built-in servers, file → server mapping, command parsing
    shellEnv.ts               the login shell's PATH, so GUI-launched Obsidian finds servers
    transport.ts              stdio transport for @codemirror/lsp-client; answers some server requests
    workspace.ts              lsp-client Workspace for Heron's single reused editor
    locations.ts              normalizes definition, reference and symbol responses, pure
    LspManager.ts             starts/stops one server per type and root; status and progress
  github/
    remote.ts                 remote URL → host/owner/name; API bases for github.com and Enterprise, pure
    auth.ts                   token per host: pasted (secret storage or private file), then `gh auth token`
    client.ts                 read-only REST/GraphQL client: pagination, ETags, rate limits, errors
    parse.ts                  API responses → pull requests, files, checks, review threads, pure
    service.ts                clients per host and GitHub repositories per local repository
  git/
    GitRepo.ts                resolves root/git dir/prefix; runs git with --no-optional-locks
    status.ts                 pure parser for `git status --porcelain=v2`
    diffSources.ts            loads the two sides of a diff (changes and commits)
    grep.ts                   `git grep` arguments and output parsing
    history.ts                pure parser for a file's `git log --follow`
    blame.ts                  pure parser for `git blame --porcelain`
    worktrees.ts              pure parser for `git worktree list --porcelain`
  services/
    RepoState.ts              single-flight status refresh with stale-result protection
    RepoWatcher.ts            watches the git dir and working tree; polls only while visible
    FileIndex.ts              cached file list for search (git ls-files or a bounded walk)
    ContentSearch.ts          search in files: git grep, or reading indexed files; match previews
    Worktrees.ts              worktree summaries (changes, ahead/behind) and folder mapping
    rewind/                   Rewind local history: records (log format), HistoryStore (blobs + log,
                              pruning), Recorder (vault events → records), attribution and moments
                              (pure), restore plans, timeline, and the Claude Code hook script and log
  ui/
    SourceObserverView.ts     layout and wiring
    sidebar/                  Files, Search, Changes and History sections, tree, keyboard navigation
    pane/                     content pane and its renderers (code, diff, message);
                              codeIntel.ts adds language server navigation, navHistory.ts back/forward
    locationModals.ts         pickers for references, definitions and symbols
    editor/                   CodeMirror theme, languages, diff stats, blame gutter
    embed/                    live code embeds rendered inside notes
    vault/                    code tabs, outline, changes and diff panels for code in the vault;
                              rewind/ holds Rewind's capture wiring, panel, diff and "as of" tabs
    github/                   Pull requests panel, pull request and file diff tabs, settings, commands
    fileMenu.ts               right-click menu for files, folders and changes
    worktreeMenu.ts           the worktree switcher menu
  utils/                      file reading, icons, paths, request tokens, OS integration
```

A few principles hold the design together:

- **Read-only git.** Only read-only git commands are used, always with `--no-optional-locks`, so the plugin never writes to a repository — not even `.git/index`. New git features must keep this promise; the README's privacy section lists every command.
- **Layers.** `git/` runs and parses git, `services/` holds state and change detection, and `ui/` renders. Parsers are pure functions so they can be tested without git.
- **Components own their cleanup.** Every renderer and sidebar section is an Obsidian `Component`; swapping what is shown tears down the previous editor, DOM and listeners. Register listeners with `registerDomEvent`, `registerEvent` or `register`.
- **Latest request wins.** Async loads go through a `LatestRequest` token (`utils/latest.ts`), so a slow load can never replace a newer selection.
- **Bounded work.** File sizes, search results, history and file indexes are capped, and watchers poll only while the view is visible.

`AGENTS.md` sums up these conventions for coding agents, together with Obsidian API and git pitfalls that are easy to hit — worth a read for human contributors too.

### Rewind

Rewind's history lives outside the vault, in `utils/appData.ts`'s `rewindDir`. `services/rewind/` has no Obsidian imports: the recorder is fed vault events by `ui/vault/rewind/Rewind.ts`, and attribution, grouping and restore planning are pure functions over log records, so evidence that arrives late (a Claude Code hook line) still counts. Tests use temporary folders and repositories (`tests/rewind*.test.ts`). The hook log format is in `docs/claude-hooks.md`.

### Language servers

`@codemirror/lsp-client` handles the protocol, document sync and hover. Heron does definitions, references and symbols itself (`ui/pane/codeIntel.ts`): the library's reference panel can only show files open in an editor, and owning the jumps lets back/forward record only real moves. `tests/fixtures/fake-lsp.mjs` is a tiny server used by `tests/codeNav.test.ts`. `tests/realServers.test.ts` runs against the real `typescript-language-server` and `basedpyright` dev dependencies (or the folder in `HERON_LSP_PATH`), and `npm run dev:vault` points the test vault at the same servers on its first run.

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
