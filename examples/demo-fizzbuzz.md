# Demo: master makes a slave write and run fizzbuzz

A copy-pasteable end-to-end recipe. You are a master Claude Code session with
claude-puppet registered as an MCP server (see `./README.md` if not). Each
step below is one tool call from the master.

## Recipe

```
1. open_session(id="fb", cwd="/tmp/fb-demo", permission_mode="acceptEdits")
2. send_keys(id="fb", keys=["write a Python script fizzbuzz.py that prints fizzbuzz 1..30, then run it", "<Enter>"])
3. wait_for_idle(id="fb", stable_ms=800, timeout_ms=60000)
4. read_screen(id="fb")        # verify "Fizz" / "Buzz" appear
5. read_log(id="fb")           # transcript snippet
6. close_session(id="fb")
```

## Step-by-step

Make sure `/tmp/fb-demo` exists first; the slave uses it as cwd.

### 1. `open_session`

```
open_session(id="fb", cwd="/tmp/fb-demo", permission_mode="acceptEdits")
```

Behind the scenes:

- Python `server/sessions.py::build_spec` materializes
  `~/.cache/claude-puppet/sessions/fb/home/` as the slave's `$HOME`. It
  creates a real `.claude/` subtree (projects/, sessions/, history.jsonl,
  shell-snapshots/, paste-cache/, telemetry/, backups/) and symlinks
  `.credentials.json` and `settings.json` from your real `~/.claude/`.
- Argv is built: `["--permission-mode", "acceptEdits", "--strict-mcp-config",
  "--mcp-config", "<sess>/.claude/mcp-config.json"]`. The MCP config is
  empty by default (`{"mcpServers": {}}`) so the slave doesn't recursively
  load claude-puppet itself.
- Env is the master's env minus `CLAUDECODE*`, `CLAUDE_CODE_*`,
  `CLAUDE_AGENT_*`, `NO_COLOR`, `CI`, plus
  `TERM=xterm-256color COLORTERM=truecolor LANG=C.UTF-8 LC_ALL=C.UTF-8 FORCE_COLOR=3 HOME=<isolated>`.
- Python sends an `open` op to the Node bridge; Node spawns `claude` via
  `node-pty` at 200×50 (default) attached to a fresh `@xterm/headless`
  Terminal, and starts streaming bytes into `transcript.bin` /
  `transcript.jsonl` under `~/.cache/claude-puppet/sessions/fb/transcripts/`.

Gotcha: if `cwd` doesn't exist, the slave will start in a directory that
doesn't exist and complain. Create it first.

### 2. `send_keys`

```
send_keys(id="fb", keys=["write a Python script fizzbuzz.py that prints fizzbuzz 1..30, then run it", "<Enter>"])
```

Behind the scenes:

- Python forwards a `write` op with `items: [...]` to the bridge.
- Node's `keys.ts::resolveTokens` walks the list. The first item is plain
  text and passes through. `<Enter>` matches the key-name vocab and resolves
  to `\r`.
- Concatenated bytes are written to the PTY via `pty.write(...)`. The slave
  sees them on stdin exactly as if you typed.
- Because this is short text, no bracketed-paste wrap is applied. (Use
  `send_text` for verbatim payloads >32 chars and the bridge will wrap them
  in `\x1b[200~ … \x1b[201~` for a single Ink redraw.)

The slave now begins generating: it'll display its plan, possibly stream
tool calls, and then run the file.

### 3. `wait_for_idle` — the critical step

```
wait_for_idle(id="fb", stable_ms=800, timeout_ms=60000)
```

This is the step that makes the whole pattern reliable. Without it the
master would `read_screen` while the slave is still mid-generation and get a
half-rendered frame.

Behind the scenes:

- Python polls `snapshot` ops in a tight loop, pushing each result's hash
  into a small ring buffer.
- A snapshot is "idle" only when:
  1. the snapshot hash has been the same across the last K ticks spanning
     ≥ `stable_ms`, AND
  2. the cursor is in the input row (or OSC 133 `prompt_visible` fired
     recently — Node attaches xterm marker hooks to detect this).
- `stable_ms=800` is a good default. Don't go below ~500ms: Claude's
  spinner repaints continuously, so a byte-silence-only heuristic would
  *never* fire. The hash check + cursor-position check is what actually
  works.

If the slave is still running shell commands when the timeout fires, raise
`timeout_ms` or use `wait_for(pattern="some output you expect")` instead.

### 4. `read_screen`

```
read_screen(id="fb")
```

Returns:

```json
{
  "text": "...rendered visible buffer...",
  "cursor": {"row": 47, "col": 2},
  "alt": false,
  "cols": 200, "rows": 50,
  "hash": "ab12...",
  "idle_since_ms": 1200,
  "last_prompt_at_ms": 1746789012345,
  "looks_like_prompt": true
}
```

Behind the scenes:

- Python sends a `snapshot` op.
- Node *first drains any pending PTY data* into the Terminal, *then*
  serializes — this is the snapshot ordering guarantee. The result reflects
  every byte received before the request, never a stale state.
- For `mode="visible"` (default), text comes from
  `term.buffer.active.translateToString(true)`. For `mode="serialized"`,
  Node uses `@xterm/addon-serialize` for full-state SGR/cursor capture.

Verify the slave actually produced output: scan `text` for `Fizz` and
`Buzz`. If the slave ran the file, you'll also see the output of `python3
fizzbuzz.py` interleaved.

### Token economy

`wait_for_idle` returns metadata only — `{idle, hash, cursor, idle_since_ms,
last_prompt_at_ms, ...}` with no `text` field. Call `read_screen` next when
you need the actual content. Likewise, `wait_for` returns the matched
substring plus a small (~80 char) context window, not the full buffer.

`read_screen` itself returns a delta after the first call: only rows that
changed since the master's previous read are sent, as
`changed_lines: [{row, text}, ...]`. If nothing changed, the response is
`{hash, unchanged: true, ...}`. Pass `force_full=True` to fetch a complete
snapshot (useful after a long gap or for a fresh full view).

This keeps the master Claude's context window from accumulating the slave's
full transcript on every poll.

### 5. `read_log`

```
read_log(id="fb")
```

Returns the tail of the per-session JSONL transcript:
`~/.cache/claude-puppet/sessions/fb/transcripts/transcript.jsonl`. Each line
is `{ts, dir: "in"|"out", len, text}`. Useful for replaying what the slave
saw and what it emitted, including ANSI escape sequences. The bridge logs
*at the source* (Node side) to avoid doubling IPC traffic during long
generations.

### 6. `close_session`

```
close_session(id="fb")
```

Behind the scenes — the SIGINT ladder runs in
`pty-bridge/src/session.ts::signalLadder`:

1. Write `\x03` to the PTY (ctrl-c at the slave's prompt).
2. Wait 500ms; if the process hasn't exited, `pty.kill('SIGINT')`.
3. Wait 2s; if still alive, `pty.kill('SIGTERM')`.
4. Wait 5s; if still alive, `pty.kill('SIGKILL')`.

The transcript files are flushed and closed. The session entry is removed
from both Python's registry and Node's `Map<id, Session>`.

To verify no orphan: `pgrep -fa claude` should show your master only, no
slave.

---

Each step works because the slave cannot tell it's not a human — it sees
PTY bytes on stdin and renders to stdout. From its perspective, you typed
the prompt and pressed Enter.
