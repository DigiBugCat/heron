# Claude Code hook log for Rewind (format v1)

Rewind labels changes made by Claude Code using two Claude Code hooks. **Set up Claude Code hooks for Rewind** (command palette) writes the hook script, `claude-hook.mjs`, to Heron's app data folder and shows the settings to add:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"<app data>/Heron/claude-hook.mjs\"" }] }],
    "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "command": "node \"<app data>/Heron/claude-hook.mjs\"" }] }]
  }
}
```

`<app data>` is `~/Library/Application Support` on macOS, `%APPDATA%` on Windows and `$XDG_DATA_HOME` (or `~/.local/share`) on Linux. Claude Code needs `node` on its `PATH`.

## The log

The script appends one JSON object per line to `claude-events.jsonl` in its own folder (or in `$HERON_HOOK_DIR` when set). When the file grows past 5 MB it is renamed to `claude-events.jsonl.1` and a new one is started. The script prints nothing and always exits with code 0.

Every line has these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | number | Format version, `1`. Readers skip lines with versions they don't know. |
| `event` | `"prompt"` or `"tool"` | Which hook wrote the line. |
| `session` | string | Claude Code's `session_id`. |
| `turn` | number or null | The prompt's number within the session, counting from 1. |
| `prompt` | string or null | The prompt text, cut to 2,000 characters. On `tool` lines, the prompt of the current turn. |
| `cwd` | string | Claude Code's working folder. |
| `time` | number | Milliseconds since the epoch, when the hook ran. |

`tool` lines also have:

| Field | Type | Meaning |
| --- | --- | --- |
| `tool` | string | The tool name: `Edit`, `Write` or `MultiEdit`. |
| `files` | string[] | Absolute paths of the files the tool wrote (`tool_input.file_path`, resolved against `cwd`). |

A tool call that wrote no file writes no line. Examples:

```json
{"v":1,"event":"prompt","session":"9f2c…","turn":3,"prompt":"add retry to mail sender","cwd":"/vault/Code/mailer","time":1761480000000}
{"v":1,"event":"tool","session":"9f2c…","turn":3,"prompt":"add retry to mail sender","tool":"Edit","files":["/vault/Code/mailer/src/send.ts"],"cwd":"/vault/Code/mailer","time":1761480004211}
```

To number turns, the script keeps a small state file per session in `claude-sessions/` next to the log (removed after 7 days).

## How Heron uses it

Heron reads new lines every couple of seconds, from where it stopped last time, and keeps `tool` lines whose files are inside one of the vault's repositories. A change to one of those files from up to 20 seconds before the line (or 3 seconds after) is labelled as Claude's, and changes from the same session and turn form one moment, labelled with the prompt.

## Changing the format

Add fields freely; readers ignore fields they don't know. For anything that changes the meaning of existing fields, raise `v` (`HOOK_FORMAT_VERSION` in `src/services/rewind/claudeHook.ts`), keep reading older versions, and update this file.
