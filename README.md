# claude-puppet

An MCP server that lets a "master" Claude Code session drive one or more `claude` CLI subprocesses ("slaves") through pseudo-terminals — exactly as a human would: typed keys in, rendered screen out. The slaves are unmodified `claude` binaries running in PTYs and cannot tell they are being driven.

> **Note (2026-05-13):** Dashboard temporarily removed pending a round 2 fix.
> Round 2 QA found a critical bug where the WebSocket endpoint was
> auth-less and leaked the entire session inventory and live event stream
> to any local process. Four other minor bugs were also found. The MCP
> server at `:5056` is unaffected. Dashboard will return after the fix
> is verified.

## Architecture

```
master claude
   │  MCP/HTTP (:5056/mcp)  ← default; --stdio for direct stdio
   ▼
Python MCP server (FastMCP)               systemd: claude-puppet-mcp.service
   │  length-prefix JSON over stdio
   ▼
Node pty-bridge worker (node-pty + @xterm/headless)
   │  PTYs (one each)
   ▼
slave claude   slave claude   ...
```

**Hybrid Python + Node** because each language wins one half of the problem decisively:

- **Node** owns the OS/terminal layer: `node-pty` for PTY spawn, `@xterm/headless` for emulation (the same code that powers VS Code's terminal). Also owns the key-name vocabulary and per-session transcript logging.
- **Python** owns the master-facing MCP surface: FastMCP tool decorators, HOME isolation, permission-mode plumbing, screen-pattern heuristics, lifecycle cascade.

## How is this different from Claude Code's built-in subagents?

Claude Code already ships a `Task` tool that spawns subagents (Explore, Plan, general-purpose, …). It's the right tool for *most* delegation. claude-puppet is for the cases where it isn't.

| | Built-in `Task` subagent | claude-puppet slave |
|---|---|---|
| **Mechanism** | API call to a subagent runtime | Real `claude` CLI binary in a PTY |
| **State** | Stateless — each `Task()` is a fresh agent | Stateful — same `session_id` persists across calls; resumable across master restarts |
| **Observability mid-execution** | None — one response when it returns | `read_screen()`, `drain_events()` |
| **Interactivity** | None — one round-trip | Full TUI: slash commands (`/plan`, `/permissions`), `@file` autocomplete, permission modals, plan-mode approvals |
| **Permission modes** | Inherits master's | Per-slave: `strict` / `acceptEdits` / `plan` / `yolo` |
| **Interruption** | Cannot interrupt mid-run | `interrupt()` Ctrl-C; `force=True` runs SIGINT→SIGTERM→SIGKILL ladder |
| **HOME / auth isolation** | Shares master's | Each slave gets its own `$HOME` under `~/.cache/claude-puppet/sessions/<id>/home/` |
| **Persistence** | Lifetime ends at function return | Slaves outlive their master — daemon owns the bridge |
| **Recursion** | No — subagents can't spawn subagents | Yes (gated) — `nested_puppetry=True`, with monotonic permission tightening + depth cap |
| **Multi-slave fan-out** | Sequential `Task()` calls | `drain_events(owner=…)` — one multiplexed long-poll over N slaves |
| **Audit trail** | Inline tool result | Per-session JSONL transcript |

**Use the built-in `Task` tool when** the work is short, structured, and one-shot ("research X, return findings").

**Use claude-puppet when** the work needs real-CLI features (plan mode review, interactive permission flows, slash commands), long-running attention, mid-task observation, or you want the slave to keep going while the master moves on.

## Install (one shot — gets you exactly the maintainer's setup)

```sh
git clone https://github.com/aalghuroury/claude-puppet
cd claude-puppet
bash scripts/install.sh
```

That single command:

1. Builds the pty-bridge (`npm install && npm run build` inside `pty-bridge/`)
2. Resolves Python deps (`uv sync`)
3. Copies `skill/SKILL.md` → `~/.claude/skills/claude-puppet/SKILL.md` — so any fresh master claude session auto-loads it when it hears trigger phrases like *"spawn a slave"*, *"use the puppet"*, *"open a parallel claude"*
4. Copies `hooks/puppet-{flush,peek,drain}.sh` → `~/.claude/hooks/` — token-economy helpers the master invokes via the `Bash` tool
5. Registers the MCP server in `~/.claude.json` under `mcpServers.claude-puppet` as `{type: "http", url: "http://localhost:5056/mcp"}` *(this is the file Claude Code actually reads MCP servers from — NOT `~/.claude/settings.json`)*
6. Sets `env.ENABLE_EXPERIMENTAL_MCP_CLI=true` in `~/.claude/settings.json`
7. Installs `claude-puppet-mcp.service` as a systemd user unit, enables and starts it
8. Runs verification checks and prints a one-line summary

After install, in a fresh master session:

```
> spawn a slave claude in /tmp/demo, have it write fizzbuzz.py, then close it
```

If the master proposes `open_session(...)` — install worked. The SKILL auto-trigger surfaced the puppet, and the MCP tools loaded via `mcpServers.claude-puppet`.

**Optional flags:**

| Flag | Effect |
|---|---|
| `--stdio` | Use stdio MCP transport instead of HTTP daemon. No always-on services; one MCP server per master session. |
| `--no-services` | Skip systemd user units (only useful with `--stdio`, or when you manage the services externally). |
| `--wire-drain-hook` | Auto-prepend fresh slave events to every master prompt via `hooks.UserPromptSubmit` (OPT-IN — the maintainer doesn't have this wired). |
| `--force` | Overwrite an existing SKILL / hooks / MCP entry. Re-runs are safe and idempotent by default. |

**Survive reboot when not logged in:**

```sh
sudo loginctl enable-linger "$USER"
```

## What lands where

| Path | Role |
|---|---|
| `~/.claude/skills/claude-puppet/SKILL.md` | Master auto-loads when puppet trigger phrases appear |
| `~/.claude/hooks/puppet-{flush,peek,drain}.sh` | Token-economy helpers |
| `~/.claude.json` → `mcpServers.claude-puppet` | MCP server registration (HTTP type) |
| `~/.claude/settings.json` → `env.ENABLE_EXPERIMENTAL_MCP_CLI` | Enable flag |
| `~/.config/systemd/user/claude-puppet-mcp.service` | MCP HTTP daemon at :5056 |
| `~/.cache/claude-puppet/state.db` | SQLite session registry (WAL) |
| `~/.cache/claude-puppet/sessions/<id>/` | Per-slave HOME + transcripts |

## Manual use (no SKILL, just the MCP tools)

```
open_session(id="s1", cwd="/tmp/demo", permission_mode="acceptEdits")
send_keys(id="s1", keys=["write a fizzbuzz.py", "<Enter>"])
wait_for_idle(id="s1")
read_screen(id="s1")
close_session(id="s1")
```

The slave is real `claude` running in its own PTY with isolated `$HOME`. Slash commands, `@file` autocomplete, permission modals, plan mode — the master drives them all by reading the rendered screen and sending keystrokes.

## Tool surface

| Tool | Purpose |
|---|---|
| `open_session` | Spawn a slave with isolated HOME and chosen permission mode. Args include `parent_id` + `nested_puppetry` for sub-spawn capability. |
| `send_keys` | Sequence of key-names (`<Enter>`, `<C-c>`, `<Tab>`, …) and text fragments |
| `send_text` | Verbatim text (auto bracketed-paste wrap for >32 chars) |
| `read_screen` | Snapshot the slave's terminal — default *deltas only*, pass `force_full=True` for fresh full snapshots. Class-aware: filters chrome/status by default. |
| `wait_for_idle` | Block until snapshot-hash stable AND cursor at input row |
| `wait_and_read` | One-shot `wait_for_idle` + `read_screen` (preferred for single-slave polling) |
| `drain_events` | **Multiplexed long-poll** — preferred for N>1 slaves. Returns `new_lines` / `prompt_visible` / `exited` events from whichever slave emits first. |
| `wait_for` | Block until visible buffer matches a regex |
| `interrupt` | `\x03` (default) or `force=True` for SIGINT→SIGTERM→SIGKILL ladder |
| `resize_session` | Resize the slave's PTY |
| `set_permission_mode` | Best-effort runtime change via `/permissions` keystrokes |
| `set_nested_puppetry` | Grant or revoke a slave's sub-spawn capability at runtime |
| `list_sessions` | Active session IDs + status (filter by `owner`/`status`) |
| `list_descendants` | BFS subtree rooted at a session |
| `session_tree` | Whole-DB nested tree |
| `resume_session` | Reconnect to a DB-known session across master restarts |
| `read_log` | Replay the per-session transcript |
| `close_session` | Graceful shutdown ladder |

See `skill/SKILL.md` for the full operator playbook — event-driven supervision patterns, token-economy advice, permission-mode trade-offs, nested-mastery rules.

## Permission modes

Argv-time, set per session at `open_session(permission_mode=...)`:

- `strict` — slave shows permission prompts; master reads screen and answers
- `acceptEdits` — auto-accept file edits, prompt for shell/network
- `plan` — read-only plan mode
- `yolo` — `--dangerously-skip-permissions`

## Tear-down

```sh
bash scripts/install-services.sh remove          # stop + remove systemd units
# manual:
rm -rf ~/.claude/skills/claude-puppet ~/.claude/hooks/puppet-*.sh
python3 -c "import json; p='$HOME/.claude.json'; d=json.load(open(p)); d['mcpServers'].pop('claude-puppet',None); open(p,'w').write(json.dumps(d,indent=2))"
```

## Status

v0.1 — see `docs/architecture.md` and `skill/SKILL.md` for the operator playbook.

## License

Proprietary / All Rights Reserved. See [LICENSE](./LICENSE) — no use, copy, modify, distribute, or AI-training-data use is permitted without explicit written permission from the copyright holder.
