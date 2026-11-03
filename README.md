# Harness Lens

A small read-only Hermes plugin: **how many times each session shelled out to a
coding-agent harness** — Claude Code (`claude -p`), Codex (`codex exec`),
Antigravity (`agy -p`), OpenCode (`opencode run`), Copilot CLI (`copilot -p`),
Gemini CLI (`gemini -p`) and a nested `hermes chat -q`.

Hermes records those workers only as `terminal` / `execute_code` calls — no
session, no tokens, no cost — so Session Lens cannot show them. Harness Lens
scans the recorded tool-call arguments in `state.db` and counts matches of each
harness's non-interactive form.

## What you get

A **Harness Lens** sidebar page: one row per session that invoked a harness,
with per-harness counts, failed invokes (launch exit code ≠ 0), the session's
own cost/tokens, project (git root or cwd), model, last invoke. Sortable
columns, free-text search with filters (`harness:codex project:chair min:5
failed:yes model: source: profile: id:`), harness chips that filter, period
(7/30/90/all), profile scope (this / all), Copy CSV. Expanding a row lists every
invocation: time, harness, status, duration, cwd and the command snippet
(secret-looking `key=value` pairs redacted). "Open session" jumps to the chat.

## Limits (read these)

- Counts are **launches Hermes itself ran**. A harness started by a script,
  a scheduled task, or by you in a shell is not seen.
- A command whose text merely *contains* a harness form (e.g. writing a doc
  that quotes `claude -p`) counts too — the match is textual.
- Interactive launches (`claude` with no `-p`, `codex` TUI) are ignored.
- For background launches (`background: true`) the exit code and duration are
  those of the launch, not of the worker; such rows are marked `bg`.
- Cost and tokens shown are the **Hermes session's**. The workers bill their
  own accounts; pull their transcripts (`~/.claude/projects`, `~/.codex/sessions`)
  for that.

## Install

Unified package: the backend half mounts at `/api/plugins/harness-lens/`
(GET only, no writes, no network), the desktop half is `desktop/plugin.js`.

On the machine running the backend (`hermes serve` / Desktop):

```text
git clone <this repo> $HERMES_HOME/plugins/harness-lens
hermes plugins enable harness-lens
```

The Desktop app copies the desktop half on Rescan / restart. For a Desktop app
pointed at a **remote** backend, the desktop half must be cloned onto that
machine too: Capabilities → Plugins → Install from Git → this repo URL, with the
Desktop target ticked.

## API

- `GET /health`
- `GET /harnesses` — the registry with each regex
- `GET /sessions?days=30&profiles=` — `profiles` empty = serving profile, `all`, or a comma list
- `GET /sessions/{id}/invocations?profiles=`

## Development

```text
node --input-type=module --check < desktop/plugin.js
hermes plugins validate .
```
