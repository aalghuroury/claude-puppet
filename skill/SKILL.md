---
name: claude-puppet
description: Use when the user wants to drive one or more slave `claude` CLI sessions through claude-puppet — spawn parallel worker Claudes, observe what they're doing, send keystrokes/text, read their screens. Triggers: "use the puppet", "spawn a slave", "open a parallel claude", "run a worker claude", "watch the dashboard", "the puppet system at <your-clone>/".
metadata:
  short-description: Drive slave claude sessions via the claude-puppet MCP server
---

# claude-puppet

The puppet is an MCP server that lets you (master) drive `claude` CLI subprocesses (slaves) through PTYs. The slaves are unmodified — they cannot tell they're being driven.

Project: `<your-clone>/`. Always-on services (already enabled):
- **Dashboard** http://localhost:5055 (live PTY view of every slave + tool-call timeline)
- **MCP HTTP** http://localhost:5056/mcp (streamable-HTTP transport)

Master-config snippet for HTTP attach: `examples/master-mcp-config-http.json`. Slaves persist across master-session restarts because the daemon is the bridge owner.

## Treat the slave like the user treats you

The user gives you a one-line task and lets you plan. Do the same to the slave:

- Send a short, high-level task. Do NOT pre-decide the stack, pre-create folders, or hand-feed structure.
- Tell the slave to use plan mode (`/plan`) so you can review.
- Read the screen (deltas) to follow along, approve plans, answer prompts.
- Intervene only when the slave is stuck, blocked, or asking a question.

## Pass context, don't make slaves re-explore

If you have many tasks to fan out — or a slave needs sub-slaves of its own — hand over what you already know BEFORE the new spawn starts working. Otherwise it re-discovers files, conventions, and decisions you already made: wasted tokens and possibly different conclusions on questions you already settled.

Two working mechanisms:

**A. Inline brief in the first message.** Open the new slave, then pass project paths, conventions, what's been tried/ruled out, and ONLY THEN the task itself. Order matters — context first, task last.

```python
await open_session(id="worker", cwd="/repo", owner="me", permission_mode="acceptEdits")
# … dismiss trust prompt …
await send_text(id="worker", text="""
Project: claude-puppet at <your-clone>.
Stack: Python (server/), Node TS (pty-bridge/), TS (dashboard/).
Tests: pytest under tests/, run with `uv run pytest`.
Already established: throttle+coalesce in server/mcp_server.py at L208 and L1198.
Task: add a /api/status endpoint returning connected-bridge count. Plan first.
""")
await send_keys(id="worker", keys=["<Enter>"])
```

**B. Shared brief file.** Write a `BRIEF.md` (or `.context/PROJECT.md`, whatever) into the slave's `cwd` before spawning. First instruction to the slave: "read BRIEF.md, then plan." Better when the brief is long, or when multiple sub-slaves will share the same context.

**Auto-memory does NOT cascade.** Per "Slave's HOME isolation" below, each slave gets a fresh `$HOME`. Memory the master writes is in the master's HOME — slaves don't see it. Memory a slave writes is in its own HOME — sub-slaves don't see it. So "save it to memory before spawning" is *not* a working handoff mechanism here; use inline brief or a file in the shared `cwd`.

**When to skip the handoff:** if the new spawn's actual job is discovery (e.g. "audit this unknown repo"), don't pre-constrain it. The handoff is for tasks you've already scoped, where the spawn is executing, not exploring.

**Ask the slave to be terse.** Add to the brief: *"Respond terse — bullet points and outcomes, no summary paragraph at the end. If I ask for detail, I'll ask."* A slave that closes a long task with a multi-paragraph recap costs the master 2-4k tokens per slave. Avoidable with one extra sentence at brief-time.

## Driving slaves event-driven (preferred)

`drain_events` is the canonical receive idiom when you have more than one slave in flight. It's a multiplexed long-poll: one tool call, N slaves, you get whichever speaks first.

The server pushes three event types into a per-OWNER queue:

| Type | When | Payload |
|---|---|---|
| `new_lines` | Committed `chat`/`menu`/`prompt` rows strictly ABOVE the slave's current cursor row. Throttled to at most one flush per ~1000 ms while data is flowing (so the master keeps seeing progress during long streams). Adjacent same-sid new_lines envelopes are coalesced by `drain_events` into one envelope per sid on return. | `{sid, lines: [{row, text, class}], seq, ts}` |
| `prompt_visible` | Slave is awaiting input (low-latency, NOT throttled) | `{sid, seq, ts}` |
| `exited` | Slave's PTY exited; subsequent ops on `sid` will raise | `{sid, code, signal, seq, ts}` |

Emitted-text is tracked per session — the master never re-receives lines it has already seen on this channel.

```python
# Fan out
await open_session(id="A", cwd="/repo-a", owner="me", permission_mode="acceptEdits")
await open_session(id="B", cwd="/repo-b", owner="me", permission_mode="acceptEdits")
await send_text(id="A", text="/plan refactor module foo")
await send_keys(id="A", keys=["<Enter>"])
await send_text(id="B", text="/plan refactor module bar")
await send_keys(id="B", keys=["<Enter>"])

# Drain — one call, returns events from whichever slave emits first
events = await drain_events(owner="me", timeout_ms=5000, max_events=64)
# events: [{type, sid, ...}, ...] — interleaved across A and B
```

Why this matters: the master fans out to N slaves and waits on ONE queue. No slave blocks the others. With single-slave `wait_for_idle` / `wait_and_read`, the master serializes work behind whichever slave it picked to poll.

Filter knobs: `sids=["A","B"]` to scope to specific sessions; `types=["new_lines","exited"]` to skip `prompt_visible` when you only care about output. `timeout_ms=0` returns immediately with whatever is queued (useful as a non-blocking peek).

When to fall back to the single-slave idioms:

- `wait_for_idle` — one-shot metadata, you'll `read_screen` next.
- `wait_and_read` — single-shot full-buffer read, fine when driving exactly one slave.
- `wait_for(pattern)` — you specifically need to block on ONE substring on ONE session.

Each of those blocks on a single slave; `drain_events` does not.

## Tool surface (18)

| Tool | Use |
|---|---|
| `open_session` | Spawn a slave. Args: `id`, `cwd`, `permission_mode` (`strict`/`acceptEdits`/`plan`/`yolo`), `cols=200`, `rows=50`, `owner="anonymous"`, `parent_id=None`, `nested_puppetry=False`, `max_depth=3`. |
| `send_keys` | Key-name list: `["<Enter>"]`, `["<C-c>"]`, `["1", "<Enter>"]`, `["<Up>", "<Up>"]` |
| `send_text` | Verbatim text; auto bracketed-paste wrap when >32 chars |
| `read_screen` | **Returns full text only on first read or `force_full=True`. After that: `changed_lines: [{row,text,class}]` for deltas, or `{unchanged: true}` when nothing changed.** Class-aware: `include_classes=[…]` filters rows; `dedup="content"` (default) ignores spinner-only repaints. (also `commit_window_ms=400` for terminal-style append-only semantics; pass 0 for legacy live view) |
| `wait_for_idle` | Server-side polling. Returns metadata only — NO `text` field. Call `read_screen` after for content. |
| `wait_and_read` | **One call = `wait_for_idle` + `read_screen`.** Same dedup/class filtering as `read_screen`. Single-slave only — blocks on the one `sid` you pass. |
| `drain_events` | **Multiplexed long-poll over a per-OWNER queue.** Args: `owner`, `timeout_ms=0`, `max_events=64`, optional `sids`, `types`. Returns a list of `new_lines` / `prompt_visible` / `exited` events from whichever slave emits first. Preferred for N>1 slaves. |
| `wait_for(pattern)` | Returns the matched substring + ~80-char context window — NO full buffer. |
| `interrupt(force=False)` | `\x03` by default; `force=True` runs SIGINT/TERM/KILL ladder |
| `resize_session` | Cols/rows |
| `set_permission_mode` | Best-effort `/permissions <mode>`; argv-time at `open_session` is preferred |
| `set_nested_puppetry` | Grant or revoke a slave's sub-spawn capability at runtime. Instant, no slave restart. Flag is server-side; the puppet MCP tools are loaded in every slave regardless. |
| `list_sessions(owner=?, status=?)` | DB rows merged with bridge state; filter by owner/status (`alive`/`closed`/`crashed`); rows include `parent_id`/`depth`/`nested_puppetry` |
| `list_descendants(id)` | BFS subtree rooted at `id`; each row includes `alive_in_bridge` |
| `session_tree(root_id=?)` | Whole-DB nested tree (or single subtree); each node has `children: [...]` |
| `resume_session(id, owner=?)` | Reconnect to a DB-known session; re-registers in-memory if still alive in bridge |
| `read_log(since_offset)` | Replays per-session transcript.jsonl |
| `close_session` | Graceful shutdown ladder |

## Token economy — the read pattern

The master's context grows with every tool result. Don't burn it on the same screen twice.

Multi-slave (preferred): drive with `drain_events`, which only ever emits committed lines above the cursor and tracks per-session what you've already seen.

```
send_text(...) → send_keys(["<Enter>"])    # to each slave
drain_events(owner=..., timeout_ms=5000)   # one call, all slaves
```

Single-slave one-shot:

```
send_text(...) → send_keys(["<Enter>"])
wait_and_read(stable_ms=4000)         # block-then-read in ONE tool call
# or split: wait_for_idle + read_screen, if you need them separately
# only force_full=True when you genuinely need a fresh full snapshot
```

Avoid client-side polling. `drain_events`, `wait_for_idle`, and `wait_and_read` all do the polling on the server and return once.

### Token waste patterns observed in long supervision sessions

After a multi-hour supervision session, these patterns burn 20-30% of the master's coordinator-side context. Avoidance is mostly behavioral, plus two shell helpers (see "Master-callable shell helpers" below).

**1. Buffered event replay after reconnect.** When the master reconnects (auth break, daemon hiccup, attention gap), `drain_events` returns 500-1000 events of historical replay. Each lands verbatim in the master's transcript. Cost: 8-15k tokens.

- **Fix:** `bash ~/.claude/hooks/puppet-flush.sh me` discards the backlog server-side and returns one line of summary to the master. ~50 tokens vs ~10k tokens.
- The flush helper still surfaces a `<puppet-alert>` block if any flushed events match auth/error patterns — so you don't silently drop important signals.

**2. Repeated full-screen reads.** `read_screen` with `force_full=True` returns the entire viewport every time, including scrolled-up content the master already saw and any long queued input-box text. 5+ reads per slave × 3 slaves × 1500-1800 chars of scrolled history = 15-25k tokens.

- **Fix:** never pass `force_full=True` unless you genuinely need a fresh full snapshot (e.g. recovering from a stuck state). Default `force_full=False` returns deltas — typically tens of tokens.
- **Fix:** pass `include_classes=["chat"]` to skip prompt/chrome/status rows. Skips long queued input box text.
- **Pattern:** for tracking new content, use `drain_events` or `puppet-peek.sh`, not `read_screen`. `read_screen` is for ground-truth verification (one-shot), not routine polling.

**3. Old-run failure echoes scrolled into new-run state.** Failed-run output (Retrying / 401) stays in the slave's PTY scrollback and resurfaces in every `read_screen`. Cost: 3-5k tokens per session.

- **Fix:** the delta mode of `read_screen` (default) only returns rows that changed since the master's last read. Old echoes don't re-appear in deltas. This problem ONLY happens with `force_full=True`. Same fix as (2).

**4. Verbose slave summary paragraphs.** Slaves close out with multi-paragraph "here's everything I did" recaps. 2-4k tokens per slave you didn't actually need.

- **Fix:** in the slave's initial brief (see "Pass context, don't make slaves re-explore"), add: *"Respond terse — bullet points and outcomes, no summary paragraph at the end. If I ask for detail, I'll ask."*

### Lightweight supervision recipe

For routine "is everything okay" check-ins across N slaves:

```sh
bash ~/.claude/hooks/puppet-peek.sh me     # tail-5 lines per slave + signals + alerts
```

This drains the queue, drops stale events, surfaces auth/error alerts, and shows only the LAST 5 lines per slave plus prompt_visible/exited summaries. ~200-800 tokens vs ~2-10k for the equivalent `drain_events` raw payload.

For ground-truth verification of a specific slave, fall back to `read_screen` (delta mode) or `read_log`.

## Master-callable shell helpers

These are NOT MCP tools — they're shell scripts the master invokes via the `Bash` tool. They exist to keep verbose event content OUT of the master's transcript while still giving the master visibility into what happened.

| Helper | Purpose | Output | Use when |
|---|---|---|---|
| `~/.claude/hooks/puppet-flush.sh [owner]` | Drain the event queue WITHOUT bringing per-event content into the master's context. Still emits an alert block if any events matched known error patterns. | One-line summary (~50 tokens); plus `<puppet-alert>` block when needed. | On reconnect, after an auth break, any time the queue holds replay you don't need word-for-word. |
| `~/.claude/hooks/puppet-peek.sh [owner]` | Drain + show tail-N lines per slave + prompt_visible/exited as one-liners. | `<puppet-peek>` block (~200-800 tokens). | Routine "current state" checks. |
| `~/.claude/hooks/puppet-drain.sh` | UserPromptSubmit hook (NOT master-callable directly). Auto-prepends fresh events to every user prompt. | `<puppet-events>` block on stdout. | Wired in `~/.claude/settings.json` under `hooks.UserPromptSubmit`. |

All three share env knobs:

- `PUPPET_OWNER` — owner queue (default `me`)
- `PUPPET_DRAIN_URL` — endpoint (default `http://localhost:5056/api/drain`)
- `PUPPET_DRAIN_MAX_AGE_S` — drop events older than N seconds (default 60s; `0` disables)
- `PUPPET_ALERT_PATTERNS` — extra regexes (comma-separated) to add to the default auth/error set

Peek-specific:
- `PUPPET_PEEK_TAIL_N` — lines kept per slave (default 5; `0` elides everything but signals)

Flush-specific:
- `PUPPET_FLUSH_BATCH` — per-curl max_events (default 256)
- `PUPPET_FLUSH_MAX_LOOPS` — safety cap (default 32)

## Token economy / classification

Every row coming back from the slave is server-side classified into one of five `RowClass` buckets, and noisy buckets are filtered out before the payload reaches the master:

| Class | What it captures |
|---|---|
| `chat` | Real conversational content — message text, `●` bullets, `⎿` results |
| `menu` | `AskUserQuestion`-style numbered menu options + their nav hints |
| `prompt` | The empty `❯ ` input cursor at the bottom |
| `chrome` | Box-drawing borders, horizontal separators, toolbars |
| `status` | Spinner / "Razzmatazzing…" / timer / token-counter / footer hints |

Defaults: `read_screen` and `wait_and_read` use `include_classes=["chat","menu","prompt"]` — chrome and status are dropped from `changed_lines` and from `rows_classified`. Each returned row carries its `class` label so the master can re-filter client-side too.

Two hashes per snapshot: `render_hash` is the raw xterm-headless hash (every pixel-equivalent change), `content_hash` covers only chat+menu+prompt rows. With `dedup="content"` (default), a screen where ONLY the spinner/timer changed reports `{unchanged: true}` — the master burns no tokens on noise. Pass `dedup="render"` if you actually want to see every render flicker.

`wait_and_read` collapses the common `wait_for_idle` → `read_screen` pair into a single tool call, so the master's transcript carries one tool result instead of two for each polling step.

## Append-only line semantics (default ON)

`read_screen` and `wait_and_read` default to `commit_window_ms=400`. The server takes TWO snapshots ~400 ms apart and only emits rows that are stable across that window. Rows that changed mid-window are "in flight" and held back — the master never sees a partial line.

Mental model: like git. The master sees committed rows, never the working tree.

Each response carries `in_flight_rows: int` and `commit_window_ms_used: int` so the master can see how much was withheld. Opt out with `commit_window_ms=0` (legacy single-shot, faster) when you genuinely want the live mid-stream view (rare).

Combined with the existing class filter and content-hash dedup, the typical pipeline is:

1. Take snap1
2. Wait 400 ms
3. Take snap2
4. Identify committed rows (stable across snap1↔snap2)
5. Classify rows; drop STATUS/CHROME
6. Compute `content_hash` over committed-and-allowed rows
7. Compare against master's last `content_hash`
8. Return `unchanged` / row-indexed delta / full first-time

Concrete example: claude is mid-stream rendering "Hello, w…" → "Hello, wor…" → "Hello, world!" Master polls every 500 ms. The first two reads return `unchanged` (row 12 is in-flight). The third read (after the row settles) returns a delta with row 12 = "Hello, world!" exactly once.

**`drain_events` goes one step deeper.** `new_lines` events ONLY carry rows strictly ABOVE the slave's current cursor row. Anything at-or-below the cursor — the input box, a streaming partial, a status spinner row, the token counter — is excluded BY CONSTRUCTION. The class filter (chat/menu/prompt) is the outer screen; the cursor-row cutoff is the inner guarantee. The master physically cannot receive an in-flight or "still-updating" row from this channel.

## Dashboard audit trail

The dashboard at `http://localhost:5055` can send to ANY session (master, slave, nested, anonymous) — it has POST routes `/api/sessions/:id/{keys,text,interrupt,close,resize}` that proxy through the puppet's MCP HTTP daemon.

When the dashboard sends, it ALSO writes a marked entry to that session's `~/.cache/claude-puppet/sessions/<sid>/tool_calls.jsonl` with:

- `op` prefixed by `dashboard_` (e.g. `dashboard_send_keys`, `dashboard_close`, `dashboard_interrupt`, `dashboard_resize`, `dashboard_send_text`)
- `source: "dashboard"` field
- the standard `args`, `result`, `error`, `duration_ms`, `ts`
- optionally `remote` (request IP) for forensics

Same file the puppet's `_log_call` writes to. Masters reading this file (via the `read_log` tool path or `puppet-debug forensics <sid>`) see dashboard actions interleaved with their own tool calls, distinguished by `source: "dashboard"` and the `op` prefix.

This is the audit channel by which the master KNOWS that the dashboard touched their session. There is no separate notification mechanism — masters who want real-time awareness should poll `read_log` periodically OR run `puppet-debug top` / `puppet-debug forensics`.

Trust model: same-machine honor system. The dashboard runs as the same user; nothing prevents an unprivileged process from forging entries. The audit is for collaboration, not security.

## Nested mastery — slaves as masters

A slave can itself become a master and spawn sub-slaves, but only if you grant it that capability. **The grant is runtime-mutable** — you can hand it out (or take it back) at any time during the slave's life. There is no slave restart and no in-flight state lost.

**Two ways to grant.**

- **Spawn-time:** pass `nested_puppetry=True` to `open_session`. The capability is on from the moment the slave boots.
- **Runtime:** call `set_nested_puppetry(id="<sid>", nested_puppetry=True)` at any later point. The very next `open_session(parent_id=<sid>, ...)` call from that slave succeeds. Calling with `False` revokes — subsequent sub-spawn attempts get a clean `PermissionError`.

**How it's wired.** Every slave's `<HOME>/.claude/mcp-config.json` always includes the puppet HTTP entry, so the puppet tools (`open_session`, `drain_events`, etc.) are loaded into the slave's `claude` at startup regardless of the flag. The flag is purely a **server-side authorization gate**: when a slave calls `open_session(parent_id=<own-sid>)`, the puppet looks up the parent row's `nested_puppetry` and rejects if it's `False`. The slave never has to restart to pick up a flag change — toggling it is instant.

**Permission monotonicity.** A child must be no more permissive than its parent. Rank order: `yolo`(3) > `acceptEdits`(2) > `strict`(1) > `plan`(0). A `plan`-mode slave cannot spawn a child wider than `plan`. Enforced inside `open_session` whenever `parent_id` is set; a violation raises `ValueError`. This is independent of the nested_puppetry flag — it's a separate safety rail.

**Depth cap.** Sessions form a tree (root depth 0, slave depth 1, sub-slave depth 2, …). Default `max_depth=3`. A child's effective `max_depth` is `min(arg, parent.max_depth)` — you can tighten but not loosen.

**Caller identity (honor system).** When a sub-slave spawns its own sub-sub-slave, it passes `parent_id=<its-own-session-id>`. There is no cryptographic check — every Claude in the tree runs on the same user's machine and they're all trusted. If a slave lies about its parent_id the only enforcement is depth/monotonicity + the nested_puppetry gate against the claimed parent's row.

**When to grant.**

- **Don't grant at spawn-time by default.** A slave that gets the capability before producing any concrete output may fork too early, before its plan is solid. Default to `False`.
- **Grant when the scope grows mid-task.** Observe the slave (drain_events, dashboard). When you see "this slave's work is bigger than I scoped — it should fan out," call `set_nested_puppetry(id=<sid>, nested_puppetry=True)`. Then hand the slave a project brief (see "Pass context, don't make slaves re-explore" above) and let it plan the fan-out.
- **Revoke when the slave is winding down.** If the slave is finishing up, revoke to prevent late-stage forking.

```python
# Spawn the slave WITHOUT the capability — let it settle first.
await open_session(id="worker", cwd="/repo", owner="me",
                   permission_mode="acceptEdits", max_depth=2)

# … slave plans, executes, you observe via drain_events …
# … you decide its work is bigger than expected and it should fan out …

# Runtime elevation: instant, no slave restart.
await set_nested_puppetry(id="worker", nested_puppetry=True)

# Now hand it a brief of what's already known, then ask it to spawn sub-slaves
# for the additional sub-tasks. The slave (running its own claude-puppet) can
# now call:
await open_session(id="worker-sub", cwd="/repo/sub", permission_mode="strict",
                   parent_id="worker")   # succeeds because parent's flag is True

# Wrapping up? Revoke before the slave starts winding down to prevent late forks.
await set_nested_puppetry(id="worker", nested_puppetry=False)
```

Use `list_descendants("worker")` or `session_tree("worker")` from the master to observe the subtree.

## Permission modes — pick at open

| Mode | When |
|---|---|
| `strict` | You want to manually approve each tool the slave runs (read prompts on the screen, send `y<Enter>`) |
| `acceptEdits` | Auto-accept file edits, prompt for shell/network |
| `plan` | Slave is read-only, plans only. Useful for review-first workflows. |
| `yolo` | `--dangerously-skip-permissions`. Full autonomy. Slave can do anything. |

`strict-mcp-config` is on by default — the slave does NOT inherit master's arbitrary MCP servers; the only MCP entry written into the slave's config is the puppet itself. The puppet tools are loaded into every slave at startup, but actually using them to spawn sub-slaves is gated server-side by the `nested_puppetry` flag (see "Nested mastery" above). Default flag is `False` for spawned slaves, so a fresh slave can SEE the tools but `open_session(parent_id=…)` calls will be rejected until the master grants the capability.

## Common interactive prompts to handle

The slave is a real Claude Code TUI. Watch `read_screen` for these and answer:

| Prompt | Send |
|---|---|
| `Do you trust this folder?` | `["1", "<Enter>"]` (Yes) |
| Plan-mode "Approve this plan?" | `["1", "<Enter>"]` (Approve & execute) |
| `Press Enter to continue` / `[Y/n]` | `["<Enter>"]` |
| Onboarding/billing menu | Shouldn't appear — `.claude.json` is now copied from master at session create |

## Menu navigation — arrow keys, not "type the number"

Claude's `AskUserQuestion`-style menus often look like a numbered list:

```
❯ 1. Option A    (Recommended)
  2. Option B
  3. Option C
```

The cursor (`❯`) marks the highlighted choice. **Pressing the digit `1` does NOT select option 1** — it types `1` into the input box. To select a different option, send arrow keys:

| Need | Send |
|---|---|
| Pick option 1 (already highlighted) | `["<Enter>"]` |
| Pick option 2 | `["<Down>", "<Enter>"]` |
| Pick option 3 | `["<Down>", "<Down>", "<Enter>"]` |
| Pick the last option (e.g. "Chat") | `["<Up>", "<Enter>"]` (wraps from top) |
| Multi-step Type/Style/Autostart wizards | `["<Right>"]` to advance, `["<Left>"]` to go back |
| Switch model picker | `<Up>`/`<Down>` then `<Enter>` |
| Tab through fields | `<Tab>` / `<S-Tab>` |
| Long lists with `(↓ N more)` | `<PageDown>` / `<PageUp>` to scroll |
| Cancel a menu | `["<Esc>"]` |

Resolved key vocab (already plumbed through the Node bridge):

```
<Up>     \x1b[A      <Down>   \x1b[B    <Left>   \x1b[D    <Right>  \x1b[C
<S-Up>   \x1b[1;2A   <S-Down> \x1b[1;2B <S-Left> \x1b[1;2D <S-Right> \x1b[1;2C
<Tab>    \t          <S-Tab>  \x1b[Z    <Home>   \x1b[H    <End>    \x1b[F
<PageUp> \x1b[5~     <PageDn> \x1b[6~   <Esc>    \x1b      <Enter>   \r
<C-c>    \x03        <C-d>    \x04      <Bs>     \x7f      <Del>    \x1b[3~
<F1>..<F12>          <C-a>..<C-z>       <Paste-start>/<Paste-end>
```

Full vocab: `pty-bridge/src/keys.ts` (`knownNames()`).

## Reading menus reliably

When a delta returns a numbered list, parse it: the line starting with `❯ ` is the highlighted option, lines starting with `  N.` are the rest. Count down-arrows from there. Don't assume option 1 is always highlighted — after a previous mistake the cursor may be on a different row.

## Session ownership and resume

The daemon persists every session it ever opens to `~/.cache/claude-puppet/state.db` (SQLite, WAL). Each row carries `owner`, `status` (`alive`/`closed`/`crashed`), pid, cwd, permission_mode, transcript path, and timestamps.

- Pass `owner="<your-name>"` to `open_session` so future masters can identify whose sessions are whose. Default is `"anonymous"`.
- `list_sessions(owner="me")` enumerates only your rows; `list_sessions(status="alive")` finds running slaves; no args returns everything ever recorded. Each row includes `alive_in_bridge` so you can tell which DB rows still have a live PTY.
- `resume_session(id)` looks up the DB row, probes the bridge, and (when alive) re-registers the in-process spec so the standard tools work on it. Optionally pass `owner=` to claim it. When the bridge no longer has the session, you still get the row plus a note pointing you at `read_log` for the transcript.
- Daemon restarts (systemd unit `claude-puppet-mcp`) flip every still-`alive` row to `crashed` with `exit_signal='daemon_restart'`. The transcripts under `~/.cache/claude-puppet/sessions/<id>/transcripts/transcript.jsonl` survive — replay with `read_log`.
- `close_session` marks the row `closed` (`exit_signal='user_close'`); a slave that exits on its own gets the real exit code/signal.

## Slave's HOME isolation

Each slave gets `~/.cache/claude-puppet/sessions/<id>/home/` as its `$HOME`. The master's `~/.claude/.credentials.json` and `~/.claude/settings.json` are SYMLINKED in (auth + read-mostly settings). The master's `~/.claude.json` is COPIED so onboarding/trust state carries over. Everything mutable (projects/, sessions/, history.jsonl, etc.) is private per slave.

## Anti-recursion environment scrub

`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_*`, `NO_COLOR`, `CI` are stripped from the slave's env. Terminal env (`TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG=C.UTF-8`, `FORCE_COLOR=3`) is hard-set.

## Driving N slaves in parallel

Preferred: spawn N slaves with the same `owner=`, send to each, then `drain_events(owner=..., timeout_ms=...)` in a loop. One queue, N producers, the master reacts to whichever slave moves first. See "Driving slaves event-driven (preferred)" above.

Legacy (still works): one `ClientSession` over the HTTP daemon and `asyncio.gather` two `drive_slave` coroutines. The MCP session multiplexes by request id — concurrent tool calls are safe — but each coroutine still blocks on its own slave. Use this only when each slave's work is genuinely independent and you don't need cross-slave reactivity.

## Service management

```sh
bash <your-clone>/scripts/install-services.sh {install,status,logs,stop,remove}
```

For survive-reboot when not logged in (one-shot):
```sh
sudo loginctl enable-linger "$USER"
```

## Supervising slaves: diagnostic patterns

The tooling supports rigorous evidence-based supervision; the master's instinct is to read summaries and infer. Resist that. Common pitfalls and the patterns that avoid them:

### Stale events on reconnect or after a break

`drain_events` returns whatever's queued — including hundreds of buffered events from before an auth break, a daemon hiccup, or your own attention gap. They contaminate the read of *current* state AND burn 8-15k tokens of master context if you let them in.

**First-choice fix (cheap):** call the flush helper via Bash. It eats the backlog without bringing the per-event content into the master's transcript:

```sh
bash ~/.claude/hooks/puppet-flush.sh me
# → flushed 583 events (12 fresh, 571 stale; pending=0)
```

Alerts (auth errors, etc.) still surface from the flushed events, so you don't silently drop important signals.

**Equivalent in-tool pattern (more expensive):** drain everything once with `timeout_ms=0` to discard the backlog (ignore the result), then drain again with a long timeout for fresh-only:

```python
_ = await drain_events(owner="me", timeout_ms=0, max_events=1000)   # discard backlog
fresh = await drain_events(owner="me", timeout_ms=5000)              # only fresh
```

**Pattern: filter to high-signal types.** `prompt_visible` + `exited` are low-volume and decisive; `new_lines` is content-rich but noisy after a break:

```python
events = await drain_events(owner="me", timeout_ms=5000,
                            types=["prompt_visible", "exited"])
```

**Pattern: the UserPromptSubmit hook auto-drops stale events.** `~/.claude/hooks/puppet-drain.sh` filters events older than `PUPPET_DRAIN_MAX_AGE_S` (default 60s) before printing. So if the hook is wired in `settings.json`, every user-prompt injection is fresh by construction.

### Suspicious "done in zero work" (auth cascade & friends)

A slave reports `prompt_visible` quickly with no observable progress, or `drain_events` is empty when you expected output. Don't trust no-news-is-good-news. Common cause: auth failure (HTTP 401), expired credentials, claude itself errored silently — the puppet sees the slave go idle but doesn't know the idle came from an error.

**Pattern: cross-check with `read_screen`.** When the puppet's narrative says nothing, the screen shows the truth. Watch for:

- `"Unauthorized"` / `"401"` / `"Authentication"` / `"credentials"` — credentials issue.
- `"Error:"` / `"failed"` — runtime errors.
- A spinner stuck on the same status for minutes — wedged or auth-loop.
- An input box that still shows your prompt as queued text — slave never submitted it.

**Pattern: the hook auto-flags known error strings.** `puppet-drain.sh` scans event line text for the known error patterns above and prepends a `<puppet-alert>` block above the events block when any match. Wired hook = warning visible on next user prompt.

### Mid-turn interjection — the real trade-off

You're chatting with the master; the master is driving a slave; mid-task you realize the slave is wrong. Two real options, neither painless:

**Queue (recommended for non-emergencies).** `send_text(id, text)` without a following `<Enter>` types into the input box but doesn't submit. The slave sees the queue on its NEXT turn. **Risk: the slave may "self-consolidate"** — commit to a wrong direction during the current turn before reading the queue.

```python
await send_text(id="worker", text="STOP — use library X, not Y")
# Do NOT send <Enter>. The text sits in the slave's input box; visible on dashboard.
```

**Hard interrupt.** `interrupt(id)` sends Ctrl-C, stopping mid-generation. **Cost: in-flight work in this turn is lost**; if mid-tool-call, the tool result is lost too. Use for principle-level corrections that materially change the outcome.

```python
await interrupt(id="worker")
await send_text(id="worker", text="redirect: use library X not Y, retry")
await send_keys(id="worker", keys=["<Enter>"])
```

**Direction matters — the asymmetry of who-can-interrupt-whom:**

- **User → master:** Claude Code's harness surfaces user messages as a `<system-reminder>` attached to the next tool-result during the master's turn. So the user CAN interject mid-turn; the master sees it during its current turn, even mid-tool-call. (Demonstrated: this very session has done it three times.)
- **Master → slave:** queue or hard interrupt, with the trade-off above. There's no system-reminder mechanism between master and slave PTY; the slave is unmodified Claude Code and reads input only at turn boundaries.
- **Slave → master:** only when master `drain_events` (or via the UserPromptSubmit hook). No auto-push from slave to master's context.

### Audit discipline — verify, don't infer

- **`drain_events` is a partial view.** Coalesce + cursor-row filter mean some screen content never reaches the queue. For "did this actually happen," use `read_screen` or `read_log`.
- **Slave self-reports are not ground truth.** If the slave claims "I added the X handler," verify by reading the file directly or `read_log` + grep.
- **The dashboard at http://localhost:5055** is the human-readable second source. Surface its URL to the user when state is ambiguous.
- **`puppet-debug` at `~/projects/puppet-debug/`** has `forensics`, `trace`, `replay` subcommands. Use them for post-hoc reconstruction.
- **HOME isolation rule:** see "Slave's HOME isolation" above. Auto-memory does not cascade — for cross-slave context, write a `BRIEF.md` to the shared `cwd`, not to memory.

## When something is wrong

- Slave seems stuck → `read_screen()` and look for an unanswered prompt; or `interrupt(force=True)` and `close_session` then reopen.
- Bridge died → `systemctl --user restart claude-puppet-mcp.service` and reopen sessions.
- Want to see what the slave is actually doing → open the dashboard at http://localhost:5055.
- Need to replay → `read_log(id, since_offset=0)` returns transcript frames.
- "Drain returned hundreds of stale events" → see "Stale events on reconnect" above.
- "Slave reported done but did zero work" → see "Suspicious 'done in zero work'" above.

## Reference

- Architecture deep-dive: `<your-clone>/docs/architecture.md`
- Config snippets: `<your-clone>/examples/`
