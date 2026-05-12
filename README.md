# claude-puppet

An MCP server that lets a "master" Claude Code session drive one or more `claude` CLI subprocesses ("slaves") through pseudo-terminals — exactly as a human would: typed keys in, rendered screen out. The slaves are unmodified `claude` binaries running in PTYs and cannot tell they are being driven.

## Architecture

```
master claude
   │  MCP/stdio
   ▼
Python MCP server (FastMCP)
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

## Install

```sh
cd /home/ahmed/projects/claude-puppet
uv sync
(cd pty-bridge && npm install && npm run build)
```

## Use

Register in master's `.claude/settings.json` (see `examples/master-mcp-config.json`), then from the master session:

```
open_session(id="s1", cwd="/tmp/demo", permission_mode="acceptEdits")
send_keys(id="s1", keys=["write a fizzbuzz.py", "<Enter>"])
wait_for_idle(id="s1")
read_screen(id="s1")
close_session(id="s1")
```

The slave is real `claude` running in its own PTY with isolated `$HOME`. Slash commands, `@file` autocomplete, permission modals, plan mode — the master drives them all by reading the rendered screen and sending keystrokes.

## Tools

| Tool | Purpose |
|---|---|
| `open_session` | Spawn a slave with isolated HOME and chosen permission mode |
| `send_keys` | Send a sequence of key-names (`<Enter>`, `<C-c>`, `<Tab>`, …) and text fragments |
| `send_text` | Send verbatim text (auto bracketed-paste wrap for >32 chars) |
| `read_screen` | Snapshot the slave's terminal as text + cursor + idle metrics |
| `wait_for_idle` | Block until snapshot-hash stable AND cursor at input row |
| `wait_for` | Block until visible buffer matches a regex |
| `interrupt` | `\x03` (default) or force-kill the foreground process group |
| `resize_session` | Resize the slave's PTY |
| `set_permission_mode` | Best-effort runtime change via `/permissions` keystrokes |
| `list_sessions` | Active session IDs and status |
| `read_log` | Replay the per-session transcript |
| `close_session` | Graceful shutdown ladder (`\x03` → SIGINT → SIGTERM → SIGKILL) |

## Permission modes

Argv-time, set per session at `open_session(permission_mode=...)`:

- `strict` — slave shows permission prompts; master reads screen and answers
- `acceptEdits` — auto-accept file edits, prompt for shell/network
- `plan` — read-only plan mode
- `yolo` — `--dangerously-skip-permissions`

## Always-on services

A pair of `systemd --user` units keep the dashboard and an HTTP MCP server alive across logout / reboot. One-shot install:

```sh
bash scripts/install-services.sh install
# (optional) survive a full reboot when not logged in:
sudo loginctl enable-linger "$USER"
```

That brings up:

- **Dashboard** — http://localhost:5055
- **MCP HTTP server** — http://localhost:5056/mcp (streamable-HTTP transport)

In HTTP mode any master Claude session can attach via `examples/master-mcp-config-http.json` instead of the per-session stdio variant. Slaves opened by one master can be observed/closed by another.

Other commands: `bash scripts/install-services.sh {status,logs,stop,remove}`.

## Status

v0.1 — see `docs/architecture.md` and `/home/ahmed/.claude/plans/do-what-is-better-spicy-eclipse.md`.
