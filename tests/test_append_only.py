"""Unit tests for append-only / committed-row semantics in mcp_server."""

from __future__ import annotations

import asyncio
from typing import Any

from server import mcp_server as ms
from server.classify import RowClass
from server.mcp_server import (
    _build_read_screen_payload,
    _committed_rows,
    _committed_rows_v2,
)


def _clear(sid: str) -> None:
    for d in (
        ms._master_last_render_hash,
        ms._master_last_content_hash,
        ms._master_last_hash,
        ms._master_last_text,
    ):
        d.pop(sid, None)


def test_committed_rows_all_stable() -> None:
    prev = "alpha\nbeta\ngamma"
    curr = "alpha\nbeta\ngamma"
    assert _committed_rows(prev, curr) == ["alpha", "beta", "gamma"]


def test_committed_rows_one_in_flight() -> None:
    prev = "alpha\nbeta\nHello, w"
    curr = "alpha\nbeta\nHello, world!"
    out = _committed_rows(prev, curr)
    assert out == ["alpha", "beta", None]


def test_committed_rows_handles_length_growth() -> None:
    prev = "alpha\nbeta"
    curr = "alpha\nbeta\ngamma\ndelta"
    out = _committed_rows(prev, curr)
    # First two stable, last two are new (no prior row -> None / in-flight).
    assert out == ["alpha", "beta", None, None]


def test_committed_rows_handles_length_shrink() -> None:
    prev = "alpha\nbeta\ngamma\ndelta"
    curr = "alpha\nbeta"
    out = _committed_rows(prev, curr)
    # Result is aligned to curr length.
    assert out == ["alpha", "beta"]
    assert len(out) == len(curr.split("\n"))


def test_payload_with_prior_snapshot_drops_in_flight() -> None:
    sid = "append-only-test-1"
    _clear(sid)
    allowed = (RowClass.CHAT, RowClass.MENU, RowClass.PROMPT)

    prior = {"hash": "h_prior", "text": "alpha\nbeta\nHello, w"}
    curr = {
        "hash": "h_curr",
        "text": "alpha\nbeta\nHello, world!",
        "cursor": {"row": 0, "col": 0},
        "alt": False,
        "rows": 24,
        "cols": 80,
    }

    out = _build_read_screen_payload(
        sid,
        curr,
        mode="visible",
        since_hash=None,
        force_full=False,
        include_classes=allowed,
        dedup="content",
        prior_snapshot=prior,
        commit_window_ms=400,
    )
    # In-flight row 2 should have been dropped (replaced with empty since no
    # prior master text). It must NOT appear among the changed rows.
    if "changed_lines" in out:
        texts = [r["text"] for r in out["changed_lines"]]
        assert "Hello, world!" not in texts
    assert out.get("in_flight_rows", 0) >= 1
    assert out.get("commit_window_ms_used") == 400
    _clear(sid)


def test_payload_without_prior_snapshot_unchanged_path() -> None:
    sid = "append-only-test-2"
    _clear(sid)
    allowed = (RowClass.CHAT, RowClass.MENU, RowClass.PROMPT)

    snap = {
        "hash": "h1",
        "text": "alpha\nbeta\ngamma",
        "cursor": {"row": 0, "col": 0},
        "alt": False,
        "rows": 24,
        "cols": 80,
    }

    out = _build_read_screen_payload(
        sid,
        snap,
        mode="visible",
        since_hash=None,
        force_full=False,
        include_classes=allowed,
        dedup="content",
    )
    # Backward-compat: no prior_snapshot, no in_flight_rows / commit_window_ms_used keys.
    assert "in_flight_rows" not in out
    assert "commit_window_ms_used" not in out
    assert out.get("full") is True
    assert out.get("text") == "alpha\nbeta\ngamma"
    _clear(sid)


def test_appended_committed_row_emits_once() -> None:
    sid = "append-only-test-3"
    _clear(sid)
    allowed = (RowClass.CHAT, RowClass.MENU, RowClass.PROMPT)

    # Master's prior view ends at row 1.
    ms._master_last_text[sid] = "alpha\nbeta"
    ms._master_last_render_hash[sid] = "old_render"
    ms._master_last_content_hash[sid] = ms._content_hash("alpha\nbeta")
    ms._master_last_hash[sid] = "old_render"

    # First read: row 2 still in flight ("Hello, w" -> "Hello, world!").
    prior_a = {"hash": "ra1", "text": "alpha\nbeta\nHello, w"}
    curr_a = {
        "hash": "ra2",
        "text": "alpha\nbeta\nHello, world!",
        "cursor": {"row": 0, "col": 0},
        "alt": False,
        "rows": 24,
        "cols": 80,
    }
    out_a = _build_read_screen_payload(
        sid,
        curr_a,
        mode="visible",
        since_hash=None,
        force_full=False,
        include_classes=allowed,
        dedup="content",
        prior_snapshot=prior_a,
        commit_window_ms=400,
    )
    a_texts = [r["text"] for r in out_a.get("changed_lines", [])]
    # Should not have surfaced the in-flight row.
    assert "Hello, world!" not in a_texts
    assert out_a.get("in_flight_rows", 0) >= 1

    # Second read: row 2 has now committed (stable across both snaps).
    prior_b = {"hash": "rb1", "text": "alpha\nbeta\nHello, world!"}
    curr_b = {
        "hash": "rb2",
        "text": "alpha\nbeta\nHello, world!",
        "cursor": {"row": 0, "col": 0},
        "alt": False,
        "rows": 24,
        "cols": 80,
    }
    out_b = _build_read_screen_payload(
        sid,
        curr_b,
        mode="visible",
        since_hash=None,
        force_full=False,
        include_classes=allowed,
        dedup="content",
        prior_snapshot=prior_b,
        commit_window_ms=400,
    )
    b_texts = [r["text"] for r in out_b.get("changed_lines", [])]
    assert "Hello, world!" in b_texts

    # Third read: same committed state, same master baseline -> should be unchanged.
    prior_c = {"hash": "rc1", "text": "alpha\nbeta\nHello, world!"}
    curr_c = {
        "hash": "rc2",
        "text": "alpha\nbeta\nHello, world!",
        "cursor": {"row": 0, "col": 0},
        "alt": False,
        "rows": 24,
        "cols": 80,
    }
    out_c = _build_read_screen_payload(
        sid,
        curr_c,
        mode="visible",
        since_hash=None,
        force_full=False,
        include_classes=allowed,
        dedup="content",
        prior_snapshot=prior_c,
        commit_window_ms=400,
    )
    assert out_c.get("unchanged") is True
    _clear(sid)


def test_committed_rows_v2_handles_scroll() -> None:
    # Buffer scrolled up by one line: a→b at row 0, etc. v1 would falsely flag
    # every row as in-flight; v2 commits everything that exists in prev_set.
    prev = "a\nb\nc\nd"
    curr = "b\nc\nd\ne"
    assert _committed_rows_v2(prev, curr) == ["b", "c", "d", None]
    # Sanity: index-based v1 disagrees on at least one row.
    assert _committed_rows(prev, curr) != ["b", "c", "d", None]


def test_committed_rows_v2_blank_rows_always_committed() -> None:
    prev = "x\ny"
    curr = "\n\n\n"
    # Three blank rows + one trailing blank row are all trivially committed.
    out = _committed_rows_v2(prev, curr)
    assert all(c == "" for c in out)


def test_committed_rows_v2_handles_full_repaint() -> None:
    # Reordered after a resize/repaint — all rows present in prev_set.
    prev = "x\ny\nz"
    curr = "z\ny\nx"
    assert _committed_rows_v2(prev, curr) == ["z", "y", "x"]


def test_first_read_masks_in_flight_when_prior_provided() -> None:
    sid = "first-read-masking"
    _clear(sid)
    allowed = (RowClass.CHAT, RowClass.MENU, RowClass.PROMPT)

    prior = {"hash": "p1", "text": "row0\nrow1\nrow2-par"}
    curr = {
        "hash": "p2",
        "text": "row0\nrow1\nrow2-partial-mid-stream",
        "cursor": {"row": 0, "col": 0},
        "alt": False,
        "rows": 24,
        "cols": 80,
    }

    out = _build_read_screen_payload(
        sid,
        curr,
        mode="visible",
        since_hash=None,
        force_full=True,
        include_classes=allowed,
        dedup="content",
        prior_snapshot=prior,
        commit_window_ms=400,
    )
    assert out.get("full") is True
    assert "row2-partial-mid-stream" not in out["text"]
    # Row count preserved; in-flight row replaced with "".
    assert out["text"].split("\n") == ["row0", "row1", ""]
    assert out.get("in_flight_rows", 0) >= 1
    _clear(sid)


def test_first_read_without_prior_unchanged_path() -> None:
    sid = "first-read-no-prior"
    _clear(sid)
    allowed = (RowClass.CHAT, RowClass.MENU, RowClass.PROMPT)

    snap = {
        "hash": "h1",
        "text": "alpha\nbeta\ngamma",
        "cursor": {"row": 0, "col": 0},
        "alt": False,
        "rows": 24,
        "cols": 80,
    }

    out = _build_read_screen_payload(
        sid,
        snap,
        mode="visible",
        since_hash=None,
        force_full=False,
        include_classes=allowed,
        dedup="content",
    )
    assert out.get("full") is True
    assert out.get("text") == "alpha\nbeta\ngamma"
    assert "in_flight_rows" not in out
    _clear(sid)


class _StubBridge:
    """Deterministic in-memory stub for Bridge.call().

    `snapshots` is a list of dicts returned by successive calls to op="snapshot".
    `snap_delay_s` lets a test inject artificial latency between snap1/snap2 to
    expose tracker races. `raise_on_call_index` raises BridgeError on the Nth
    snapshot call (0-indexed) — used to stress snap2-failure handling.
    """

    def __init__(
        self,
        snapshots: list[dict[str, Any]],
        *,
        snap_delay_s: float = 0.0,
        raise_on_call_index: int | None = None,
    ) -> None:
        self.snapshots = snapshots
        self.calls = 0
        self.snap_delay_s = snap_delay_s
        self.raise_on_call_index = raise_on_call_index

    async def call(self, op: str, args: dict[str, Any]) -> Any:
        if op == "snapshot":
            idx = self.calls
            self.calls += 1
            if self.raise_on_call_index is not None and idx == self.raise_on_call_index:
                raise RuntimeError("simulated bridge failure")
            if self.snap_delay_s:
                await asyncio.sleep(self.snap_delay_s)
            return self.snapshots[min(idx, len(self.snapshots) - 1)]
        return {}

    def add_event_handler(self, _h: Any) -> None:
        pass


def _register_stub(sid: str) -> None:
    """Minimal registry entry so _registry_or_404 succeeds in tests."""
    from server.sessions import SessionSpec

    spec = SessionSpec(
        id=sid,
        cwd="/tmp",
        permission_mode="strict",
        allowed_tools=None,
        env={},
        cols=80,
        rows=24,
        home="/tmp",  # type: ignore[arg-type]
        transcript_dir="/tmp",  # type: ignore[arg-type]
        cmd="echo",
        cmd_args=[],
    )
    ms._registry.register(spec)


def test_session_lock_serializes_concurrent_reads() -> None:
    sid = "lock-test"
    _clear(sid)
    ms._session_locks.pop(sid, None)
    _register_stub(sid)

    # Two distinct snapshots; reads will compete to write trackers.
    snaps = [
        {
            "hash": "hA1", "text": "A-line1\nA-line2",
            "cursor": {"row": 0, "col": 0}, "alt": False, "rows": 24, "cols": 80,
        },
        {
            "hash": "hA2", "text": "A-line1\nA-line2",
            "cursor": {"row": 0, "col": 0}, "alt": False, "rows": 24, "cols": 80,
        },
        {
            "hash": "hB1", "text": "B-line1\nB-line2",
            "cursor": {"row": 0, "col": 0}, "alt": False, "rows": 24, "cols": 80,
        },
        {
            "hash": "hB2", "text": "B-line1\nB-line2",
            "cursor": {"row": 0, "col": 0}, "alt": False, "rows": 24, "cols": 80,
        },
    ]
    prev_bridge = ms._bridge
    stub = _StubBridge(snaps, snap_delay_s=0.05)
    ms._bridge = stub  # type: ignore[assignment]
    try:
        async def _runner() -> None:
            await asyncio.gather(
                ms.read_screen(id=sid, commit_window_ms=10),
                ms.read_screen(id=sid, commit_window_ms=10),
            )

        asyncio.run(_runner())

        # All four trackers must agree on the *same* call's render hash.
        rh = ms._master_last_render_hash[sid]
        assert ms._master_last_hash[sid] == rh
        # Content hash matches what _content_hash would compute over the stored text.
        assert ms._master_last_content_hash[sid] == ms._content_hash(
            ms._master_last_text[sid]
        )
        # Render hash must be one of the snap2 hashes (hA2 or hB2).
        assert rh in ("hA2", "hB2")
    finally:
        ms._bridge = prev_bridge
        ms._registry.remove(sid)
        ms._session_locks.pop(sid, None)
        _clear(sid)


def test_snap2_failure_falls_back_to_single_snapshot() -> None:
    sid = "snap2-fail-test"
    _clear(sid)
    ms._session_locks.pop(sid, None)
    _register_stub(sid)

    snaps = [
        {
            "hash": "h1", "text": "only\nsnap1",
            "cursor": {"row": 0, "col": 0}, "alt": False, "rows": 24, "cols": 80,
        },
    ]
    prev_bridge = ms._bridge
    stub = _StubBridge(snaps, raise_on_call_index=1)
    ms._bridge = stub  # type: ignore[assignment]
    try:
        out = asyncio.run(ms.read_screen(id=sid, commit_window_ms=10))
        # No exception; payload is valid; window-used signals degraded mode.
        assert out.get("commit_window_ms_used", 0) == 0 or "commit_window_ms_used" not in out
        assert out.get("render_hash") == "h1"
    finally:
        ms._bridge = prev_bridge
        ms._registry.remove(sid)
        ms._session_locks.pop(sid, None)
        _clear(sid)


def test_close_session_pops_session_lock() -> None:
    sid = "close-pops-lock"
    _clear(sid)
    _register_stub(sid)

    # Acquire (lazily) the lock for the session.
    lock = ms._get_session_lock(sid)
    assert sid in ms._session_locks
    assert lock is ms._session_locks[sid]

    snaps = [
        {
            "hash": "h", "text": "x",
            "cursor": {"row": 0, "col": 0}, "alt": False, "rows": 24, "cols": 80,
        },
    ]
    prev_bridge = ms._bridge
    stub = _StubBridge(snaps)
    ms._bridge = stub  # type: ignore[assignment]
    try:
        asyncio.run(ms.close_session(id=sid))
        assert sid not in ms._session_locks
    finally:
        ms._bridge = prev_bridge
        # close_session removed the registry entry already.
        _clear(sid)
