"""Snapshot-based unit tests for screen heuristics."""

from __future__ import annotations

import time
from typing import Any

from server.screen import (
    compute_idle_metrics,
    hash_history_push,
    is_idle,
    looks_like_prompt,
)


def _now_ms() -> int:
    return int(time.time() * 1000)


def make_snapshot(
    text: str = ">> ",
    *,
    hash_: str = "h1",
    cursor_row: int | None = None,
    rows: int = 24,
    cols: int = 80,
    last_prompt_at_ms: int | None = None,
    idle_since_ms: int = 0,
    alt: bool = False,
) -> dict[str, Any]:
    if cursor_row is None:
        cursor_row = rows - 1
    return {
        "text": text,
        "cursor": {"row": cursor_row, "col": 3},
        "alt": alt,
        "cols": cols,
        "rows": rows,
        "hash": hash_,
        "idleSinceMs": idle_since_ms,
        "lastPromptAtMs": last_prompt_at_ms,
    }


def test_compute_idle_metrics_basic_shape() -> None:
    snap = make_snapshot(idle_since_ms=42, last_prompt_at_ms=12345)
    m = compute_idle_metrics(snap)
    assert m == {
        "idle_since_ms": 42,
        "last_prompt_at_ms": 12345,
        "looks_like_prompt": True,
    }


def test_looks_like_prompt_via_glyph() -> None:
    # Cursor in bottom 4 + last non-empty line contains ">".
    snap = make_snapshot(text="\n".join([""] * 22 + ["something", "> "]), cursor_row=23)
    assert looks_like_prompt(snap) is True


def test_looks_like_prompt_via_osc133() -> None:
    # Cursor at top — but a recent OSC 133 marker still flags prompt-visible.
    snap = make_snapshot(text="no glyph here", cursor_row=0, last_prompt_at_ms=_now_ms() - 100)
    assert looks_like_prompt(snap) is True


def test_looks_like_prompt_negative_top_cursor() -> None:
    snap = make_snapshot(text="> still has glyph", cursor_row=0, last_prompt_at_ms=None)
    assert looks_like_prompt(snap) is False


def test_is_idle_requires_history_span() -> None:
    snap = make_snapshot(hash_="h1")
    # Single entry → False.
    assert is_idle(snap, [{"ts": _now_ms(), "hash": "h1"}], stable_ms=600) is False
    # Two entries spanning < stable_ms → False.
    now = _now_ms()
    history = [{"ts": now - 100, "hash": "h1"}, {"ts": now, "hash": "h1"}]
    assert is_idle(snap, history, stable_ms=600) is False


def test_is_idle_true_when_stable_and_prompt_visible() -> None:
    snap = make_snapshot(text="\n".join([""] * 22 + ["ready", "> "]), cursor_row=23, hash_="h9")
    now = _now_ms()
    history = [{"ts": now - 800, "hash": "h9"}, {"ts": now, "hash": "h9"}]
    assert is_idle(snap, history, stable_ms=600) is True


def test_is_idle_true_when_stable_without_prompt_glyph() -> None:
    """Onboarding-menu case: stable hash, cursor not at prompt — should now be idle."""
    snap = make_snapshot(text="pick a billing plan", cursor_row=5, hash_="X")
    now = _now_ms()
    history = [{"ts": now - 700, "hash": "X"}, {"ts": now - 100, "hash": "X"}]
    assert is_idle(snap, history, stable_ms=600) is True


def test_is_idle_false_when_hash_changed() -> None:
    snap = make_snapshot(text="\n".join([""] * 22 + ["ready", "> "]), cursor_row=23, hash_="h9")
    now = _now_ms()
    history = [{"ts": now - 800, "hash": "h8"}, {"ts": now, "hash": "h9"}]
    assert is_idle(snap, history, stable_ms=600) is False


def test_hash_history_push_trims_to_max_len() -> None:
    history: list[dict[str, Any]] = []
    for i in range(10):
        hash_history_push(history, make_snapshot(hash_=f"h{i}"), max_len=4)
    assert len(history) == 4
    assert [h["hash"] for h in history] == ["h6", "h7", "h8", "h9"]
