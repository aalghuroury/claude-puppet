"""Tests for nested mastery: depth, monotonicity, mcp-config opt-in."""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import pytest

from server import db, sessions
from server.sessions import (
    SessionSpec,
    assert_permission_monotonic,
    build_spec,
)


def _spec(sid: str = "s1", *, mode: str = "strict") -> SessionSpec:
    return SessionSpec(
        id=sid,
        cwd="/tmp",
        permission_mode=mode,  # type: ignore[arg-type]
        allowed_tools=None,
        env={},
        cols=200,
        rows=50,
        home=Path("/tmp/home"),
        transcript_dir=Path("/tmp/tx"),
        cmd="/usr/bin/claude",
        cmd_args=["--strict-mcp-config", "--mcp-config", "/tmp/x.json"],
        mcp_servers=None,
        opened_at_ms=int(time.time() * 1000),
    )


@pytest.fixture
def tmp_db(tmp_path: Path) -> Path:
    p = tmp_path / "state.db"
    db.init_db(p)
    return p


@pytest.fixture
def tmp_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect cache_root() to a tmp dir so build_spec writes there."""
    base = tmp_path / "cache" / "claude-puppet" / "sessions"
    base.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(sessions, "cache_root", lambda: base)
    monkeypatch.setattr(sessions, "_claude_binary", lambda: "/usr/bin/claude")
    monkeypatch.setattr(sessions, "_master_claude_dir", lambda: tmp_path / "master_claude")
    (tmp_path / "master_claude").mkdir(exist_ok=True)
    return base


def test_assert_permission_monotonic_allows_same() -> None:
    assert_permission_monotonic("strict", "strict")
    assert_permission_monotonic("yolo", "yolo")


def test_assert_permission_monotonic_allows_narrowing() -> None:
    assert_permission_monotonic("yolo", "strict")
    assert_permission_monotonic("acceptEdits", "plan")
    assert_permission_monotonic("strict", "plan")


def test_assert_permission_monotonic_rejects_widening() -> None:
    with pytest.raises(ValueError):
        assert_permission_monotonic("plan", "yolo")
    with pytest.raises(ValueError):
        assert_permission_monotonic("strict", "yolo")
    with pytest.raises(ValueError):
        assert_permission_monotonic("plan", "strict")


def test_db_schema_has_new_columns(tmp_db: Path) -> None:
    with sqlite3.connect(str(tmp_db)) as c:
        cols = {r[1] for r in c.execute("PRAGMA table_info(sessions)").fetchall()}
    for name in ("parent_id", "depth", "max_depth", "nested_puppetry"):
        assert name in cols, f"missing column {name}"
    with sqlite3.connect(str(tmp_db)) as c:
        idx = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='index'").fetchall()}
    assert "idx_sessions_parent" in idx


def test_insert_with_parent(tmp_db: Path) -> None:
    db.insert_session(_spec("p"), owner="me", pid=1)
    db.insert_session(
        _spec("c"),
        owner="me",
        pid=2,
        parent_id="p",
        depth=1,
        max_depth=3,
        nested_puppetry=True,
    )
    child = db.get_session("c")
    assert child is not None
    assert child["parent_id"] == "p"
    assert int(child["depth"]) == 1
    assert int(child["max_depth"]) == 3
    assert int(child["nested_puppetry"]) == 1
    parent = db.get_session("p")
    assert parent["parent_id"] is None
    assert int(parent["depth"]) == 0


def test_get_descendants_topological(tmp_db: Path) -> None:
    # Build: root -> a -> a1 ; root -> b
    db.insert_session(_spec("root"), owner="x", pid=1)
    db.insert_session(_spec("a"), owner="x", pid=2, parent_id="root", depth=1)
    db.insert_session(_spec("b"), owner="x", pid=3, parent_id="root", depth=1)
    db.insert_session(_spec("a1"), owner="x", pid=4, parent_id="a", depth=2)
    desc = db.get_descendants("root")
    ids = [r["id"] for r in desc]
    assert set(ids) == {"a", "b", "a1"}
    # Topological: parents come before children. a must precede a1.
    assert ids.index("a") < ids.index("a1")


def test_build_spec_nested_writes_puppet_in_mcp_config(tmp_cache: Path) -> None:
    spec = build_spec(
        sid="nested1",
        cwd="/tmp",
        permission_mode="strict",
        nested_puppetry=True,
        depth=1,
        parent_id="root",
    )
    cfg_path = spec.home / ".claude" / "mcp-config.json"
    assert cfg_path.exists()
    cfg = json.loads(cfg_path.read_text())
    assert "claude-puppet" in cfg["mcpServers"]
    entry = cfg["mcpServers"]["claude-puppet"]
    assert entry["type"] == "http"
    assert entry["url"] == "http://localhost:5056/mcp"
    assert spec.nested_puppetry is True
    assert spec.depth == 1
    assert spec.parent_id == "root"


def test_build_spec_default_writes_puppet_entry_with_flag_off(tmp_cache: Path) -> None:
    """Every slave's mcp-config now ALWAYS contains the puppet entry — the
    gate moved server-side (set_nested_puppetry / parent_id check in
    open_session). spec.nested_puppetry default is still False; that flag is
    the authorization, not the tools' presence."""
    spec = build_spec(sid="plain1", cwd="/tmp", permission_mode="strict")
    cfg_path = spec.home / ".claude" / "mcp-config.json"
    cfg = json.loads(cfg_path.read_text())
    assert list(cfg["mcpServers"].keys()) == ["claude-puppet"]
    entry = cfg["mcpServers"]["claude-puppet"]
    assert entry["type"] == "http"
    assert entry["url"] == "http://localhost:5056/mcp"
    assert spec.nested_puppetry is False
    assert spec.depth == 0
    assert spec.parent_id is None
