"""Unit tests for the class-aware dedup helpers in mcp_server."""

from __future__ import annotations

from server.classify import RowClass
from server.mcp_server import (
    _annotate_changed_lines,
    _annotated_full_text,
    _content_hash,
    _normalize_classes,
)


def test_content_hash_excludes_status_rows() -> None:
    chat = "hello world\nready"
    noisy = "hello world\n✶ Razzmatazzing…\nready"
    assert _content_hash(chat) == _content_hash(noisy)


def test_content_hash_stable_when_only_status_changes() -> None:
    a = "chat line\n(5s · ↓ 1.2k tokens · esc to interrupt)"
    b = "chat line\n(7s · ↓ 1.4k tokens · esc to interrupt)"
    assert _content_hash(a) == _content_hash(b)


def test_filtered_changed_lines_drops_chrome() -> None:
    prev = "old line\n──────\nfooter"
    curr = "new line\n══════\nfooter"
    allowed = (RowClass.CHAT, RowClass.MENU, RowClass.PROMPT)
    rows = _annotate_changed_lines(prev, curr, allowed)
    # The chrome row changed too but is filtered out; only the chat row remains.
    assert rows == [{"row": 0, "text": "new line", "class": "chat"}]


def test_filtered_changed_lines_keeps_chat_and_menu() -> None:
    prev = ""
    curr = "hello\n❯ 1. Yes\n  2. No\n✶ Razzmatazzing…"
    allowed = (RowClass.CHAT, RowClass.MENU, RowClass.PROMPT)
    rows = _annotate_changed_lines(prev, curr, allowed)
    classes = [r["class"] for r in rows]
    texts = [r["text"] for r in rows]
    assert "chat" in classes
    assert "menu" in classes
    assert "status" not in classes
    assert "✶ Razzmatazzing…" not in texts
    assert "hello" in texts
    assert "❯ 1. Yes" in texts


def test_force_full_returns_text_with_class_annotations() -> None:
    text = "hello\n──────\n❯ 1. Yes\n✶ Razzmatazzing…"
    allowed = (RowClass.CHAT, RowClass.MENU, RowClass.PROMPT)
    rows = _annotated_full_text(text, allowed)
    classes = [r["class"] for r in rows]
    assert "chat" in classes
    assert "menu" in classes
    assert "chrome" not in classes
    assert "status" not in classes
    # Row indices are preserved from the source text (not renumbered).
    by_text = {r["text"]: r["row"] for r in rows}
    assert by_text["hello"] == 0
    assert by_text["❯ 1. Yes"] == 2


def test_normalize_classes_default_and_passthrough() -> None:
    assert _normalize_classes(None) == (RowClass.CHAT, RowClass.MENU, RowClass.PROMPT)
    assert _normalize_classes(["chat"]) == (RowClass.CHAT,)
    # Bogus values are dropped, not raised; empty result falls back to default.
    assert _normalize_classes(["bogus"]) == (RowClass.CHAT, RowClass.MENU, RowClass.PROMPT)


def test_alive_or_exited_rejects_after_external_kill() -> None:
    """F1 fix: tools must reject ops on a session whose slave PTY has already exited."""
    import pytest
    from server import mcp_server as ms
    from server.sessions import SessionSpec

    sid = "alive-or-exited-test"
    # Fabricate a registered spec so _registry_or_404 succeeds.
    spec = SessionSpec(
        id=sid, cwd="/tmp", permission_mode="strict",
        allowed_tools=None, env={}, cols=80, rows=24,
        home="/tmp/fake", transcript_dir="/tmp/fake",
        cmd="/bin/bash", cmd_args=[],
    )
    ms._registry.register(spec)
    try:
        # Without exit signal: helper returns the spec.
        got = ms._alive_or_exited(sid)
        assert got is spec
        # Simulate bridge firing exit (as _on_bridge_event would on external kill).
        ms._exited[sid] = {"code": -9, "signal": "SIGKILL", "ts": 1234567890}
        with pytest.raises(ValueError, match="exited"):
            ms._alive_or_exited(sid)
    finally:
        ms._registry.remove(sid)
        ms._exited.pop(sid, None)


def test_view_only_does_not_mutate_master_tracker() -> None:
    """Observers (e.g. dashboard's screen-poller) must not poison the real master's dedup baseline."""
    from server import mcp_server as ms

    sid = "view-only-test"
    # Seed the trackers with a known baseline, as if the real master had already read.
    baseline_render = "deadbeef" * 5
    baseline_content = "cafef00d" * 5
    baseline_text = "real master saw this"
    ms._master_last_render_hash[sid] = baseline_render
    ms._master_last_content_hash[sid] = baseline_content
    ms._master_last_hash[sid] = baseline_render
    ms._master_last_text[sid] = baseline_text

    # Build a fake bridge snapshot.
    snap = {
        "hash": "00aabbccddeeff00",
        "text": "totally different content",
        "cursor": {"row": 0, "col": 0},
        "alt": False,
        "rows": 24,
        "cols": 80,
        "idleSinceMs": 0,
        "lastPromptAtMs": None,
    }
    allowed = (RowClass.CHAT, RowClass.MENU, RowClass.PROMPT)

    # view_only=True must NOT update the trackers
    out_view = ms._build_read_screen_payload(
        sid, snap,
        mode="visible", since_hash=None, force_full=True,
        include_classes=allowed, dedup="content", view_only=True,
    )
    assert out_view.get("full") is True
    assert ms._master_last_render_hash[sid] == baseline_render
    assert ms._master_last_content_hash[sid] == baseline_content
    assert ms._master_last_text[sid] == baseline_text

    # Default view_only=False DOES update the trackers
    ms._build_read_screen_payload(
        sid, snap,
        mode="visible", since_hash=None, force_full=True,
        include_classes=allowed, dedup="content",
    )
    assert ms._master_last_render_hash[sid] != baseline_render
    assert ms._master_last_text[sid] == "totally different content"

    # cleanup
    for d in (ms._master_last_render_hash, ms._master_last_content_hash,
              ms._master_last_hash, ms._master_last_text):
        d.pop(sid, None)
