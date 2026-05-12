"""Unit tests for the read_screen dedup helpers."""

from __future__ import annotations

from server.mcp_server import _changed_lines, _trim_minimal


def test_changed_lines_empty_prev_returns_all() -> None:
    curr = "a\nb\nc"
    out = _changed_lines("", curr)
    assert out == [{"row": 0, "text": "a"}, {"row": 1, "text": "b"}, {"row": 2, "text": "c"}]


def test_changed_lines_no_change_returns_empty() -> None:
    s = "a\nb\nc"
    assert _changed_lines(s, s) == []


def test_changed_lines_returns_only_differing_rows() -> None:
    prev = "a\nb\nc\nd"
    curr = "a\nB\nc\nD"
    assert _changed_lines(prev, curr) == [
        {"row": 1, "text": "B"},
        {"row": 3, "text": "D"},
    ]


def test_changed_lines_handles_curr_longer_than_prev() -> None:
    prev = "a\nb"
    curr = "a\nb\nc\nd"
    assert _changed_lines(prev, curr) == [
        {"row": 2, "text": "c"},
        {"row": 3, "text": "d"},
    ]


def test_changed_lines_handles_curr_shorter_than_prev() -> None:
    prev = "a\nb\nc\nd"
    curr = "a\nb"
    assert _changed_lines(prev, curr) == []


def test_trim_minimal_drops_text_field() -> None:
    snap = {"hash": "h1", "text": "a\nb\nc", "serialized": "xyz", "cursor": {"row": 1, "col": 2}}
    out = _trim_minimal(snap)
    assert "text" not in out
    assert "serialized" not in out


def test_trim_minimal_preserves_hash_cursor_metrics() -> None:
    snap = {
        "hash": "h1",
        "cursor": {"row": 1, "col": 2},
        "alt": False,
        "rows": 50,
        "cols": 200,
        "idleSinceMs": 800,
        "lastPromptAtMs": 1234,
        "text": "ignored",
    }
    out = _trim_minimal(snap)
    assert out == {
        "hash": "h1",
        "cursor": {"row": 1, "col": 2},
        "alt": False,
        "rows": 50,
        "cols": 200,
        "idle_since_ms": 800,
        "last_prompt_at_ms": 1234,
    }
