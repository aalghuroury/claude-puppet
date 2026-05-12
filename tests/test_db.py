"""Tests for the persistent SQLite session store."""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import pytest

from server import db
from server.sessions import SessionSpec


def _spec(sid: str = "s1", *, cols: int = 200, rows: int = 50) -> SessionSpec:
    return SessionSpec(
        id=sid,
        cwd="/tmp",
        permission_mode="strict",
        allowed_tools=None,
        env={},
        cols=cols,
        rows=rows,
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


def test_init_db_creates_schema(tmp_path: Path) -> None:
    p = tmp_path / "state.db"
    out = db.init_db(p)
    assert out == p and p.exists()
    with sqlite3.connect(str(p)) as c:
        names = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "sessions" in names
        mode = c.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode.lower() == "wal"
        idx = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        assert "idx_sessions_owner" in idx
        assert "idx_sessions_status" in idx


def test_insert_and_list(tmp_db: Path) -> None:
    db.insert_session(_spec("a"), owner="alice", pid=1234)
    db.insert_session(_spec("b"), owner="bob", pid=5678)
    alice = db.list_sessions(owner="alice")
    assert len(alice) == 1
    row = alice[0]
    assert row["id"] == "a"
    assert row["owner"] == "alice"
    assert row["status"] == "alive"
    assert row["pid"] == 1234
    assert json.loads(row["cmd_args"])[0] == "--strict-mcp-config"


def test_mark_closed_idempotent(tmp_db: Path) -> None:
    db.insert_session(_spec("c"), owner="me", pid=1)
    db.mark_closed("c", code=0, signal=None, ts_ms=1000)
    first = db.get_session("c")
    assert first["status"] == "closed"
    assert first["closed_at_ms"] == 1000
    db.mark_closed("c", code=137, signal="SIGKILL", ts_ms=2000)
    second = db.get_session("c")
    assert second["closed_at_ms"] == 1000  # unchanged
    assert second["exit_code"] == 0
    assert second["exit_signal"] is None


def test_mark_crashed_all_alive_only_alive(tmp_db: Path) -> None:
    db.insert_session(_spec("a1"), owner="x", pid=1)
    db.insert_session(_spec("a2"), owner="x", pid=2)
    db.insert_session(_spec("c1"), owner="x", pid=3)
    db.mark_closed("c1", code=0, signal=None, ts_ms=500)
    n = db.mark_crashed_all_alive(reason="daemon_restart")
    assert n == 2
    assert db.get_session("a1")["status"] == "crashed"
    assert db.get_session("a1")["exit_signal"] == "daemon_restart"
    assert db.get_session("a2")["status"] == "crashed"
    untouched = db.get_session("c1")
    assert untouched["status"] == "closed"
    assert untouched["closed_at_ms"] == 500
    assert untouched["exit_signal"] is None


def test_get_session_missing_returns_none(tmp_db: Path) -> None:
    assert db.get_session("does-not-exist") is None
