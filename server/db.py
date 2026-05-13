"""SQLite-backed persistent record of every slave session ever opened.

Lives at ``~/.cache/claude-puppet/state.db`` (sibling of the per-session
home dirs under ``cache_root()``). Synchronous sqlite3 + WAL mode; one
connection per call, which is fine for our low write volume.
"""

from __future__ import annotations

import json
import sqlite3
import time
from collections import deque
from pathlib import Path
from typing import Any

from .log import get_logger
from .sessions import SessionSpec, cache_root

log = get_logger("db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id               TEXT PRIMARY KEY,
    owner            TEXT NOT NULL DEFAULT 'anonymous',
    cwd              TEXT NOT NULL,
    permission_mode  TEXT NOT NULL,
    home             TEXT NOT NULL,
    transcript_dir   TEXT NOT NULL,
    cmd              TEXT NOT NULL,
    cmd_args         TEXT NOT NULL,
    cols             INTEGER NOT NULL,
    rows             INTEGER NOT NULL,
    pid              INTEGER,
    created_at_ms    INTEGER NOT NULL,
    closed_at_ms     INTEGER,
    exit_code        INTEGER,
    exit_signal      TEXT,
    status           TEXT NOT NULL CHECK (status IN ('alive','closed','crashed'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS swarms (
    name             TEXT PRIMARY KEY,
    brief            TEXT,
    created_at_ms    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS swarm_members (
    swarm_name       TEXT NOT NULL,
    sid              TEXT NOT NULL,
    role             TEXT NOT NULL,
    joined_at_ms     INTEGER NOT NULL,
    PRIMARY KEY (swarm_name, sid)
);
CREATE INDEX IF NOT EXISTS idx_swarm_members_swarm ON swarm_members(swarm_name);

CREATE TABLE IF NOT EXISTS swarm_memory (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    swarm_name       TEXT NOT NULL,
    ts_ms            INTEGER NOT NULL,
    author_sid       TEXT,
    kind             TEXT,
    content          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_swarm_memory_name_ts ON swarm_memory(swarm_name, ts_ms);
"""

# Additive ALTER TABLE migrations applied when the column is missing. Append-only.
_MIGRATIONS: list[tuple[str, str]] = [
    ("parent_id", "ALTER TABLE sessions ADD COLUMN parent_id TEXT"),
    ("depth", "ALTER TABLE sessions ADD COLUMN depth INTEGER NOT NULL DEFAULT 0"),
    ("max_depth", "ALTER TABLE sessions ADD COLUMN max_depth INTEGER NOT NULL DEFAULT 3"),
    ("nested_puppetry", "ALTER TABLE sessions ADD COLUMN nested_puppetry INTEGER NOT NULL DEFAULT 0"),
]

_db_path: Path | None = None


def _default_db_path() -> Path:
    return cache_root().parent / "state.db"


def _conn(path: Path | None = None) -> sqlite3.Connection:
    p = path or _db_path or _default_db_path()
    c = sqlite3.connect(str(p))
    c.row_factory = sqlite3.Row
    return c


def _existing_columns(c: sqlite3.Connection) -> set[str]:
    return {r[1] for r in c.execute("PRAGMA table_info(sessions)").fetchall()}


def init_db(path: Path | None = None) -> Path:
    """Ensure the schema exists; switch on WAL. Returns the resolved path."""
    global _db_path
    p = path or _default_db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(str(p)) as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(_SCHEMA)
        cols = _existing_columns(c)
        for name, ddl in _MIGRATIONS:
            if name not in cols:
                c.execute(ddl)
        c.execute("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id)")
        c.commit()
    _db_path = p
    return p


def insert_session(
    spec: SessionSpec,
    *,
    owner: str,
    pid: int | None,
    parent_id: str | None = None,
    depth: int = 0,
    max_depth: int = 3,
    nested_puppetry: bool = False,
) -> None:
    """Record a new session with status='alive'."""
    with _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO sessions ("
            "id, owner, cwd, permission_mode, home, transcript_dir, cmd, cmd_args,"
            " cols, rows, pid, created_at_ms, closed_at_ms, exit_code, exit_signal, status,"
            " parent_id, depth, max_depth, nested_puppetry"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'alive',"
            " ?, ?, ?, ?)",
            (
                spec.id,
                owner,
                spec.cwd,
                spec.permission_mode,
                str(spec.home),
                str(spec.transcript_dir),
                spec.cmd,
                json.dumps(spec.cmd_args),
                spec.cols,
                spec.rows,
                pid,
                spec.opened_at_ms,
                parent_id,
                int(depth),
                int(max_depth),
                1 if nested_puppetry else 0,
            ),
        )
        c.commit()


def set_nested_puppetry(sid: str, nested_puppetry: bool) -> None:
    """Update the nested_puppetry capability flag for a session row.

    Used by the runtime-elevation path: the master flips this to grant or
    revoke a slave's ability to call open_session(parent_id=<own-sid>).
    """
    with _conn() as c:
        c.execute(
            "UPDATE sessions SET nested_puppetry=? WHERE id=?",
            (1 if nested_puppetry else 0, sid),
        )
        c.commit()


# ---------------------------------------------------------------------------
# Swarm registry (multi-slave coordination groups)
# ---------------------------------------------------------------------------


def swarm_create(name: str, brief: str | None = None) -> None:
    """Create a new swarm row. Raises sqlite3.IntegrityError if name conflicts."""
    ts = int(time.time() * 1000)
    with _conn() as c:
        c.execute(
            "INSERT INTO swarms (name, brief, created_at_ms) VALUES (?, ?, ?)",
            (name, brief, ts),
        )
        c.commit()


def swarm_get(name: str) -> dict[str, Any] | None:
    with _conn() as c:
        row = c.execute("SELECT * FROM swarms WHERE name=?", (name,)).fetchone()
        return dict(row) if row else None


def swarm_list_all() -> list[dict[str, Any]]:
    with _conn() as c:
        rows = c.execute(
            "SELECT s.name, s.brief, s.created_at_ms, "
            "       (SELECT COUNT(*) FROM swarm_members m WHERE m.swarm_name=s.name) AS member_count "
            "FROM swarms s ORDER BY s.created_at_ms DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def swarm_add_member(swarm_name: str, sid: str, role: str) -> None:
    """Add or replace a member's role in a swarm (upsert by (swarm,sid))."""
    ts = int(time.time() * 1000)
    with _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO swarm_members "
            "(swarm_name, sid, role, joined_at_ms) VALUES (?, ?, ?, ?)",
            (swarm_name, sid, role, ts),
        )
        c.commit()


def swarm_members(swarm_name: str) -> list[dict[str, Any]]:
    with _conn() as c:
        rows = c.execute(
            "SELECT sid, role, joined_at_ms FROM swarm_members "
            "WHERE swarm_name=? ORDER BY joined_at_ms ASC",
            (swarm_name,),
        ).fetchall()
        return [dict(r) for r in rows]


def swarm_memory_append(
    swarm_name: str,
    content: str,
    *,
    author_sid: str | None = None,
    kind: str = "note",
) -> int:
    """Append a memory entry. Returns the new row id."""
    ts = int(time.time() * 1000)
    with _conn() as c:
        cur = c.execute(
            "INSERT INTO swarm_memory (swarm_name, ts_ms, author_sid, kind, content) "
            "VALUES (?, ?, ?, ?, ?)",
            (swarm_name, ts, author_sid, kind, content),
        )
        c.commit()
        return cur.lastrowid


def swarm_memory_read(swarm_name: str, limit: int = 20) -> list[dict[str, Any]]:
    """Return the most recent N memory entries for a swarm, newest first."""
    with _conn() as c:
        rows = c.execute(
            "SELECT id, ts_ms, author_sid, kind, content FROM swarm_memory "
            "WHERE swarm_name=? ORDER BY ts_ms DESC LIMIT ?",
            (swarm_name, int(limit)),
        ).fetchall()
        return [dict(r) for r in rows]


def mark_closed(sid: str, *, code: int | None, signal: str | None, ts_ms: int) -> None:
    """Idempotently transition status alive→closed; later marks are no-ops."""
    with _conn() as c:
        c.execute(
            "UPDATE sessions SET status='closed', closed_at_ms=?, exit_code=?, exit_signal=? "
            "WHERE id=? AND status='alive'",
            (ts_ms, code, signal, sid),
        )
        c.commit()


def mark_crashed_all_alive(reason: str = "daemon_restart") -> int:
    """On startup, declare every alive row crashed. Returns row count."""
    ts = int(time.time() * 1000)
    with _conn() as c:
        cur = c.execute(
            "UPDATE sessions SET status='crashed', closed_at_ms=?, exit_signal=? "
            "WHERE status='alive'",
            (ts, reason),
        )
        c.commit()
        return cur.rowcount


def get_session(sid: str) -> dict[str, Any] | None:
    with _conn() as c:
        row = c.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
        return dict(row) if row else None


def list_sessions(
    *, owner: str | None = None, status: str | None = None
) -> list[dict[str, Any]]:
    q = "SELECT * FROM sessions"
    where: list[str] = []
    params: list[Any] = []
    if owner is not None:
        where.append("owner = ?")
        params.append(owner)
    if status is not None:
        where.append("status = ?")
        params.append(status)
    if where:
        q += " WHERE " + " AND ".join(where)
    q += " ORDER BY created_at_ms DESC"
    with _conn() as c:
        return [dict(r) for r in c.execute(q, params).fetchall()]


def update_pid(sid: str, pid: int | None) -> None:
    with _conn() as c:
        c.execute("UPDATE sessions SET pid=? WHERE id=?", (pid, sid))
        c.commit()


def get_descendants(parent_id: str, max_depth: int = 10) -> list[dict[str, Any]]:
    """BFS descendants of `parent_id`; topological order (parents before children)."""
    out: list[dict[str, Any]] = []
    with _conn() as c:
        queue: deque[tuple[str, int]] = deque([(parent_id, 0)])
        seen: set[str] = {parent_id}
        while queue:
            pid, hop = queue.popleft()
            if hop >= max_depth:
                continue
            rows = c.execute(
                "SELECT * FROM sessions WHERE parent_id=? ORDER BY created_at_ms ASC",
                (pid,),
            ).fetchall()
            for r in rows:
                d = dict(r)
                if d["id"] in seen:
                    continue
                seen.add(d["id"])
                out.append(d)
                queue.append((d["id"], hop + 1))
    return out
