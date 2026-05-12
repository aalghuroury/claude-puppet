# claude-puppet architecture

Distilled from `/home/ahmed/.claude/plans/do-what-is-better-spicy-eclipse.md`.
That plan is the source of truth for design decisions; this doc summarizes
them for readers who don't need every rationale.

## 1. Goal & motivation

The system lets one Claude Code session ("master") drive one or more `claude`
CLI subprocesses ("slaves") with full feature parity to a human at a
terminal — every keystroke, every slash command, every permission prompt,
every plan-mode interaction. Slaves are **unmodified** binaries running in
pseudo-terminals; from their perspective, bytes simply arrive on stdin.

This is achievable today because the entire Claude Code interaction surface
reduces to "render bytes to a screen" and "read bytes from a keyboard".
Spawn `claude` inside a PTY, expose two MCP primitives — *read the rendered
screen* and *send keystrokes* — and the master becomes the human. Slash
commands, `@file` autocomplete, permission modals, `Ctrl-C`, plan-mode
approval, `/model` selection all work without any cooperation from the
slave.

The implementation is a **hybrid Python + Node** split because neither
language wins both halves of the problem decisively. Python is the
master-facing MCP surface (FastMCP); Node owns the OS/terminal layer
(`node-pty` + `@xterm/headless`). They communicate over length-prefixed JSON
on stdio of a single long-running Node worker.

## 2. The hybrid split

| Concern                               | Side   | Why                                                                                        |
|---------------------------------------|--------|--------------------------------------------------------------------------------------------|
| MCP tool definitions                  | Python | FastMCP decorators are the cleanest tool-definition ergonomics                             |
| HOME isolation, perm-mode → argv      | Python | Plumbing-y; close to where master sees the tools                                           |
| Lifecycle cascade & signal handling   | Python | Parent process owns SIGTERM/SIGINT/atexit                                                  |
| Idle / prompt-visible heuristics      | Python | Stateless transforms over snapshot dicts; easy to test                                      |
| PTY spawn                             | Node   | `node-pty` is the gold-standard implementation, used by VS Code                             |
| Terminal emulation                    | Node   | `@xterm/headless` handles Ink/React-rendered TUIs (Claude Code itself uses xterm dialects) |
| Key-name vocabulary                   | Node   | One source of truth; resolved at the byte boundary                                          |
| Transcript logging                    | Node   | Avoid doubling IPC during generation bursts; log at the source                              |
| Snapshot ordering guarantee           | Node   | Drain `pty.onData` synchronously before serializing                                         |
| OSC 133 marker detection              | Node   | xterm's marker API is wired into the Terminal instance                                      |

`pyte` would lose fidelity on Claude Code's frequent full-frame redraws,
OSC 133 prompt marks, true-color SGR, alt-buffer toggles, sync-update
DECSET 2026, and bracketed paste. Node's xterm stack is the same code that
renders Claude Code in VS Code's embedded terminal — it's already proven
against this exact workload.

## 3. Wire protocol

A single Node worker handles all sessions. The Python parent and Node child
talk length-prefixed JSON over stdio.

### Framing

```
┌──────────────┬───────────────────────────┐
│ u32 LE length│ UTF-8 JSON payload        │
└──────────────┴───────────────────────────┘
```

Newline framing is unsafe — raw PTY bytes contain `\n`. Each frame is a
4-byte little-endian length followed by exactly that many UTF-8 bytes of
JSON. See `pty-bridge/src/protocol.ts` for the encoder/decoder.

Three frame shapes share the wire:

- **Op** (parent → child): `{id, op, args}`
- **Reply** (child → parent): `{id, ok: true, result?}` or `{id, ok: false, error}`
- **Event** (child → parent): `{event, id, ...}` — unsolicited, no `id` matching a request

### Operations

| op              | args                                                              | result                                              |
|-----------------|-------------------------------------------------------------------|-----------------------------------------------------|
| `open`          | `{id, cmd, cmdArgs, cwd, env, cols, rows, transcriptDir}`         | `{ok: true}`                                        |
| `write`         | `{id, items[], bracketedPaste?}`                                  | `{ok: true, result: {unresolved?: string[]}}`       |
| `resize`        | `{id, cols, rows}`                                                | `{ok: true}`                                        |
| `snapshot`      | `{id, mode: "visible"\|"serialized", includeCursor?}`             | `SnapshotResult`                                    |
| `signal`        | `{id, kind: "ctrl-c"\|"sigint"\|"sigterm"\|"sigkill"\|"ladder"}`  | `{ok: true}`                                        |
| `close`         | `{id}`                                                            | `{ok: true}`                                        |
| `list_sessions` | `{}`                                                              | `{ok: true, result: [{id, exited, ...}]}`           |
| `ping`          | `{}`                                                              | `{ok: true, result: {pid, uptimeMs}}`               |

`SnapshotResult` shape:

```ts
{
  text: string,
  cursor: { row: number, col: number },
  alt: boolean,
  cols: number, rows: number,
  hash: string,
  idleSinceMs: number,
  lastPromptAtMs: number | null,
  serialized?: string  // present when mode == "serialized"
}
```

### Events

| event            | payload                                       | meaning                                                |
|------------------|-----------------------------------------------|--------------------------------------------------------|
| `data`           | `{id, len, cumHash, ts}`                      | PTY produced bytes — no payload, only hash + length    |
| `prompt_visible` | `{id, ts}`                                    | OSC 133 marker fired (input prompt visible)            |
| `exit`           | `{id, code, signal, ts}`                      | PTY child exited                                       |

`data` events deliberately omit the bytes. Bytes go straight to
`transcript.bin` and `transcript.jsonl` on disk; the parent reads them lazily
via `read_log`. This avoids doubling IPC traffic during long generations.

## 4. Slave isolation

Each slave gets its own `$HOME` at:

```
~/.cache/claude-puppet/sessions/<id>/home/
```

Inside that HOME, `server/sessions.py::_materialize_home` arranges:

| path                                | kind        | purpose                                                                |
|-------------------------------------|-------------|------------------------------------------------------------------------|
| `.claude/.credentials.json`         | copy + sync | OAuth token snapshot of master's real `~/.claude/.credentials.json`; re-synced on every `send_keys` / `send_text` (atomic rename) so master's refresh-token rotations propagate |
| `.claude/settings.json`             | symlink     | Read-mostly settings from master                                       |
| `.claude/projects/`                 | real dir    | Per-slave project state (no cross-slave race)                          |
| `.claude/sessions/`                 | real dir    | Per-slave session log                                                  |
| `.claude/shell-snapshots/`          | real dir    | Per-slave shell snapshots                                              |
| `.claude/paste-cache/`              | real dir    | Per-slave paste cache                                                  |
| `.claude/telemetry/`                | real dir    | Per-slave telemetry                                                    |
| `.claude/backups/`                  | real dir    | Per-slave backups                                                      |
| `.claude/mcp-config.json`           | real file   | Empty `{"mcpServers": {}}` by default                                  |
| `.claude.json` (at HOME root)       | real file   | Per-user state — initialized as `{}` to avoid cross-slave race on 28KB hot file |

The slave gets a private *copy* of `.credentials.json` rather than a symlink
because (a) sibling slaves and master can each rotate refresh tokens
independently — sharing one inode would cause cross-slave clobbering — and
(b) `claude` writes a refreshed token via temp-file + rename, which would
break a shared symlink for sibling slaves. The copy is re-synced from master
just before any `send_keys` / `send_text` op so master's rotations propagate
before the slave needs to refresh; without that re-sync a long-lived idle
slave 401s when its private copy holds an old (now invalidated) refresh
token. See `server/sessions.py::sync_credentials_from_master`.

If the master sets `ANTHROPIC_API_KEY` in the slave's env, the slave uses the
API-key path and the credentials file is irrelevant.

### Env scrub

Built in `server/sessions.py::_build_env`:

- **Stripped by prefix**: `CLAUDECODE`, `CLAUDE_CODE_`, `CLAUDE_AGENT_`
- **Stripped by exact match**: `NO_COLOR`, `CI`
- **Force-set**: `TERM=xterm-256color`, `COLORTERM=truecolor`,
  `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `FORCE_COLOR=3`, `HOME=<isolated>`

Stripping the `CLAUDECODE*` family stops a recursive slave from gating
behavior on "I'm inside Claude Code". The terminal vars force consistent
encoding/color regardless of the master's environment.

### `--strict-mcp-config` by default

The slave's argv always includes:

```
--strict-mcp-config --mcp-config <sess>/.claude/mcp-config.json
```

The MCP config defaults to `{"mcpServers": {}}` — empty. This prevents the
slave from recursively loading claude-puppet itself (which would let it
spawn its own slaves, etc.). Per-session opt-in MCP servers are passed via
the `mcp_servers=` kwarg to `open_session`.

## 5. Permission modes

Argv-time, set per session at `open_session(permission_mode=...)`. Mapped in
`server/sessions.py::_build_argv`:

| mode          | argv added                                | semantics                                              |
|---------------|-------------------------------------------|--------------------------------------------------------|
| `strict`      | (none — default)                          | Slave shows permission prompts; master answers via screen |
| `acceptEdits` | `--permission-mode acceptEdits`           | Auto-accept file edits, prompt for shell/network       |
| `plan`        | `--permission-mode plan`                  | Read-only plan mode                                    |
| `yolo`        | `--dangerously-skip-permissions`          | Skip all permission prompts                            |

`set_permission_mode(id, mode)` exists as a runtime tool but it drives the
slave's `/permissions` slash command via keystrokes — it is TUI-fragile and
documented as best-effort. Argv-time setting at `open_session` is the
primary path.

## 6. Idle detection

The naive heuristic — "PTY has been silent for N ms" — does not work for
Claude Code, because Ink's spinner repaints continuously during generation.
There is rarely a quiet period between bytes.

The heuristic that does work, implemented in `server/screen.py::is_idle`:

1. Hash each snapshot's rendered text + cursor position.
2. Push hashes into a ring buffer of the last K snapshots.
3. The session is idle iff:
   - All K hashes are the same, AND
   - The span between the oldest and newest hash exceeds `stable_ms`, AND
   - The cursor is in the bottom 4 rows (input region), OR a `prompt_visible`
     OSC 133 event fired in the last `2 × stable_ms`.

The OSC 133 wiring in `pty-bridge/src/snapshot.ts` is rock-solid when the
slave emits the markers; the cursor-position fallback covers builds that
don't.

### Token economy / dedup

The master Claude's context grows with every tool result it receives. The
slave's rendered buffer is ~200×50 characters; sending it on every
`read_screen` poll would balloon the master's context and burn tokens
without delivering new information.

The MCP server therefore tracks, per session, the last screen text already
delivered to the master (`_master_last_hash` / `_master_last_text` in
`server/mcp_server.py`). `read_screen` returns one of three shapes:

- **full**  — `{hash, text, full: true, ...metrics}`. First read of a
  session, `force_full=True`, or a `since_hash` that doesn't match any
  tracked state.
- **delta** — `{hash, changed_lines: [{row, text}, ...], ...metrics}`. Only
  rows whose contents differ from the master's last view are sent.
- **unchanged** — `{hash, unchanged: true, ...metrics}`. Hash matches the
  last view; the master already has the content.

`wait_for_idle` and `wait_for` deliberately omit the full text — they
return hash + cursor + metrics (and a short match-context window for
`wait_for`). Call `read_screen` afterward only when you need the content;
that call returns a delta against your last view, not the full buffer.

## 7. Ordering & races

### Snapshot ordering guarantee

In `pty-bridge/src/session.ts`, every `pty.onData(data)` callback is
**synchronous**: it calls `term.write(data)` immediately, then writes to the
transcript and emits the `data` event. Because Node's event loop processes
ops sequentially, by the time a `snapshot` op runs, all bytes that arrived
before it have already been fed to the Terminal. The snapshot can never
return stale state for bytes the parent has already been notified about.

### SIGINT ladder

`session.ts::signalLadder`:

```
write \x03 to PTY
  ↓ wait 500ms
pty.kill("SIGINT")
  ↓ wait 2000ms
pty.kill("SIGTERM")
  ↓ wait 5000ms
pty.kill("SIGKILL")
```

`\x03` is what `Ctrl-C` actually sends — the slave's signal handler runs
inside `claude` and may unwind cleanly (saving session state, etc.). Only if
that fails do we escalate.

### Shutdown cascade

`server/lifecycle.py` registers SIGTERM/SIGINT/`atexit` handlers on the
Python parent. On any of those:

1. Iterate the session registry; close each with timeout (the SIGINT ladder
   above runs per session).
2. SIGTERM the Node bridge subprocess.
3. SIGKILL fallback after timeout.

The Node bridge in turn iterates its own session map on shutdown. The two
levels are belt-and-suspenders; if one fails, the other catches.

## 8. Failure isolation (v1)

A single Node bridge subprocess manages **all** sessions in a
`Map<sessionId, Session>`. This is a deliberate v1 choice:

- **Cost**: one Node crash takes down all slaves.
- **Remedy**: the bridge is small (~350 LOC TS); the failure surface is
  bounded. v2 may move to one Node worker per slave if real-world crashes
  warrant the IPC fan-out cost.

Per-session crashes within Node (a thrown exception in one session's
handlers) are caught and surfaced as an `exit` event for that session
without affecting siblings.

## 9. Anti-recursion

There is no formal anti-recursion guard today — Anthropic could add one,
but the project is informally supported. Two mitigations cover the most
likely footguns:

- **Empty `--strict-mcp-config` by default**: the slave can't load
  claude-puppet recursively unless the master explicitly opts in via
  `mcp_servers=`.
- **Env scrubs** of `CLAUDECODE*`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_*`: the
  slave can't gate on "running inside Claude Code" by reading env, because
  those vars are stripped before exec.

These don't *prevent* a determined operator from setting up recursion; they
prevent it from happening accidentally.

## 10. Observability

Per-session, under `~/.cache/claude-puppet/sessions/<id>/transcripts/`:

- `transcript.bin` — raw PTY bytes, append-only. Replay the slave's screen
  byte-for-byte.
- `transcript.jsonl` — `{ts, dir: "in"|"out", len, text}` lines covering
  both directions (master → slave keystrokes and slave → master output).

The Python `read_log` tool surfaces the JSONL tail to the master.

A separate Vite + Express app under `dashboard/` (built concurrently by a
sister agent) tails these files and renders a live PTY view of every active
slave plus the master's tool-call timeline. Run it with
`npm run dev` from `dashboard/`; default port 5173.

---

## Cross-references

- Source plan: `/home/ahmed/.claude/plans/do-what-is-better-spicy-eclipse.md`
- Top-level overview: `../README.md`
- Examples walkthrough: `../examples/README.md`
- Concrete recipe: `../examples/demo-fizzbuzz.md`
