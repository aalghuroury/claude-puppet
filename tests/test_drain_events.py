"""Tests for the push-and-drain (multiplexed long-poll) event-queue API.

These exercise the new `drain_events` MCP tool and the commit-debounce
watcher (`_emit_commit`) that feeds it. The tests stub the Bridge with a
canned snapshot so they run pure-Python without a Node bridge subprocess.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from server import mcp_server as ms
from server.classify import RowClass


class _StubBridge:
    """Minimal Bridge stub: `call("snapshot", ...)` returns a canned dict."""

    def __init__(self, snapshot: dict[str, Any]) -> None:
        self._snap = snapshot

    async def call(self, op: str, args: dict[str, Any], *, timeout: float | None = None) -> Any:
        assert op == "snapshot"
        return self._snap


def _reset_session(sid: str, owner: str = "test-owner") -> None:
    """Wipe per-session/per-owner watcher state to a clean slate."""
    ms._owner_by_sid.pop(sid, None)
    ms._event_emitted.pop(sid, None)
    ms._exited.pop(sid, None)
    ms._commit_timer.pop(sid, None)
    ms._event_queue.pop(owner, None)
    ms._event_signal.pop(owner, None)
    from server.sessions import SessionSpec
    spec = SessionSpec(
        id=sid, cwd="/tmp", permission_mode="strict",
        allowed_tools=None, env={}, cols=80, rows=24,
        home="/tmp/fake", transcript_dir="/tmp/fake",
        cmd="/bin/bash", cmd_args=[],
    )
    ms._registry.register(spec)
    ms._owner_by_sid[sid] = owner
    ms._ensure_owner_queue(owner)


def _teardown_session(sid: str, owner: str = "test-owner") -> None:
    ms._registry.remove(sid)
    ms._owner_by_sid.pop(sid, None)
    ms._event_emitted.pop(sid, None)
    ms._event_queue.pop(owner, None)
    ms._event_signal.pop(owner, None)
    ms._commit_timer.pop(sid, None)
    ms._exited.pop(sid, None)


@pytest.mark.asyncio
async def test_emit_commit_only_emits_rows_above_cursor() -> None:
    """The cursor row is the slave's write head; rows at or below it are mutating
    by construction (streaming partial, input box, status spinner) and MUST NOT
    be emitted."""
    sid = "emit-above-cursor"
    owner = "test-owner"
    _reset_session(sid, owner)
    try:
        # Cursor at row 5 → only rows 0..4 are emittable. Row 5 is "Streaming…"
        # which is still being written; row 6 below is the input box; row 7 is
        # a status spinner.
        text = "\n".join([
            "first chat line",      # 0  emit
            "second chat line",     # 1  emit
            "third chat line",      # 2  emit
            "fourth chat line",     # 3  emit
            "fifth chat line",      # 4  emit
            "Streaming partial...", # 5  cursor row — DO NOT emit
            "❯ ",                   # 6  prompt — below cursor, DO NOT emit
            "✶ Razzmatazzing… (5s · ↓ 1.2k tokens · esc to interrupt)",  # 7 STATUS
        ])
        snap = {"hash": "h1", "text": text, "cursor": {"row": 5, "col": 20},
                "alt": False, "rows": 24, "cols": 80,
                "idleSinceMs": 0, "lastPromptAtMs": None}
        ms._bridge = _StubBridge(snap)
        await ms._emit_commit(sid)
        q = ms._event_queue[owner]
        assert len(q) == 1
        ev = q[0]
        assert ev["type"] == "new_lines"
        assert ev["sid"] == sid
        texts = [ln["text"] for ln in ev["lines"]]
        assert texts == ["first chat line", "second chat line", "third chat line",
                         "fourth chat line", "fifth chat line"]
        # Streaming partial must not leak — it's the row the cursor is on.
        assert "Streaming partial..." not in texts
        # Prompt below cursor stays out.
        assert all("❯" not in t for t in texts)
        # Status row stays out.
        assert all("Razzmatazzing" not in t for t in texts)
    finally:
        _teardown_session(sid, owner)
        ms._bridge = None


@pytest.mark.asyncio
async def test_emit_commit_filters_input_box_echo() -> None:
    """A row matching `^\\s*❯\\s+<non-digit>` is the slave's input box echo of
    a prompt the master just typed. Even if it's ABOVE the cursor (because
    cursor briefly moved elsewhere while the box still held the text), it
    must NOT be emitted — the master already has it in conversation history.

    The same regex MUST NOT swallow menu items like `❯ 1. Yes` (those are
    legitimate MENU-class signals the master should see)."""
    sid = "emit-input-echo"
    owner = "test-owner"
    _reset_session(sid, owner)
    try:
        # Cursor at row 5. Above the cursor:
        #   row 0: chat content      → emit
        #   row 1: input-box echo    → MUST NOT emit
        #   row 2: menu item         → emit (different shape: `❯ N.`)
        #   row 3: unhighlighted menu → emit
        #   row 4: another chat      → emit
        text = "\n".join([
            "first response from claude",                  # 0  emit
            "❯ tell me a joke about pineapples  ",          # 1  input echo — DROP
            "❯ 1. Option A",                                # 2  emit (menu)
            "  2. Option B",                                # 3  emit (menu)
            "another chat-level line",                      # 4  emit
            "CURSOR HERE",                                  # 5  cursor row — break
            "(input row below cursor)",                     # 6  below cursor — skipped
        ])
        snap = {"hash": "h1", "text": text, "cursor": {"row": 5, "col": 0},
                "alt": False, "rows": 24, "cols": 80,
                "idleSinceMs": 0, "lastPromptAtMs": None}
        ms._bridge = _StubBridge(snap)
        await ms._emit_commit(sid)

        q = ms._event_queue[owner]
        assert len(q) == 1
        texts = [ln["text"] for ln in q[0]["lines"]]
        assert "first response from claude" in texts
        assert "❯ 1. Option A" in texts
        assert "  2. Option B" in texts
        assert "another chat-level line" in texts
        # The input-box echo must be filtered out completely.
        for t in texts:
            assert not t.startswith("❯ tell me"), f"input echo leaked: {t!r}"
    finally:
        _teardown_session(sid, owner)
        ms._bridge = None


@pytest.mark.asyncio
async def test_emit_commit_skips_when_cursor_at_top() -> None:
    """If the cursor row is 0 (or missing), nothing is definitely 'above the
    cursor' — emit nothing this tick. The slave is still warming up."""
    sid = "emit-no-cursor"
    owner = "test-owner"
    _reset_session(sid, owner)
    try:
        snap = {"hash": "h1", "text": "row0\nrow1\nrow2",
                "cursor": {"row": 0, "col": 0},
                "alt": False, "rows": 24, "cols": 80,
                "idleSinceMs": 0, "lastPromptAtMs": None}
        ms._bridge = _StubBridge(snap)
        await ms._emit_commit(sid)
        assert len(ms._event_queue[owner]) == 0
    finally:
        _teardown_session(sid, owner)
        ms._bridge = None


@pytest.mark.asyncio
async def test_emit_commit_does_not_reemit_same_text() -> None:
    """A line whose exact text was emitted in a prior commit-tick must never
    be emitted again — even if it reappears after scroll."""
    sid = "emit-dedup"
    owner = "test-owner"
    _reset_session(sid, owner)
    try:
        text1 = "alpha\nbeta\nCURSOR HERE"  # cursor row 2 → emit alpha, beta
        snap1 = {"hash": "h1", "text": text1, "cursor": {"row": 2, "col": 0},
                 "alt": False, "rows": 24, "cols": 80,
                 "idleSinceMs": 0, "lastPromptAtMs": None}
        ms._bridge = _StubBridge(snap1)
        await ms._emit_commit(sid)
        assert len(ms._event_queue[owner]) == 1
        assert [l["text"] for l in ms._event_queue[owner][0]["lines"]] == ["alpha", "beta"]

        # Second tick: alpha/beta still on screen, plus a new gamma line above cursor.
        text2 = "alpha\nbeta\ngamma\nCURSOR HERE"  # cursor row 3 → emit fresh only
        snap2 = {"hash": "h2", "text": text2, "cursor": {"row": 3, "col": 0},
                 "alt": False, "rows": 24, "cols": 80,
                 "idleSinceMs": 0, "lastPromptAtMs": None}
        ms._bridge = _StubBridge(snap2)
        await ms._emit_commit(sid)
        assert len(ms._event_queue[owner]) == 2
        assert [l["text"] for l in ms._event_queue[owner][1]["lines"]] == ["gamma"]
    finally:
        _teardown_session(sid, owner)
        ms._bridge = None


@pytest.mark.asyncio
async def test_emit_commit_no_event_when_no_fresh_content() -> None:
    """If a commit-tick finds no above-cursor classified-as-content lines that
    haven't already been emitted, NO event is pushed (queue stays empty).
    This is critical for the token-economy promise: spinner-only repaints
    don't trigger drain wakeups."""
    sid = "emit-no-fresh"
    owner = "test-owner"
    _reset_session(sid, owner)
    try:
        # First tick seeds the emitted set with "alpha".
        text1 = "alpha\nCURSOR"
        snap1 = {"hash": "h1", "text": text1, "cursor": {"row": 1, "col": 0},
                 "alt": False, "rows": 24, "cols": 80,
                 "idleSinceMs": 0, "lastPromptAtMs": None}
        ms._bridge = _StubBridge(snap1)
        await ms._emit_commit(sid)
        assert len(ms._event_queue[owner]) == 1

        # Second tick: same alpha + a STATUS-class spinner. Nothing fresh-and-emittable.
        text2 = "alpha\nCURSOR\n✶ Razzmatazzing… (7s)"
        snap2 = {"hash": "h2", "text": text2, "cursor": {"row": 1, "col": 0},
                 "alt": False, "rows": 24, "cols": 80,
                 "idleSinceMs": 0, "lastPromptAtMs": None}
        ms._bridge = _StubBridge(snap2)
        await ms._emit_commit(sid)
        assert len(ms._event_queue[owner]) == 1  # no new event pushed
    finally:
        _teardown_session(sid, owner)
        ms._bridge = None


@pytest.mark.asyncio
async def test_drain_events_non_blocking_returns_pending() -> None:
    """timeout_ms=0 returns whatever's queued, even an empty list. Adjacent
    same-sid new_lines envelopes are coalesced into one on return."""
    sid = "drain-nonblock"
    owner = "test-owner"
    _reset_session(sid, owner)
    try:
        # Empty queue.
        out = await ms.drain_events(owner=owner, timeout_ms=0)
        assert out["events"] == []
        assert out["pending"] == 0

        # Push two events directly — both same-sid new_lines → coalesce.
        ms._push_event(sid, {"seq": 1, "ts": 0, "type": "new_lines",
                             "sid": sid, "lines": [{"row": 0, "text": "a", "class": "chat"}]})
        ms._push_event(sid, {"seq": 2, "ts": 0, "type": "new_lines",
                             "sid": sid, "lines": [{"row": 1, "text": "b", "class": "chat"}]})
        out = await ms.drain_events(owner=owner, timeout_ms=0)
        assert len(out["events"]) == 1
        assert out["events"][0]["sid"] == sid
        assert [ln["text"] for ln in out["events"][0]["lines"]] == ["a", "b"]
        assert out["events"][0]["seq"] == 2  # later seq wins
        assert out["pending"] == 0
    finally:
        _teardown_session(sid, owner)


@pytest.mark.asyncio
async def test_drain_events_long_poll_wakes_on_push() -> None:
    """timeout_ms>0 blocks until a producer pushes an event."""
    sid = "drain-longpoll"
    owner = "test-owner"
    _reset_session(sid, owner)
    try:
        async def producer() -> None:
            await asyncio.sleep(0.05)
            ms._push_event(sid, {"seq": 1, "ts": 0, "type": "new_lines",
                                 "sid": sid, "lines": [{"row": 0, "text": "x", "class": "chat"}]})

        task = asyncio.create_task(producer())
        out = await ms.drain_events(owner=owner, timeout_ms=2000)
        await task
        assert len(out["events"]) == 1
        assert out["events"][0]["lines"][0]["text"] == "x"
    finally:
        _teardown_session(sid, owner)


@pytest.mark.asyncio
async def test_drain_events_long_poll_returns_empty_on_timeout() -> None:
    """timeout_ms>0 with no pushers returns empty events at deadline."""
    sid = "drain-timeout"
    owner = "test-owner"
    _reset_session(sid, owner)
    try:
        out = await ms.drain_events(owner=owner, timeout_ms=100)
        assert out["events"] == []
        assert out["pending"] == 0
    finally:
        _teardown_session(sid, owner)


@pytest.mark.asyncio
async def test_drain_events_sid_filter_keeps_unmatched_queued() -> None:
    """sids filter consumes matching events, leaves others queued in order.

    After filtering, the surviving events are adjacent in `out` even if they
    were interleaved with other-sid events in the original queue, so the
    matching same-sid new_lines coalesce into one envelope."""
    owner = "test-owner"
    _reset_session("a", owner)
    _reset_session("b", owner)
    try:
        for sid, text in [("a", "a1"), ("b", "b1"), ("a", "a2"), ("b", "b2")]:
            ms._push_event(sid, {"seq": next(ms._event_seq), "ts": 0,
                                 "type": "new_lines", "sid": sid,
                                 "lines": [{"row": 0, "text": text, "class": "chat"}]})
        out = await ms.drain_events(owner=owner, timeout_ms=0, sids=["a"])
        assert len(out["events"]) == 1
        assert out["events"][0]["sid"] == "a"
        assert [ln["text"] for ln in out["events"][0]["lines"]] == ["a1", "a2"]
        assert out["pending"] == 2  # the two "b" events stayed queued

        out2 = await ms.drain_events(owner=owner, timeout_ms=0, sids=["b"])
        assert len(out2["events"]) == 1
        assert out2["events"][0]["sid"] == "b"
        assert [ln["text"] for ln in out2["events"][0]["lines"]] == ["b1", "b2"]
        assert out2["pending"] == 0
    finally:
        _teardown_session("a", owner)
        _teardown_session("b", owner)


@pytest.mark.asyncio
async def test_drain_events_type_filter() -> None:
    """types filter consumes matching event types only."""
    sid = "drain-types"
    owner = "test-owner"
    _reset_session(sid, owner)
    try:
        ms._push_event(sid, {"seq": 1, "ts": 0, "type": "new_lines",
                             "sid": sid, "lines": []})
        ms._push_event(sid, {"seq": 2, "ts": 0, "type": "prompt_visible", "sid": sid})
        ms._push_event(sid, {"seq": 3, "ts": 0, "type": "exited",
                             "sid": sid, "code": 0, "signal": None})
        out = await ms.drain_events(owner=owner, timeout_ms=0,
                                       types=["prompt_visible", "exited"])
        assert [e["type"] for e in out["events"]] == ["prompt_visible", "exited"]
        assert out["pending"] == 1
    finally:
        _teardown_session(sid, owner)


@pytest.mark.asyncio
async def test_drain_events_max_events_caps_per_call() -> None:
    """max_events caps the number of MATCHING events PULLED from the queue
    (work cap), not the number of returned envelopes. With coalescing, 3
    pulled same-sid new_lines events collapse into 1 returned envelope; the
    remaining 7 stay queued for the next call."""
    sid = "drain-cap"
    owner = "test-owner"
    _reset_session(sid, owner)
    try:
        for i in range(10):
            ms._push_event(sid, {"seq": i, "ts": 0, "type": "new_lines",
                                 "sid": sid, "lines": [{"row": 0, "text": f"l{i}", "class": "chat"}]})
        out = await ms.drain_events(owner=owner, timeout_ms=0, max_events=3)
        assert len(out["events"]) == 1
        assert [ln["text"] for ln in out["events"][0]["lines"]] == ["l0", "l1", "l2"]
        assert out["pending"] == 7
    finally:
        _teardown_session(sid, owner)


def test_push_event_drops_unowned_sids() -> None:
    """Pushing an event for an sid with no registered owner is a no-op (no crash,
    no orphan queue created)."""
    # Make sure there's no stale state from a prior test.
    sid = "no-owner"
    ms._owner_by_sid.pop(sid, None)
    before_queues = set(ms._event_queue.keys())
    ms._push_event(sid, {"seq": 1, "ts": 0, "type": "new_lines",
                         "sid": sid, "lines": []})
    after_queues = set(ms._event_queue.keys())
    assert before_queues == after_queues
