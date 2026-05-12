"""FastMCP master-facing tools for driving slave `claude` sessions."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import itertools
import json
import os
import re
import secrets
import time
from collections import deque
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from . import db
from .bridge import Bridge
from .classify import RowClass, classify_screen
from .log import get_logger
from .screen import compute_idle_metrics, hash_history_push, is_idle
from .sessions import (
    VALID_MODES,
    SessionRegistry,
    SessionSpec,
    assert_permission_monotonic,
    build_spec,
    cache_root,
    spec_from_db_row,
    sync_credentials_from_master,
)

log = get_logger("mcp")

mcp = FastMCP("claude-puppet")

_bridge: Bridge | None = None
_registry = SessionRegistry()
_history: dict[str, list[dict[str, Any]]] = {}
_last_data_ts: dict[str, int] = {}
_last_prompt_ts: dict[str, int] = {}
_exited: dict[str, dict[str, Any]] = {}

# Per-session "last screen state already delivered to the master". Used to dedup
# read_screen returns: when the slave's screen hash matches what the master has
# already seen, we return a minimal {unchanged: true} payload instead of the full
# 200x50 buffer. When it differs, we return only the changed rows, not the entire
# rendered text. This keeps the master's context window from accumulating the
# slave's full transcript on every read.
_master_last_hash: dict[str, str] = {}
_master_last_text: dict[str, str] = {}
_master_last_render_hash: dict[str, str] = {}
_master_last_content_hash: dict[str, str] = {}

# Per-session asyncio.Lock guarding the snap1/sleep/snap2/build_payload critical
# section. Acquired only on the tracker-mutating path (view_only=False) so that
# two concurrent reads on the same sid can't interleave the four _master_last_*
# updates.
_session_locks: dict[str, asyncio.Lock] = {}


def _get_session_lock(sid: str) -> asyncio.Lock:
    """Lazily create and return the per-session lock."""
    lock = _session_locks.get(sid)
    if lock is None:
        lock = asyncio.Lock()
        _session_locks[sid] = lock
    return lock

# Default classes shown to the master when read_screen is called without an
# explicit include_classes filter — chat/menu/prompt is the signal; status and
# chrome are the noise.
_DEFAULT_INCLUDE_CLASSES = (RowClass.CHAT, RowClass.MENU, RowClass.PROMPT)
_CONTENT_HASH_CLASSES = (RowClass.CHAT, RowClass.MENU, RowClass.PROMPT)

# --- Push-and-drain event queue (multiplexed long-poll) ---------------------
# Slaves feed committed lines into a per-OWNER queue; the master drains via
# `drain_events`. This replaces the blocking single-slave wait_and_read /
# wait_for_idle pattern: the master picks up new lines from any of its slaves
# in one tool call instead of stalling on one. Critical invariant: NO line is
# ever re-pushed once it has been emitted, and "updating" rows (cursor row,
# anything below the cursor — i.e. input box, status spinner, token counter)
# are never considered for emission at all. Only stable, committed,
# above-cursor, classified-as-content lines flow.

# A line matching this regex is the slave's INPUT BOX echo — the prompt the
# master just typed, sitting in the input box with terminal-padded trailing
# whitespace. It's CHAT-classified (the menu regex requires `❯ N.` form), but
# the master *typed it themselves* — re-delivering it via drain_events is
# pure noise. Excluded from new_lines emissions even when above the cursor,
# because the cursor can briefly sit elsewhere while the input box still
# holds the just-typed text (race between submit and box-clear).
_INPUT_ECHO_RX = re.compile(r"^\s*❯\s+(?!\d+\.\s)\S")
_owner_by_sid: dict[str, str] = {}
_event_queue: dict[str, deque[dict[str, Any]]] = {}
_event_signal: dict[str, asyncio.Event] = {}
_event_seq = itertools.count(1)
_EVENT_QUEUE_MAX = 1024
_COMMIT_DEBOUNCE_MS = 1000

_commit_timer: dict[str, asyncio.TimerHandle] = {}
# Per-session emitted-line text set. Bounded by simple swap on overflow:
# when len > _EVENT_EMITTED_MAX, we discard half (FIFO via insertion-ordered
# dict). 4096 unique committed lines covers a multi-hour slave session.
_event_emitted: dict[str, dict[str, None]] = {}
_EVENT_EMITTED_MAX = 4096


def _ensure_owner_queue(owner: str) -> tuple[deque[dict[str, Any]], asyncio.Event]:
    """Lazily create and return the per-owner event queue + wake signal."""
    q = _event_queue.get(owner)
    if q is None:
        q = deque(maxlen=_EVENT_QUEUE_MAX)
        _event_queue[owner] = q
    sig = _event_signal.get(owner)
    if sig is None:
        sig = asyncio.Event()
        _event_signal[owner] = sig
    return q, sig


def _push_event(sid: str, ev: dict[str, Any]) -> None:
    """Push an event to the owner's queue (no-op if sid has no registered owner)."""
    owner = _owner_by_sid.get(sid)
    if not owner:
        return
    q, sig = _ensure_owner_queue(owner)
    q.append(ev)
    sig.set()


async def _emit_commit(sid: str) -> None:
    """Commit-throttle watcher body. Snapshot → classify → emit fresh lines.

    Fires at most once per _COMMIT_DEBOUNCE_MS while data is flowing; goes
    idle when no data arrives. Stability of emitted rows is guaranteed by the
    cursor-row filter below (above-cursor rows cannot change by construction),
    not by waiting for idle. Emits ONLY rows that are:
      - strictly above the cursor row (excludes streaming partials, input
        box content, status spinner, token counter — anything still
        mutating by construction)
      - classified as chat/menu/prompt (excludes chrome/status by class)
      - text not previously emitted for this sid
    """
    if sid in _exited:
        return
    if _registry.get(sid) is None:
        return
    bridge = _bridge
    if bridge is None:
        return
    try:
        snap: dict[str, Any] = await bridge.call(
            "snapshot", {"id": sid, "mode": "visible", "includeCursor": True}, timeout=5.0
        )
    except Exception as e:
        log.warning("event watcher snapshot failed", id=sid, error=str(e))
        return

    cur_text = snap.get("text") or ""
    cursor = snap.get("cursor") or {}
    cursor_row = cursor.get("row")
    if not isinstance(cursor_row, int) or cursor_row <= 0:
        # No cursor info or cursor at top → nothing is "definitely above the
        # cursor"; emit nothing this tick. The next data burst will retry.
        return

    emitted = _event_emitted.setdefault(sid, {})
    fresh: list[dict[str, Any]] = []
    for row_index, cls, line in classify_screen(cur_text):
        if row_index >= cursor_row:
            break  # rows are in order; once we hit the cursor, stop scanning
        if cls not in _DEFAULT_INCLUDE_CLASSES:
            continue
        stripped = line.strip()
        if not stripped:
            continue
        if _INPUT_ECHO_RX.match(line):
            # Input-box echo of a prompt the master just typed. The master
            # already has it in their conversation; sending it back is noise.
            continue
        if line in emitted:
            continue
        fresh.append({"row": row_index, "text": line, "class": cls.value})
        emitted[line] = None

    if len(emitted) > _EVENT_EMITTED_MAX:
        # Drop the oldest half to bound memory. Insertion-ordered dict makes
        # this O(n) but rare (every ~2000 lines past the cap).
        keep_from = len(emitted) - _EVENT_EMITTED_MAX // 2
        _event_emitted[sid] = {k: None for k in list(emitted)[keep_from:]}

    if not fresh:
        return

    _push_event(sid, {
        "seq": next(_event_seq),
        "ts": _now_ms(),
        "type": "new_lines",
        "sid": sid,
        "lines": fresh,
    })


def _schedule_commit(sid: str) -> None:
    """Throttle: schedule a commit flush iff one isn't already pending.

    Each `data` event triggers this. If a timer is already pending we leave
    it alone (so the master sees a flush every ~_COMMIT_DEBOUNCE_MS even
    during a sustained stream); if not we arm a fresh one.
    """
    if sid in _commit_timer:
        return  # already pending; let it fire on its existing schedule
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    def _fire() -> None:
        _commit_timer.pop(sid, None)
        asyncio.create_task(_emit_commit(sid))
    _commit_timer[sid] = loop.call_later(_COMMIT_DEBOUNCE_MS / 1000.0, _fire)

_SECRET_KEY_PATTERN = re.compile(
    r"(?i)\b(?:password|passwd|pwd|secret|token|credential|"
    r"api[_-]?key|access[_-]?key|private[_-]?key|"
    r"auth(?:[_-]?token)?|bearer|client[_-]?secret)\b"
)


def _now_ms() -> int:
    return int(time.time() * 1000)


def set_bridge(b: Bridge) -> None:
    """Install the module-level bridge and register the event handler."""
    global _bridge
    _bridge = b
    b.add_event_handler(_on_bridge_event)


def _on_bridge_event(frame: dict[str, Any]) -> None:
    ev = frame.get("event")
    sid = frame.get("id")
    if not isinstance(sid, str):
        return
    ts = int(frame.get("ts") or _now_ms())
    if ev == "data":
        _last_data_ts[sid] = ts
        _schedule_commit(sid)
    elif ev == "prompt_visible":
        _last_prompt_ts[sid] = ts
        _push_event(sid, {
            "seq": next(_event_seq), "ts": ts, "type": "prompt_visible", "sid": sid,
        })
    elif ev == "exit":
        _exited[sid] = {"code": frame.get("code"), "signal": frame.get("signal"), "ts": ts}
        try:
            db.mark_closed(sid, code=frame.get("code"), signal=frame.get("signal"), ts_ms=ts)
        except Exception as e:
            log.warning("db.mark_closed on exit failed", id=sid, error=str(e))
        # Emit a final exited event BEFORE we tear down the owner mapping —
        # otherwise the master loses any signal that the slave died.
        _push_event(sid, {
            "seq": next(_event_seq), "ts": ts, "type": "exited", "sid": sid,
            "code": frame.get("code"), "signal": frame.get("signal"),
        })
        # Cancel any pending commit-debounce timer and clear watcher state.
        timer = _commit_timer.pop(sid, None)
        if timer is not None:
            timer.cancel()
        _event_emitted.pop(sid, None)
        # Free per-session in-memory tracker state — slave is dead, the master
        # won't ever ask about it again, and these dicts otherwise accumulate
        # ~40KB per crashed-slave forever.
        _history.pop(sid, None)
        _master_last_hash.pop(sid, None)
        _master_last_text.pop(sid, None)
        _master_last_render_hash.pop(sid, None)
        _master_last_content_hash.pop(sid, None)
        _last_data_ts.pop(sid, None)
        _last_prompt_ts.pop(sid, None)
        # Keep _owner_by_sid until close_session so drain_events can still
        # find the queue for any straggling consumer.


def _ensure_bridge() -> Bridge:
    if _bridge is None:
        raise RuntimeError("bridge not initialized")
    return _bridge


def _registry_or_404(sid: str) -> SessionSpec:
    spec = _registry.get(sid)
    if spec is None:
        raise ValueError(f"unknown session id: {sid!r}")
    return spec


def _alive_or_exited(sid: str) -> SessionSpec:
    """Like _registry_or_404 but ALSO rejects when the slave PTY has already exited.

    If the bridge has fired `exit` for this id (populating `_exited[sid]`), any
    operation against the live PTY (write, read_screen, signal, resize) is a
    silent no-op against a dead process. Raise instead so the master sees the
    failure and calls close_session to clean up state.
    """
    spec = _registry_or_404(sid)
    info = _exited.get(sid)
    if info is not None:
        raise ValueError(
            f"session {sid!r} has exited "
            f"(code={info.get('code')}, signal={info.get('signal')}, ts={info.get('ts')}); "
            f"call close_session to clean up"
        )
    return spec


def _changed_lines(prev: str, curr: str) -> list[dict[str, Any]]:
    """Row-indexed diff: lines in curr that differ from prev at the same row."""
    prev_lines = prev.split("\n") if prev else []
    curr_lines = curr.split("\n")
    out: list[dict[str, Any]] = []
    for i, line in enumerate(curr_lines):
        if i >= len(prev_lines) or prev_lines[i] != line:
            out.append({"row": i, "text": line})
    return out


def _normalize_classes(values: list[str] | None) -> tuple[RowClass, ...]:
    """Coerce a master-supplied list of class names into a RowClass tuple."""
    if values is None:
        return _DEFAULT_INCLUDE_CLASSES
    out: list[RowClass] = []
    for v in values:
        try:
            out.append(RowClass(v))
        except ValueError:
            continue
    return tuple(out) if out else _DEFAULT_INCLUDE_CLASSES


def _content_hash(text: str) -> str:
    """SHA1 of only the rows whose class is in the content set."""
    classified = classify_screen(text)
    keep = [t for _, c, t in classified if c in _CONTENT_HASH_CLASSES]
    h = hashlib.sha1()
    h.update("\n".join(keep).encode("utf-8", errors="replace"))
    return h.hexdigest()


def _annotate_changed_lines(
    prev: str, curr: str, allowed: tuple[RowClass, ...]
) -> list[dict[str, Any]]:
    """Row-diff filtered to `allowed` classes, with class label per row."""
    prev_lines = prev.split("\n") if prev else []
    curr_lines = curr.split("\n")
    classified = classify_screen(curr)
    by_row = {row: cls for row, cls, _ in classified}
    out: list[dict[str, Any]] = []
    for i, line in enumerate(curr_lines):
        if i >= len(prev_lines) or prev_lines[i] != line:
            cls = by_row.get(i, RowClass.CHAT)
            if cls in allowed:
                out.append({"row": i, "text": line, "class": cls.value})
    return out


def _committed_rows(prev_text: str, curr_text: str) -> list[str | None]:
    """Per-row stability filter (index-based): text iff identical in prev/curr, else None."""
    prev_lines = prev_text.split("\n") if prev_text else []
    curr_lines = curr_text.split("\n") if curr_text else [""]
    out: list[str | None] = []
    for i, line in enumerate(curr_lines):
        if i < len(prev_lines) and prev_lines[i] == line:
            out.append(line)
        else:
            out.append(None)
    return out


def _committed_rows_v2(prev_text: str, curr_text: str) -> list[str | None]:
    """Content-set commitment: row committed iff its text exists anywhere in prev.

    Survives scroll, alt-buffer toggles, and full repaints where index-based
    matching would falsely flag every row as in-flight. Blank rows are trivially
    committed (TUIs have many of them).
    """
    prev_lines = prev_text.split("\n") if prev_text else []
    curr_lines = curr_text.split("\n") if curr_text else [""]
    prev_set = set(prev_lines)
    out: list[str | None] = []
    for line in curr_lines:
        if line == "" or line in prev_set:
            out.append(line)
        else:
            out.append(None)
    return out


def _annotated_full_text(text: str, allowed: tuple[RowClass, ...]) -> list[dict[str, Any]]:
    """Full-text rows tagged with class + filtered to `allowed`."""
    out: list[dict[str, Any]] = []
    for row, cls, line in classify_screen(text):
        if cls in allowed:
            out.append({"row": row, "text": line, "class": cls.value})
    return out


def _trim_minimal(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Strip the heavy `text`/`serialized` fields, keep cursor + metrics + hash."""
    return {
        "hash": snapshot.get("hash"),
        "cursor": snapshot.get("cursor"),
        "alt": snapshot.get("alt"),
        "rows": snapshot.get("rows"),
        "cols": snapshot.get("cols"),
        "idle_since_ms": snapshot.get("idleSinceMs"),
        "last_prompt_at_ms": snapshot.get("lastPromptAtMs"),
    }


def _jsonable(v: Any) -> Any:
    try:
        json.dumps(v)
        return v
    except (TypeError, ValueError):
        return repr(v)


def _redact_args(args: Any) -> Any:
    """Strip secrets from args before persisting to disk.
    Redacts the entire `env` mapping (full of inherited environment) and any
    key whose name matches secret-name patterns.
    """
    if not isinstance(args, dict):
        return args
    out: dict[str, Any] = {}
    for k, v in args.items():
        if k == "env":
            out[k] = "<redacted-env-dict>" if v else None
        elif isinstance(k, str) and _SECRET_KEY_PATTERN.search(k):
            out[k] = "<redacted>"
        else:
            out[k] = v
    return out


# --- Audit-log tamper-evidence ----------------------------------------------
# A shared HMAC-SHA256 key, stored at ~/.cache/claude-puppet/audit-hmac-key
# (mode 0o600), is used by both the puppet writer (this file) and the dashboard
# writer (`dashboard/server/audit.ts`) so any uid=ahmed process appending forged
# lines to a session's `tool_calls.jsonl` can be detected by recomputing the
# per-record HMAC. The HMAC is taken over the canonical JSON of the record
# WITHOUT the `hmac` key — both writers MUST produce identical canonical bytes
# (separators=(",", ":"), keys sorted alphabetically) for verification to work.

_AUDIT_HMAC_KEY: bytes | None = None


def _load_or_create_audit_key() -> bytes:
    """Lazy-load or create the shared audit-log HMAC key.

    Returns the 32-byte key. On filesystem failure, falls back to a 32-byte
    zero key so that audit writes still produce a (degraded) HMAC instead of
    crashing — the line is still tamper-evident relative to other lines
    written under the same degraded mode.
    """
    global _AUDIT_HMAC_KEY
    if _AUDIT_HMAC_KEY is not None:
        return _AUDIT_HMAC_KEY
    key_path = cache_root().parent / "audit-hmac-key"
    try:
        if key_path.exists():
            _AUDIT_HMAC_KEY = bytes.fromhex(key_path.read_text().strip())
        else:
            _AUDIT_HMAC_KEY = secrets.token_bytes(32)
            tmp = key_path.with_suffix(".tmp")
            tmp.write_text(_AUDIT_HMAC_KEY.hex())
            os.chmod(tmp, 0o600)
            tmp.replace(key_path)
    except OSError as e:
        log.warning("audit hmac key load/create failed: %s", e)
        _AUDIT_HMAC_KEY = b"\x00" * 32  # degraded mode; still tamper-evident-relative-to-itself
    return _AUDIT_HMAC_KEY


def verify_audit_line(line: str) -> bool:
    """Verify a single audit-log line's HMAC.

    Parses one JSON record from a `tool_calls.jsonl` line, pops the `hmac`
    field, recomputes HMAC-SHA256 over the canonical JSON of the remaining
    record (separators=(",", ":"), keys sorted), and compares against the
    popped value via `hmac.compare_digest`. Returns False on any parse error,
    missing `hmac` field, or mismatch. Intended for use by future forensics
    tools (e.g. `puppet-debug forensics`); not wired into any MCP tool.
    """
    try:
        rec = json.loads(line)
    except (TypeError, ValueError):
        return False
    if not isinstance(rec, dict):
        return False
    expected = rec.pop("hmac", None)
    if not isinstance(expected, str):
        return False
    canonical = json.dumps(rec, separators=(",", ":"), sort_keys=True)
    computed = hmac.new(
        _load_or_create_audit_key(), canonical.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, computed)


def _log_call(
    sid: str | None,
    op: str,
    args: dict[str, Any],
    *,
    result: Any = None,
    error: str | None = None,
    duration_ms: int,
) -> None:
    # Failed open_session calls must not create the per-session directory:
    # the dashboard's file watcher would otherwise register a ghost "running"
    # session for an id that never spawned. Route to a single failed_opens.jsonl
    # at the cache root.
    if sid is not None and op == "open_session" and error is not None:
        path = cache_root() / "failed_opens.jsonl"
    else:
        path = (cache_root() / sid / "tool_calls.jsonl") if sid else (cache_root() / "tool_calls.jsonl")
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = {
        "ts": _now_ms(),
        "op": op,
        "args": _jsonable(_redact_args(args)),
        "result": _jsonable(result) if result is not None else None,
        "error": error,
        "duration_ms": duration_ms,
    }
    # Tamper-evidence: HMAC over canonical JSON of the record without the hmac
    # field itself. The written line need not be canonical — only the HMAC
    # input must be byte-identical to what `verify_audit_line` will recompute.
    canonical = json.dumps(rec, separators=(",", ":"), sort_keys=True)
    rec["hmac"] = hmac.new(
        _load_or_create_audit_key(), canonical.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    try:
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, separators=(",", ":")) + "\n")
    except OSError as e:
        log.warning("tool_calls log write failed", path=str(path), error=str(e))


@contextmanager
def _logged(sid: str | None, op: str, args: dict[str, Any]) -> Iterator[dict[str, Any]]:
    start = _now_ms()
    box: dict[str, Any] = {"result": None, "error": None}
    try:
        yield box
    except BaseException as e:
        box["error"] = f"{type(e).__name__}: {e}"
        _log_call(sid, op, args, result=None, error=box["error"], duration_ms=_now_ms() - start)
        raise
    _log_call(
        sid, op, args, result=box["result"], error=None, duration_ms=_now_ms() - start
    )


@mcp.tool()
async def open_session(
    id: str,
    cwd: str,
    permission_mode: str = "strict",
    allowed_tools: list[str] | None = None,
    env: dict[str, str] | None = None,
    cols: int = 200,
    rows: int = 50,
    mcp_servers: dict[str, Any] | None = None,
    owner: str = "anonymous",
    parent_id: str | None = None,
    nested_puppetry: bool = False,
    max_depth: int = 3,
) -> dict[str, Any]:
    """Spawn an isolated slave `claude` process under per-session $HOME."""
    args = {
        "id": id,
        "cwd": cwd,
        "permission_mode": permission_mode,
        "allowed_tools": allowed_tools,
        "env": env,
        "cols": cols,
        "rows": rows,
        "mcp_servers": mcp_servers,
        "owner": owner,
        "parent_id": parent_id,
        "nested_puppetry": nested_puppetry,
        "max_depth": max_depth,
    }
    with _logged(id, "open_session", args) as box:
        bridge = _ensure_bridge()
        if not isinstance(max_depth, int) or max_depth < 1:
            raise ValueError(f"max_depth must be >= 1, got {max_depth!r}")
        # Resolve parent-derived depth/max_depth and enforce monotonicity.
        if parent_id is not None:
            parent = db.get_session(parent_id)
            if parent is None:
                raise ValueError(f"unknown parent_id: {parent_id!r}")
            # Server-side gate: parent must have been granted sub-spawn
            # capability. Always-loaded puppet MCP means the slave SEES the
            # tools regardless, but using them requires the master to flip
            # this flag (at spawn-time via open_session(..., nested_puppetry=True),
            # or at runtime via set_nested_puppetry).
            if not bool(parent.get("nested_puppetry") or 0):
                raise PermissionError(
                    f"parent {parent_id!r} is not authorized to spawn sub-slaves "
                    f"(nested_puppetry=False). The master can grant this at runtime "
                    f"by calling set_nested_puppetry(id={parent_id!r}, nested_puppetry=True)."
                )
            assert_permission_monotonic(parent["permission_mode"], permission_mode)
            parent_depth = int(parent.get("depth") or 0)
            parent_max = int(parent.get("max_depth") or 3)
            child_depth = parent_depth + 1
            if child_depth > parent_max:
                raise ValueError(
                    f"depth cap exceeded: child depth {child_depth} > parent max_depth {parent_max}"
                )
            effective_max_depth = min(int(max_depth), parent_max)
        else:
            child_depth = 0
            effective_max_depth = int(max_depth)

        spec = build_spec(
            sid=id,
            cwd=cwd,
            permission_mode=permission_mode,  # type: ignore[arg-type]
            allowed_tools=allowed_tools,
            env=env,
            cols=cols,
            rows=rows,
            mcp_servers=mcp_servers,
            parent_id=parent_id,
            depth=child_depth,
            max_depth=effective_max_depth,
            nested_puppetry=nested_puppetry,
        )
        result = await bridge.call(
            "open",
            {
                "id": spec.id,
                "cmd": spec.cmd,
                "cmdArgs": spec.cmd_args,
                "cwd": spec.cwd,
                "env": spec.env,
                "cols": spec.cols,
                "rows": spec.rows,
                "transcriptDir": str(spec.transcript_dir),
            },
        )
        _registry.register(spec)
        _history.setdefault(id, [])
        # Register the owner mapping + initialize the watcher's emitted-set so
        # `drain_events` for this owner picks up this session's new_lines events.
        _owner_by_sid[id] = owner
        _ensure_owner_queue(owner)
        _event_emitted.setdefault(id, {})
        pid = int(result.get("pid")) if isinstance(result, dict) and result.get("pid") is not None else None
        try:
            db.insert_session(
                spec,
                owner=owner,
                pid=pid,
                parent_id=parent_id,
                depth=child_depth,
                max_depth=effective_max_depth,
                nested_puppetry=nested_puppetry,
            )
        except Exception as e:
            log.warning("db.insert_session failed", id=id, error=str(e))
        # Readiness probe: node-pty's spawn returns a pid synchronously even if
        # execve will fail (e.g. binary missing, env error). Wait briefly and
        # check the bridge's session list to confirm the slave is still alive.
        await asyncio.sleep(0.2)
        try:
            bridge_info = await bridge.call("list_sessions", {})
            inner = bridge_info if isinstance(bridge_info, list) else (
                bridge_info.get("sessions", []) if isinstance(bridge_info, dict) else []
            )
            entry = next((s for s in inner if isinstance(s, dict) and s.get("id") == id), None)
            if entry is not None and entry.get("exited"):
                try:
                    db.mark_closed(id, code=None, signal="failed_to_start", ts_ms=_now_ms())
                except Exception:
                    pass
                _registry.remove(id)
                _history.pop(id, None)
                raise RuntimeError(
                    f"slave {id!r} failed to start (exited immediately after spawn; "
                    f"cwd or argv likely invalid)"
                )
        except RuntimeError:
            raise
        except Exception as e:
            log.warning("readiness probe failed (non-fatal)", id=id, error=str(e))
        out = {
            "id": id,
            "owner": owner,
            "pid": pid,
            "home": str(spec.home),
            "transcript_dir": str(spec.transcript_dir),
            "parent_id": parent_id,
            "depth": child_depth,
            "max_depth": effective_max_depth,
            "nested_puppetry": bool(nested_puppetry),
        }
        box["result"] = out
        return out


@mcp.tool()
async def send_keys(id: str, keys: list[str]) -> dict[str, Any]:
    """Send a list of key-names or text fragments to the slave PTY."""
    args = {"id": id, "keys": keys}
    with _logged(id, "send_keys", args) as box:
        spec = _alive_or_exited(id)
        # Refresh slave's local credentials.json from master before dispatching
        # work — see sync_credentials_from_master for why staleness 401s the slave.
        try:
            sync_credentials_from_master(spec.home)
        except Exception as e:  # pragma: no cover - defensive
            log.warning("send_keys credential sync failed", id=id, error=str(e))
        bridge = _ensure_bridge()
        result = await bridge.call(
            "write", {"id": id, "items": keys, "bracketedPaste": False}
        )
        out = {"ok": True, "result": result}
        box["result"] = out
        return out


@mcp.tool()
async def send_text(id: str, text: str) -> dict[str, Any]:
    """Send verbatim text to the slave; auto bracketed-paste wraps when >32 chars."""
    args = {"id": id, "text_len": len(text)}
    with _logged(id, "send_text", args) as box:
        spec = _alive_or_exited(id)
        if "\x00" in text:
            raise ValueError("send_text rejected: text contains NUL byte (\\x00)")
        # Refresh slave's local credentials.json from master before dispatching
        # work — see sync_credentials_from_master for why staleness 401s the slave.
        try:
            sync_credentials_from_master(spec.home)
        except Exception as e:  # pragma: no cover - defensive
            log.warning("send_text credential sync failed", id=id, error=str(e))
        bridge = _ensure_bridge()
        bracketed = len(text) > 32
        result = await bridge.call(
            "write", {"id": id, "items": [text], "bracketedPaste": bracketed}
        )
        out = {"ok": True, "bracketed_paste": bracketed, "result": result}
        box["result"] = out
        return out


def _build_read_screen_payload(
    sid: str,
    snapshot: dict[str, Any],
    *,
    mode: str,
    since_hash: str | None,
    force_full: bool,
    include_classes: tuple[RowClass, ...],
    dedup: str,
    view_only: bool = False,
    prior_snapshot: dict[str, Any] | None = None,
    commit_window_ms: int = 0,
) -> dict[str, Any]:
    """Shared core for read_screen and wait_and_read."""
    cur_render_hash: str = snapshot.get("hash") or ""
    cur_text: str = snapshot.get("text") or ""

    # Append-only committed-row filter: when a prior snapshot is provided, drop
    # rows that mutated between the two reads (still in flight) and replace them
    # with the master's last-known text for that row, so future commits diff once.
    # v2 (content-set) is used so scroll / alt-buffer / repaint don't false-flag.
    in_flight_rows = 0
    effective_text = cur_text
    committed_for_first_read: list[str | None] | None = None
    if prior_snapshot is not None:
        prior_text: str = prior_snapshot.get("text") or ""
        committed = _committed_rows_v2(prior_text, cur_text)
        committed_for_first_read = committed
        prev_master = _master_last_text.get(sid, "") or ""
        prev_master_lines = prev_master.split("\n") if prev_master else []
        rebuilt: list[str] = []
        for i, c in enumerate(committed):
            if c is None:
                in_flight_rows += 1
                rebuilt.append(prev_master_lines[i] if i < len(prev_master_lines) else "")
            else:
                rebuilt.append(c)
        effective_text = "\n".join(rebuilt)

    cur_content_hash = _content_hash(effective_text)

    if dedup == "render":
        cur_dedup_hash = cur_render_hash
        last_dedup_hash = _master_last_render_hash.get(sid)
    else:
        cur_dedup_hash = cur_content_hash
        last_dedup_hash = _master_last_content_hash.get(sid)

    baseline_hash = since_hash if since_hash is not None else last_dedup_hash
    baseline_text = _master_last_text.get(sid, "") if since_hash is None else ""

    out: dict[str, Any] = _trim_minimal(snapshot)
    out.update(compute_idle_metrics(snapshot))
    out["render_hash"] = cur_render_hash
    out["content_hash"] = cur_content_hash
    out["dedup_basis"] = "render" if dedup == "render" else "content"
    if prior_snapshot is not None:
        out["in_flight_rows"] = in_flight_rows
        out["commit_window_ms_used"] = commit_window_ms

    if force_full or baseline_hash is None:
        # First-read / forced-full path: when a prior snap is present, mask
        # in-flight rows out of the emitted text so the master never sees a
        # mid-stream partial row on the very first read of a session.
        if prior_snapshot is not None and committed_for_first_read is not None:
            masked_lines = [c if c is not None else "" for c in committed_for_first_read]
            masked_text = "\n".join(masked_lines)
            out["text"] = masked_text
            out["full"] = True
            out["rows_classified"] = _annotated_full_text(masked_text, include_classes)
        else:
            out["text"] = effective_text
            out["full"] = True
            out["rows_classified"] = _annotated_full_text(effective_text, include_classes)
        if mode == "serialized" and snapshot.get("serialized"):
            out["serialized"] = snapshot["serialized"]
    elif cur_dedup_hash == baseline_hash:
        out["unchanged"] = True
    else:
        out["changed_lines"] = _annotate_changed_lines(
            baseline_text, effective_text, include_classes
        )

    if since_hash is None and not view_only:
        _master_last_hash[sid] = cur_render_hash
        _master_last_render_hash[sid] = cur_render_hash
        _master_last_content_hash[sid] = cur_content_hash
        _master_last_text[sid] = effective_text

    return out


@mcp.tool()
async def read_screen(
    id: str,
    mode: str = "visible",
    include_cursor: bool = True,
    since_hash: str | None = None,
    force_full: bool = False,
    include_classes: list[str] | None = None,
    dedup: str = "content",
    view_only: bool = False,
    commit_window_ms: int = 400,
) -> dict[str, Any]:
    """Render the slave's screen with class-aware dedup against the master's last view.

    - unchanged: ``{content_hash, render_hash, unchanged: true, ...}``
    - delta:     ``{changed_lines: [{row, text, class}, ...], ...}``
    - full:      ``{text, rows_classified: [...], full: true, ...}``

    ``include_classes`` filters which row classes appear in changed_lines /
    rows_classified (default: chat+menu+prompt). ``dedup="content"`` (default)
    means spinner/timer-only repaints register as `unchanged`; ``dedup="render"``
    falls back to the raw xterm-headless buffer hash.

    ``view_only=True`` reads without mutating the master's dedup tracker — for
    observers (e.g. the dashboard's screen-poller) that must not poison the real
    master's last-seen hash baseline.

    ``commit_window_ms`` (default 400) takes two snapshots that far apart and
    only surfaces rows that are stable across the window — in-flight rows that
    are still mutating are dropped until they settle. ``commit_window_ms=0``
    disables the second snapshot (legacy single-shot dedup path).
    """
    args = {
        "id": id,
        "mode": mode,
        "include_cursor": include_cursor,
        "since_hash": since_hash,
        "force_full": force_full,
        "include_classes": include_classes,
        "dedup": dedup,
        "view_only": view_only,
        "commit_window_ms": commit_window_ms,
    }
    with _logged(id, "read_screen", args) as box:
        _alive_or_exited(id)
        bridge = _ensure_bridge()
        allowed = _normalize_classes(include_classes)

        async def _do_read() -> dict[str, Any]:
            snap1: dict[str, Any] = await bridge.call(
                "snapshot", {"id": id, "mode": mode, "includeCursor": include_cursor}
            )
            hash_history_push(_history.setdefault(id, []), snap1)

            # Fast path: caller supplied a since_hash and the slave's render
            # hasn't changed at all -- skip the commit-window sleep entirely.
            # We don't mutate the master tracker (no harm in skipping the
            # second snap because nothing has changed). Gated on render-hash
            # equality, which is the strongest "literally nothing moved"
            # signal and is safe regardless of the dedup mode.
            if (
                since_hash is not None
                and not force_full
                and not view_only
                and snap1.get("hash") == since_hash
            ):
                fast_out = _trim_minimal(snap1)
                fast_out.update(compute_idle_metrics(snap1))
                fast_out["render_hash"] = snap1.get("hash")
                fast_out["content_hash"] = since_hash  # by definition still matches
                fast_out["unchanged"] = True
                fast_out["dedup_basis"] = "render" if dedup == "render" else "content"
                return fast_out

            snap2: dict[str, Any] | None = None
            window_used = 0
            if commit_window_ms > 0:
                await asyncio.sleep(commit_window_ms / 1000.0)
                try:
                    snap2 = await bridge.call(
                        "snapshot", {"id": id, "mode": mode, "includeCursor": include_cursor}
                    )
                    hash_history_push(_history.setdefault(id, []), snap2)
                    window_used = commit_window_ms
                except Exception as e:
                    log.warning("snap2 failed; degrading to single-snapshot", id=id, error=str(e))
                    snap2 = None
                    window_used = 0

            final_snap = snap2 if snap2 is not None else snap1
            prior = snap1 if snap2 is not None else None
            return _build_read_screen_payload(
                id,
                final_snap,
                mode=mode,
                since_hash=since_hash,
                force_full=force_full,
                include_classes=allowed,
                dedup=dedup,
                view_only=view_only,
                prior_snapshot=prior,
                commit_window_ms=window_used,
            )

        if view_only:
            out = await _do_read()
        else:
            async with _get_session_lock(id):
                out = await _do_read()
        box["result"] = {
            "render_hash": out.get("render_hash"),
            "content_hash": out.get("content_hash"),
            "shape": "full" if "text" in out else ("unchanged" if out.get("unchanged") else "delta"),
            "delta_rows": len(out.get("changed_lines", [])) if "changed_lines" in out else 0,
        }
        return out


@mcp.tool()
async def wait_for_idle(
    id: str, stable_ms: int = 600, timeout_ms: int = 30000
) -> dict[str, Any]:
    """Block until the slave's screen has been stable for ``stable_ms``.

    Returns ONLY a minimal "we got there" payload (hash + cursor + metrics).
    The full rendered buffer is intentionally not included — call ``read_screen``
    after this if you need the text, and that call will return a delta against
    your last view rather than the full buffer.
    """
    args = {"id": id, "stable_ms": stable_ms, "timeout_ms": timeout_ms}
    with _logged(id, "wait_for_idle", args) as box:
        _alive_or_exited(id)
        bridge = _ensure_bridge()
        deadline = _now_ms() + timeout_ms
        interval_ms = max(50, stable_ms // 6)
        history = _history.setdefault(id, [])
        last: dict[str, Any] | None = None
        while True:
            snap: dict[str, Any] = await bridge.call(
                "snapshot", {"id": id, "mode": "visible", "includeCursor": True}
            )
            hash_history_push(history, snap)
            last = snap
            if is_idle(snap, history, stable_ms=stable_ms):
                out = _trim_minimal(snap)
                out.update(compute_idle_metrics(snap))
                out["idle"] = True
                box["result"] = {"idle": True, "hash": snap.get("hash")}
                return out
            if _now_ms() >= deadline:
                raise TimeoutError(
                    f"wait_for_idle timed out after {timeout_ms}ms (last hash={last.get('hash') if last else None})"
                )
            await asyncio.sleep(interval_ms / 1000.0)


@mcp.tool()
async def wait_and_read(
    id: str,
    stable_ms: int = 600,
    timeout_ms: int = 30000,
    include_classes: list[str] | None = None,
    dedup: str = "content",
    view_only: bool = False,
    commit_window_ms: int = 400,
) -> dict[str, Any]:
    """Block until idle, then return the dedup-aware filtered delta in one tool call.

    ``view_only=True`` reads without mutating the master's tracker (for observers).
    ``commit_window_ms`` (default 400) drops still-mutating rows; 0 disables.
    """
    args = {
        "id": id,
        "stable_ms": stable_ms,
        "timeout_ms": timeout_ms,
        "include_classes": include_classes,
        "dedup": dedup,
        "view_only": view_only,
        "commit_window_ms": commit_window_ms,
    }
    with _logged(id, "wait_and_read", args) as box:
        _alive_or_exited(id)
        bridge = _ensure_bridge()
        allowed = _normalize_classes(include_classes)

        async def _do_wait_and_read() -> dict[str, Any]:
            deadline = _now_ms() + timeout_ms
            interval_ms = max(50, stable_ms // 6)
            history = _history.setdefault(id, [])
            snap: dict[str, Any] | None = None
            while True:
                snap = await bridge.call(
                    "snapshot", {"id": id, "mode": "visible", "includeCursor": True}
                )
                hash_history_push(history, snap)
                if is_idle(snap, history, stable_ms=stable_ms):
                    break
                if _now_ms() >= deadline:
                    raise TimeoutError(
                        f"wait_and_read timed out after {timeout_ms}ms (last hash={snap.get('hash') if snap else None})"
                    )
                await asyncio.sleep(interval_ms / 1000.0)

            # Reserve commit_window_ms + 100ms slack from the remaining budget;
            # skip the second-snapshot dance under tight timeouts.
            window_used = 0
            prior: dict[str, Any] | None = None
            if commit_window_ms > 0:
                budget_left = deadline - _now_ms()
                if budget_left >= commit_window_ms + 100:
                    prior_candidate = snap
                    await asyncio.sleep(commit_window_ms / 1000.0)
                    try:
                        snap = await bridge.call(
                            "snapshot", {"id": id, "mode": "visible", "includeCursor": True}
                        )
                        hash_history_push(history, snap)
                        prior = prior_candidate
                        window_used = commit_window_ms
                    except Exception as e:
                        log.warning("snap2 failed; degrading to single-snapshot", id=id, error=str(e))
                        prior = None
                        window_used = 0

            return _build_read_screen_payload(
                id,
                snap,
                mode="visible",
                since_hash=None,
                force_full=False,
                include_classes=allowed,
                dedup=dedup,
                view_only=view_only,
                prior_snapshot=prior,
                commit_window_ms=window_used,
            )

        if view_only:
            out = await _do_wait_and_read()
        else:
            async with _get_session_lock(id):
                out = await _do_wait_and_read()
        out["idle"] = True
        box["result"] = {
            "idle": True,
            "render_hash": out.get("render_hash"),
            "content_hash": out.get("content_hash"),
            "shape": "full" if "text" in out else ("unchanged" if out.get("unchanged") else "delta"),
            "delta_rows": len(out.get("changed_lines", [])) if "changed_lines" in out else 0,
        }
        return out


@mcp.tool()
async def wait_for(id: str, pattern: str, timeout_ms: int = 30000) -> dict[str, Any]:
    """Block until ``pattern`` (regex) matches the slave's screen.

    Returns the matched substring with a short surrounding context window
    (~80 chars on each side) plus hash/cursor metrics — NOT the full buffer.
    Call ``read_screen`` afterward if you need more; it will return a delta.
    """
    args = {"id": id, "pattern": pattern, "timeout_ms": timeout_ms}
    with _logged(id, "wait_for", args) as box:
        _alive_or_exited(id)
        bridge = _ensure_bridge()
        rx = re.compile(pattern, re.MULTILINE | re.DOTALL)
        deadline = _now_ms() + timeout_ms
        history = _history.setdefault(id, [])
        while True:
            snap: dict[str, Any] = await bridge.call(
                "snapshot", {"id": id, "mode": "visible", "includeCursor": True}
            )
            hash_history_push(history, snap)
            text = snap.get("text", "") or ""
            m = rx.search(text)
            if m:
                ctx_start = max(0, m.start() - 80)
                ctx_end = min(len(text), m.end() + 80)
                out = _trim_minimal(snap)
                out.update(compute_idle_metrics(snap))
                out["matched"] = True
                out["match"] = m.group(0)
                out["match_start"] = m.start()
                out["match_end"] = m.end()
                out["match_context"] = text[ctx_start:ctx_end]
                box["result"] = {"matched": True, "hash": snap.get("hash")}
                return out
            if _now_ms() >= deadline:
                raise TimeoutError(f"wait_for {pattern!r} timed out after {timeout_ms}ms")
            await asyncio.sleep(0.1)


@mcp.tool()
async def drain_events(
    owner: str,
    timeout_ms: int = 0,
    max_events: int = 64,
    sids: list[str] | None = None,
    types: list[str] | None = None,
) -> dict[str, Any]:
    """Multiplexed long-poll: drain the owner's event queue across all owned slaves.

    Replaces the per-slave blocking idiom (``wait_and_read``) with a fan-in
    receive: send work to many slaves, then call ``drain_events`` once and
    react to whichever ones produced output. This is the canonical event-loop
    driver for the master.

    Events pushed by the server (the master never re-receives content already
    delivered via this channel):

      - ``new_lines``     committed chat/menu/prompt rows ABOVE the slave's
                          cursor row, not previously emitted. The server
                          flushes at most once per ~1000ms while data is
                          flowing (throttle, not debounce — so the master
                          still sees progress during long streams). Adjacent
                          same-sid new_lines envelopes are coalesced by
                          drain_events into a single envelope per sid, so a
                          long-poll across a multi-second stream returns one
                          merged event, not one per flush. Updating rows (the
                          row the slave is actively writing, the input box,
                          status spinner, token counter) are excluded by
                          construction (cursor-row filter).
                          Payload: ``{sid, lines: [{row, text, class}], seq, ts}``.
      - ``prompt_visible`` the slave is awaiting input (low-latency, not
                          throttled). Payload: ``{sid, seq, ts}``.
      - ``exited``        the slave's PTY exited; subsequent ops on it will
                          raise. Payload: ``{sid, code, signal, seq, ts}``.

    Args:
      owner       owner string passed to ``open_session`` whose queue to drain.
      timeout_ms  0 → non-blocking peek; >0 → block until ≥1 event, up to that
                  long. Default 0.
      max_events  upper bound on raw matching events PULLED from the queue
                  per call (default 64). After coalescing, the returned
                  ``events`` list may be shorter than ``max_events`` (often
                  much shorter — a stream of N adjacent same-sid new_lines
                  events collapses into one envelope).
      sids        optional client-side sid filter; unmatched events stay queued.
      types       optional client-side type filter; unmatched events stay queued.

    Returns: ``{owner, events: [...], pending: <queue depth after this call>}``.
    """
    args = {"owner": owner, "timeout_ms": timeout_ms, "max_events": max_events,
            "sids": sids, "types": types}
    with _logged(None, "drain_events", args) as box:
        events, pending = _drain_once(owner, max_events=max_events,
                                      sids=sids, types=types)
        if not events and timeout_ms > 0:
            _, sig = _ensure_owner_queue(owner)
            deadline = _now_ms() + timeout_ms
            while True:
                sig.clear()
                # Re-check AFTER clearing: a producer could have set the signal
                # between our last pop and this clear; that push is already in
                # the queue and we'd find it here without waiting.
                events, pending = _drain_once(owner, max_events=max_events,
                                              sids=sids, types=types)
                if events:
                    break
                remaining = deadline - _now_ms()
                if remaining <= 0:
                    break
                try:
                    await asyncio.wait_for(sig.wait(), timeout=remaining / 1000.0)
                except asyncio.TimeoutError:
                    events, pending = _drain_once(owner, max_events=max_events,
                                                  sids=sids, types=types)
                    break

        result = {"owner": owner, "events": events, "pending": pending}
        box["result"] = {"owner": owner, "count": len(events), "pending": pending}
        return result


def _drain_once(
    owner: str,
    max_events: int = 64,
    sids: list[str] | None = None,
    types: list[str] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """Non-blocking single pass over the owner queue with coalesce.

    Shared by the ``drain_events`` MCP tool and the ``/api/drain`` REST route.
    Returns ``(events, pending_after)``. See ``drain_events`` docstring for
    the coalesce + max_events semantics.
    """
    q, _ = _ensure_owner_queue(owner)
    sid_filter = set(sids) if sids else None
    type_filter = set(types) if types else None
    out: list[dict[str, Any]] = []
    put_back: list[dict[str, Any]] = []
    pulled = 0
    while q and pulled < max_events:
        ev = q.popleft()
        if sid_filter is not None and ev.get("sid") not in sid_filter:
            put_back.append(ev)
            continue
        if type_filter is not None and ev.get("type") not in type_filter:
            put_back.append(ev)
            continue
        pulled += 1
        if (out
                and ev.get("type") == "new_lines"
                and out[-1].get("type") == "new_lines"
                and out[-1].get("sid") == ev.get("sid")):
            prev = out[-1]
            prev["lines"] = prev["lines"] + ev["lines"]
            prev["seq"] = ev["seq"]
            prev["ts"] = ev["ts"]
        else:
            out.append(ev)
    for ev in reversed(put_back):
        q.appendleft(ev)
    return out, len(q)


@mcp.custom_route("/api/drain", methods=["GET"])
async def http_drain(request: Request) -> Response:
    """Plain-HTTP non-blocking drain for shell hooks & external scripts.

    ``GET /api/drain?owner=NAME[&max_events=N][&sids=a,b][&types=x,y]``

    Returns JSON ``{"owner", "events": [...], "pending": int}``. No MCP
    protocol, no session handshake — single curl. Same coalesce/work-cap
    semantics as the ``drain_events`` MCP tool with ``timeout_ms=0``.
    """
    qp = request.query_params
    owner = qp.get("owner", "anonymous")
    try:
        max_events = int(qp.get("max_events", "64"))
    except ValueError:
        max_events = 64
    sids_s = qp.get("sids")
    types_s = qp.get("types")
    sids = [s.strip() for s in sids_s.split(",") if s.strip()] if sids_s else None
    types = [t.strip() for t in types_s.split(",") if t.strip()] if types_s else None
    events, pending = _drain_once(owner, max_events=max_events,
                                  sids=sids, types=types)
    return JSONResponse({"owner": owner, "events": events, "pending": pending})


@mcp.tool()
async def interrupt(id: str, force: bool = False) -> dict[str, Any]:
    """Send Ctrl-C to the slave; `force=True` runs the SIGINT/TERM/KILL ladder."""
    args = {"id": id, "force": force}
    with _logged(id, "interrupt", args) as box:
        _alive_or_exited(id)
        bridge = _ensure_bridge()
        kind = "ladder" if force else "ctrl-c"
        result = await bridge.call("signal", {"id": id, "kind": kind})
        out = {"ok": True, "kind": kind, "result": result}
        box["result"] = out
        return out


@mcp.tool()
async def resize_session(id: str, cols: int, rows: int) -> dict[str, Any]:
    """Resize the slave's PTY window."""
    args = {"id": id, "cols": cols, "rows": rows}
    with _logged(id, "resize_session", args) as box:
        spec = _alive_or_exited(id)
        if cols < 20 or cols > 1000 or rows < 5 or rows > 200:
            raise ValueError(f"unreasonable cols/rows: {cols}x{rows}")
        bridge = _ensure_bridge()
        result = await bridge.call("resize", {"id": id, "cols": cols, "rows": rows})
        spec.cols = cols
        spec.rows = rows
        out = {"ok": True, "cols": cols, "rows": rows, "result": result}
        box["result"] = out
        return out


@mcp.tool()
async def set_permission_mode(id: str, mode: str) -> dict[str, Any]:
    """Best-effort `/permissions <mode>` keystrokes; argv-time setting preferred."""
    args = {"id": id, "mode": mode}
    with _logged(id, "set_permission_mode", args) as box:
        if mode not in VALID_MODES:
            raise ValueError(f"mode must be one of {VALID_MODES}, got {mode!r}")
        _alive_or_exited(id)
        bridge = _ensure_bridge()
        items = [f"/permissions {mode}", "<Enter>"]
        result = await bridge.call(
            "write", {"id": id, "items": items, "bracketedPaste": False}
        )
        out = {
            "ok": True,
            "mode": mode,
            "note": "best-effort runtime change; argv-time set_permission_mode at open_session is preferred",
            "result": result,
        }
        box["result"] = out
        return out


@mcp.tool()
async def set_nested_puppetry(id: str, nested_puppetry: bool) -> dict[str, Any]:
    """Grant or revoke a slave's runtime ability to spawn sub-slaves.

    The slave's claude has the puppet MCP server loaded at startup regardless
    of this flag (the tools are always visible to the slave). The actual
    authorization is server-side: when the slave calls
    ``open_session(parent_id=<own-sid>)``, the puppet checks this flag on
    the parent and rejects the call if False. So flipping the flag takes
    effect on the very next sub-spawn attempt — no slave restart, no
    in-flight state lost.

    Use this when, mid-task, you (master) realize a slave's job is bigger
    than originally scoped and it should fan out to its own sub-slaves.
    Grant the capability, hand the slave a project brief (see
    SKILL.md "Pass context, don't make slaves re-explore"), and let it plan
    the fan-out.

    Permission monotonicity is still enforced at sub-spawn time
    (``plan ≤ strict ≤ acceptEdits ≤ yolo``) and depth cap (``max_depth``)
    is still enforced — this flag only controls the capability gate, not
    the safety rails.
    """
    args = {"id": id, "nested_puppetry": nested_puppetry}
    with _logged(id, "set_nested_puppetry", args) as box:
        spec = _registry.get(id)
        if spec is None:
            raise ValueError(f"unknown session: {id!r}")
        new_value = bool(nested_puppetry)
        spec.nested_puppetry = new_value
        try:
            db.set_nested_puppetry(id, new_value)
        except Exception as e:
            log.warning("db.set_nested_puppetry failed", id=id, error=str(e))
        out = {"ok": True, "id": id, "nested_puppetry": new_value}
        box["result"] = out
        return out


async def _bridge_sessions_by_id() -> dict[str, dict[str, Any]]:
    bridge = _ensure_bridge()
    try:
        bridge_info = await bridge.call("list_sessions", {})
    except Exception as e:
        log.warning("bridge list_sessions failed", error=str(e))
        bridge_info = []
    by_id: dict[str, dict[str, Any]] = {}
    if isinstance(bridge_info, list):
        for entry in bridge_info:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                by_id[entry["id"]] = entry
    elif isinstance(bridge_info, dict):
        inner = bridge_info.get("sessions")
        if isinstance(inner, list):
            for entry in inner:
                if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                    by_id[entry["id"]] = entry
    return by_id


@mcp.tool()
async def list_sessions(
    owner: str | None = None, status: str | None = None
) -> dict[str, Any]:
    """List sessions from the persistent DB, merged with live bridge state."""
    args: dict[str, Any] = {"owner": owner, "status": status}
    with _logged(None, "list_sessions", args) as box:
        bridge_by_id = await _bridge_sessions_by_id()
        try:
            rows = db.list_sessions(owner=owner, status=status)
        except Exception as e:
            log.warning("db.list_sessions failed", error=str(e))
            rows = []
        sessions: list[dict[str, Any]] = []
        for r in rows:
            sid = r["id"]
            b = bridge_by_id.get(sid, {})
            sessions.append(
                {
                    "id": sid,
                    "owner": r.get("owner"),
                    "status": r.get("status"),
                    "permission_mode": r.get("permission_mode"),
                    "cwd": r.get("cwd"),
                    "pid": r.get("pid") if r.get("pid") is not None else b.get("pid"),
                    "created_at_ms": r.get("created_at_ms"),
                    "closed_at_ms": r.get("closed_at_ms"),
                    "exit_code": r.get("exit_code"),
                    "exit_signal": r.get("exit_signal"),
                    "alive_in_bridge": sid in bridge_by_id and not b.get("exited"),
                    "parent_id": r.get("parent_id"),
                    "depth": int(r.get("depth") or 0),
                    "nested_puppetry": bool(r.get("nested_puppetry") or 0),
                }
            )
        out = {"sessions": sessions}
        box["result"] = {"count": len(sessions)}
        return out


@mcp.tool()
async def list_descendants(id: str) -> dict[str, Any]:
    """Return the subtree of sessions rooted at `id` (BFS, parents-before-children)."""
    args = {"id": id}
    with _logged(id, "list_descendants", args) as box:
        bridge_by_id = await _bridge_sessions_by_id()
        root = db.get_session(id)
        if root is None:
            raise ValueError(f"unknown session id: {id!r}")
        descendants = db.get_descendants(id)
        out_rows: list[dict[str, Any]] = []
        for r in descendants:
            sid = r["id"]
            b = bridge_by_id.get(sid, {})
            out_rows.append(
                {
                    "id": sid,
                    "owner": r.get("owner"),
                    "status": r.get("status"),
                    "permission_mode": r.get("permission_mode"),
                    "parent_id": r.get("parent_id"),
                    "depth": int(r.get("depth") or 0),
                    "nested_puppetry": bool(r.get("nested_puppetry") or 0),
                    "alive_in_bridge": sid in bridge_by_id and not b.get("exited"),
                }
            )
        out = {"root_id": id, "descendants": out_rows, "count": len(out_rows)}
        box["result"] = {"count": len(out_rows)}
        return out


@mcp.tool()
async def session_tree(root_id: str | None = None) -> dict[str, Any]:
    """All sessions as a nested tree of {id, owner, status, depth, nested_puppetry, alive_in_bridge, children}."""
    args = {"root_id": root_id}
    with _logged(root_id, "session_tree", args) as box:
        bridge_by_id = await _bridge_sessions_by_id()
        all_rows = db.list_sessions()
        by_parent: dict[str | None, list[dict[str, Any]]] = {}
        by_id: dict[str, dict[str, Any]] = {}
        for r in all_rows:
            by_parent.setdefault(r.get("parent_id"), []).append(r)
            by_id[r["id"]] = r

        def to_node(r: dict[str, Any]) -> dict[str, Any]:
            sid = r["id"]
            b = bridge_by_id.get(sid, {})
            kids = by_parent.get(sid, [])
            kids_sorted = sorted(kids, key=lambda x: int(x.get("created_at_ms") or 0))
            return {
                "id": sid,
                "owner": r.get("owner"),
                "status": r.get("status"),
                "permission_mode": r.get("permission_mode"),
                "depth": int(r.get("depth") or 0),
                "nested_puppetry": bool(r.get("nested_puppetry") or 0),
                "alive_in_bridge": sid in bridge_by_id and not b.get("exited"),
                "children": [to_node(k) for k in kids_sorted],
            }

        def _count_nodes(nodes: list[dict[str, Any]]) -> int:
            n = 0
            for node in nodes:
                n += 1
                n += _count_nodes(node.get("children", []))
            return n

        if root_id is not None:
            row = by_id.get(root_id)
            if row is None:
                raise ValueError(f"unknown session id: {root_id!r}")
            tree = [to_node(row)]
            count = _count_nodes(tree)
        else:
            roots = sorted(
                by_parent.get(None, []),
                key=lambda x: int(x.get("created_at_ms") or 0),
            )
            tree = [to_node(r) for r in roots]
            count = len(all_rows)
        out = {"tree": tree, "count": count}
        box["result"] = {"roots": len(tree), "total": len(all_rows)}
        return out


@mcp.tool()
async def resume_session(id: str, owner: str | None = None) -> dict[str, Any]:
    """Reconnect to a session from the DB; re-registers in-memory if alive in bridge."""
    args = {"id": id, "owner": owner}
    with _logged(id, "resume_session", args) as box:
        row = db.get_session(id)
        if row is None:
            raise ValueError(f"unknown session id: {id!r}")
        bridge_by_id = await _bridge_sessions_by_id()
        b = bridge_by_id.get(id, {})
        alive = id in bridge_by_id and not b.get("exited")
        if alive and _registry.get(id) is None:
            try:
                _registry.register(spec_from_db_row(row))
                _history.setdefault(id, [])
            except Exception as e:
                log.warning("registry re-register failed", id=id, error=str(e))
        if owner is not None:
            try:
                with db._conn() as c:  # type: ignore[attr-defined]
                    c.execute("UPDATE sessions SET owner=? WHERE id=?", (owner, id))
                    c.commit()
                row["owner"] = owner
            except Exception as e:
                log.warning("db owner update failed", id=id, error=str(e))
        out: dict[str, Any] = {
            "id": id,
            "owner": row.get("owner"),
            "permission_mode": row.get("permission_mode"),
            "cwd": row.get("cwd"),
            "home": row.get("home"),
            "transcript_dir": row.get("transcript_dir"),
            "cols": row.get("cols"),
            "rows": row.get("rows"),
            "created_at_ms": row.get("created_at_ms"),
            "alive_in_bridge": alive,
            "status": row.get("status"),
            "parent_id": row.get("parent_id"),
            "depth": int(row.get("depth") or 0),
            "nested_puppetry": bool(row.get("nested_puppetry") or 0),
        }
        if not alive and row.get("status") != "alive":
            out["note"] = "session crashed, transcript still readable via read_log"
        box["result"] = {"alive_in_bridge": alive, "status": row.get("status")}
        return out


@mcp.tool()
async def read_log(
    id: str, since_offset: int | None = None, max_bytes: int = 65536
) -> dict[str, Any]:
    """Read frames from the slave's transcript.jsonl starting at `since_offset`."""
    args = {"id": id, "since_offset": since_offset, "max_bytes": max_bytes}
    with _logged(id, "read_log", args) as box:
        if since_offset is not None and since_offset < 0:
            raise ValueError(f"since_offset must be >= 0, got {since_offset}")
        if max_bytes <= 0:
            raise ValueError(f"max_bytes must be > 0, got {max_bytes}")
        spec = _registry_or_404(id)
        path = Path(spec.transcript_dir) / "transcript.jsonl"
        frames: list[Any] = []
        next_offset = since_offset or 0
        if not path.exists():
            out = {"frames": frames, "next_offset": next_offset}
            box["result"] = {"frames": 0, "next_offset": next_offset}
            return out
        start = since_offset or 0
        with path.open("rb") as f:
            f.seek(start)
            data = f.read(max_bytes)
            consumed_end = start + len(data)
        last_nl = data.rfind(b"\n")
        if last_nl == -1:
            usable = b""
            next_offset = start
        else:
            usable = data[: last_nl + 1]
            next_offset = start + last_nl + 1
        for line in usable.splitlines():
            if not line.strip():
                continue
            try:
                frames.append(json.loads(line.decode("utf-8")))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
        out = {"frames": frames, "next_offset": next_offset, "eof_offset": consumed_end}
        box["result"] = {"frames": len(frames), "next_offset": next_offset}
        return out


@mcp.tool()
async def close_session(id: str) -> dict[str, Any]:
    """Close the slave and remove all per-session state."""
    args = {"id": id}
    with _logged(id, "close_session", args) as box:
        _registry_or_404(id)
        bridge = _ensure_bridge()
        try:
            result = await bridge.call("close", {"id": id})
        finally:
            _registry.remove(id)
            _history.pop(id, None)
            _last_data_ts.pop(id, None)
            _last_prompt_ts.pop(id, None)
            _exited.pop(id, None)
            _master_last_hash.pop(id, None)
            _master_last_text.pop(id, None)
            _master_last_render_hash.pop(id, None)
            _master_last_content_hash.pop(id, None)
            _session_locks.pop(id, None)
            _owner_by_sid.pop(id, None)
            timer = _commit_timer.pop(id, None)
            if timer is not None:
                timer.cancel()
            _event_emitted.pop(id, None)
            try:
                db.mark_closed(id, code=None, signal="user_close", ts_ms=_now_ms())
            except Exception as e:
                log.warning("db.mark_closed on close failed", id=id, error=str(e))
        out = {"ok": True, "result": result}
        box["result"] = out
        return out
