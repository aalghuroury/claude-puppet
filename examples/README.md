# claude-puppet examples

Walkthrough for a master Claude Code session driving slave `claude` subprocesses
through the claude-puppet MCP server.

## 1. Install

From the project root:

```sh
cd /home/ahmed/projects/claude-puppet
uv sync
(cd pty-bridge && npm install && npm run build)
```

`uv sync` resolves the Python deps (FastMCP, anyio, structlog). The Node build
compiles `pty-bridge/src/*.ts` to `pty-bridge/dist/`; the Python parent spawns
that compiled output as a subprocess.

## 2. Register the MCP server

The master is just `claude` running in a directory whose `.claude/settings.json`
declares claude-puppet as an MCP server. The minimal entry lives in
`master-mcp-config.json` (next to this README). Two options for how the master
picks it up:

- **Per-project**: paste it into `<project>/.claude/settings.json` and run
  `claude` from that directory.
- **Global**: paste it into `~/.claude/settings.json` so any master session
  has the tool available.

The key `mcpServers.claude-puppet` is the master's tool prefix —
`open_session`, `send_keys`, etc. all live under it.

## 3. Open a master session

From a directory whose settings include the snippet above:

```sh
claude
```

Verify the master can see the tools — ask the master to `list_sessions()` and
confirm it returns an empty list rather than "tool not found". If the tool is
missing, see Troubleshooting below.

## 4. Three quick recipes

In each recipe the master is the agent calling tools; the slave is an
unmodified `claude` running in a PTY under an isolated `$HOME`.

### Recipe A: spawn a slave that writes a Python file

```
open_session(id="writer", cwd="/tmp/writer-demo", permission_mode="acceptEdits")
send_keys(id="writer", keys=["write a Python script greet.py that prints hello", "<Enter>"])
wait_for_idle(id="writer", stable_ms=800, timeout_ms=60000)
read_screen(id="writer")
close_session(id="writer")
```

`acceptEdits` lets the slave write the file without modal approval. The master
simply types the request and waits for the buffer to settle.

See `demo-fizzbuzz.md` for a fully annotated version of this recipe.

### Recipe B: spawn a slave in plan mode and review what it proposes

```
open_session(id="planner", cwd="/tmp/planner-demo", permission_mode="plan")
send_keys(id="planner", keys=["sketch a refactor of utils.py to remove the global cache", "<Enter>"])
wait_for_idle(id="planner", stable_ms=800)
read_screen(id="planner")  # → master inspects the plan text
# decide: approve, reject, or refine
send_keys(id="planner", keys=["instead, keep the cache but make it thread-local", "<Enter>"])
wait_for_idle(id="planner")
read_screen(id="planner")
close_session(id="planner")
```

`plan` mode keeps the slave read-only — it produces a plan and waits for
approval. The master can iterate on the plan as text without ever letting the
slave touch the filesystem.

### Recipe C: two slaves, one verifies the other

```
open_session(id="impl",   cwd="/tmp/two-slaves", permission_mode="acceptEdits")
open_session(id="review", cwd="/tmp/two-slaves", permission_mode="strict")

send_keys(id="impl", keys=["write fib.py with a memoized fibonacci(n)", "<Enter>"])
wait_for_idle(id="impl", stable_ms=800)

send_keys(id="review", keys=["read /tmp/two-slaves/fib.py and tell me one bug or one improvement", "<Enter>"])
wait_for_idle(id="review", stable_ms=800)
read_screen(id="review")

close_session(id="impl")
close_session(id="review")
```

Both slaves share `/tmp/two-slaves` as their cwd but have separate isolated
HOMEs (each has its own `~/.claude/projects/`, history, etc.). The `review`
slave is in `strict` mode, so if it tries to edit the file the master will
see a permission modal in the rendered screen and can answer it with
`send_keys`.

## 5. Watch what's happening

A sibling Vite app under `dashboard/` (built concurrently) tails each slave's
`transcript.bin` / `transcript.jsonl` plus the master's tool-call timeline.
Run it from a second terminal:

```sh
cd /home/ahmed/projects/claude-puppet/dashboard
npm install
npm run dev
```

Then open <http://localhost:5173>. You get a live PTY view of every active
slave plus the master's tool-call timeline. Useful for debugging "why is the
slave stuck on a permission prompt?" without having to call `read_screen`
in the master.

## 6. Permission modes

Set per-session at `open_session(permission_mode=...)`. From the docstrings
in `server/sessions.py`:

| mode          | argv                                  | behavior                                               |
|---------------|---------------------------------------|--------------------------------------------------------|
| `strict`      | (no flag — default)                   | slave shows permission prompts; master answers via screen |
| `acceptEdits` | `--permission-mode acceptEdits`       | auto-accept file edits; prompt for shell/network       |
| `plan`        | `--permission-mode plan`              | read-only plan mode                                    |
| `yolo`        | `--dangerously-skip-permissions`      | bypass all permission prompts                          |

`set_permission_mode` exists as a runtime tool but it drives `/permissions`
keystrokes inside the slave's TUI — it's best-effort and can break across
Claude Code releases. Prefer setting the mode at `open_session` time.

### Slave authentication

Each slave has its own `$HOME` at `~/.cache/claude-puppet/sessions/<id>/home/`.
The slave's `.claude/.credentials.json` and `.claude/settings.json` are
**symlinked** from your real `~/.claude/` so the slave inherits your OAuth
token without sharing the rest of the mutable `.claude/` state (projects,
sessions, history, etc., are all per-slave). If you have
`ANTHROPIC_API_KEY` set in the slave's env (passed through `open_session`'s
`env=` kwarg), the slave uses that instead and the symlinks are irrelevant.

## 7. Troubleshooting

### `claude not found`

`server/sessions.py` looks up the slave binary via `shutil.which("claude")`.
If your master inherits a different PATH than your shell, point at it
explicitly:

```sh
export CLAUDE_PUPPET_CLAUDE=/home/ahmed/.npm-global/bin/claude
```

(Set it in the master's environment, e.g. in the `env` map of the snippet
above.)

### `pty-bridge entry not found`

The Python parent expects `pty-bridge/dist/index.js` to exist. If it's
missing:

```sh
(cd /home/ahmed/projects/claude-puppet/pty-bridge && npm install && npm run build)
```

If `npm install` falls back to a source build of `node-pty`, you need
`node-gyp` plus a working C++ toolchain — easiest path is to switch to
Node 22 LTS (a `.nvmrc` is checked in for that reason).

### OAuth issues in the slave

If the slave reports it can't authenticate:

1. Confirm `~/.claude/.credentials.json` exists for the master user.
2. Confirm the symlink was made:
   `ls -l ~/.cache/claude-puppet/sessions/<id>/home/.claude/.credentials.json`
   should point at the master's real file.
3. If you set `ANTHROPIC_API_KEY` in the slave env, the slave skips the
   OAuth path entirely — make sure the key is valid.

### Slave stuck mid-generation

`wait_for_idle` requires the snapshot hash to be stable AND the cursor to be
at the input row. Claude's spinner repaints continuously, so a 200-300ms
`stable_ms` is too short — start with 800ms. If it still trips, raise
`timeout_ms` or fall back to `wait_for(pattern=...)` with a regex you know
the slave will print.

## Further reading

- Top-level overview: `../README.md`
- Architecture deep-dive: `../docs/architecture.md`
- Full design plan: `/home/ahmed/.claude/plans/do-what-is-better-spicy-eclipse.md`
- Concrete end-to-end recipe: `./demo-fizzbuzz.md`
