"""Negative-path validation tests for the master-facing MCP tools.

These tests don't need a real PTY; they exercise the validation gates that
fire BEFORE the bridge is touched (or hit it with a stub bridge that raises
NotImplementedError on .call()). The 11-of-16 master-facing MCP tools that
today are only covered through the higher-level Bridge interface are
exercised here at the @mcp.tool() wrapper level for their reject paths.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import pytest

from server import db, mcp_server, sessions
from server.sessions import SessionSpec


class _StubBridge:
    """Minimal Bridge replacement.

    Any tool that actually reaches ``bridge.call(...)`` will see
    NotImplementedError, which is fine for the negative-path tests because
    they reject earlier (most validation fires before the bridge is touched).
    """

    def __init__(self) -> None:
        self._handlers: list = []

    def add_event_handler(self, h: Any) -> None:
        self._handlers.append(h)

    async def call(self, op: str, args: dict[str, Any]) -> Any:
        raise NotImplementedError(f"stub bridge cannot handle {op!r}")


def _make_spec(
    sid: str,
    *,
    mode: str = "strict",
    cols: int = 200,
    rows: int = 50,
) -> SessionSpec:
    """Construct a SessionSpec directly without going through build_spec.

    This bypasses the on-disk side effects of build_spec (HOME materialization,
    mcp-config writes, claude-binary lookup). It's enough to register a session
    in the in-memory ``_registry`` so ``_registry_or_404`` succeeds.
    """
    return SessionSpec(
        id=sid,
        cwd="/tmp",
        permission_mode=mode,  # type: ignore[arg-type]
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


@pytest.fixture(autouse=True)
def _wire_stub_bridge(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Per-test isolation: tmp DB + tmp cache + clean registry + stub bridge."""
    # Point the DB at a tmp file so we don't pollute the real one.
    db_path = tmp_path / "state.db"
    db.init_db(db_path)

    # Redirect cache_root so the _logged tool_calls.jsonl writes are sandboxed.
    cache_base = tmp_path / "cache" / "claude-puppet" / "sessions"
    cache_base.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(mcp_server, "cache_root", lambda: cache_base)
    monkeypatch.setattr(sessions, "cache_root", lambda: cache_base)

    # Reset module-level state between tests.
    mcp_server._registry = mcp_server.SessionRegistry()
    mcp_server._history.clear()
    mcp_server._last_data_ts.clear()
    mcp_server._last_prompt_ts.clear()
    mcp_server._exited.clear()
    mcp_server._master_last_hash.clear()
    mcp_server._master_last_text.clear()
    mcp_server._master_last_render_hash.clear()
    mcp_server._master_last_content_hash.clear()

    # Install the stub.
    mcp_server.set_bridge(_StubBridge())
    yield


# ---------------------------------------------------------------------------
# open_session: argument validation rejects before any bridge call
# ---------------------------------------------------------------------------


async def test_open_session_rejects_bad_permission_mode(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="permission_mode must be one of"):
        await mcp_server.open_session(
            id="ok-id",
            cwd=str(tmp_path),
            permission_mode="bogus",
        )


async def test_open_session_rejects_bad_id(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="session id must be"):
        await mcp_server.open_session(
            id="a/b",
            cwd=str(tmp_path),
        )


async def test_open_session_rejects_unreasonable_cols_rows(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="unreasonable"):
        await mcp_server.open_session(
            id="ok-id",
            cwd=str(tmp_path),
            cols=5,
            rows=2,
        )


async def test_open_session_rejects_unknown_parent_id(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="unknown parent_id"):
        await mcp_server.open_session(
            id="child",
            cwd=str(tmp_path),
            parent_id="ghost",
        )


async def test_open_session_permission_monotonicity_violation(tmp_path: Path) -> None:
    # Seed a parent in the DB with a restrictive permission mode (plan) AND
    # nested_puppetry=True — we need the capability gate to pass so the
    # monotonicity check is the one that fires.
    parent_spec = _make_spec("parent-mono", mode="plan")
    db.insert_session(parent_spec, owner="tester", pid=123, nested_puppetry=True)

    # Opening a child with a more permissive mode (yolo) must reject.
    with pytest.raises(ValueError, match="monotonicity"):
        await mcp_server.open_session(
            id="child-mono",
            cwd=str(tmp_path),
            permission_mode="yolo",
            parent_id="parent-mono",
        )


async def test_open_session_rejects_unauthorized_parent(tmp_path: Path) -> None:
    """A parent without nested_puppetry=True cannot spawn sub-slaves, even
    if permission monotonicity would otherwise allow it. The gate is the
    capability flag, separate from permission rank."""
    parent_spec = _make_spec("parent-locked", mode="acceptEdits")
    # Default nested_puppetry=False — capability denied.
    db.insert_session(parent_spec, owner="tester", pid=123)

    with pytest.raises(PermissionError, match="not authorized to spawn"):
        await mcp_server.open_session(
            id="child-blocked",
            cwd=str(tmp_path),
            permission_mode="strict",  # monotonicity OK; gate should still reject
            parent_id="parent-locked",
        )


async def test_set_nested_puppetry_flips_runtime_capability(tmp_path: Path) -> None:
    """set_nested_puppetry mutates the in-process spec AND the DB row, so
    the next open_session(parent_id=...) reflects the change immediately."""
    parent_spec = _make_spec("parent-elevate", mode="acceptEdits")
    db.insert_session(parent_spec, owner="tester", pid=123)
    mcp_server._registry.register(parent_spec)

    # Initially False → reject.
    with pytest.raises(PermissionError):
        await mcp_server.open_session(
            id="child-1",
            cwd=str(tmp_path),
            permission_mode="strict",
            parent_id="parent-elevate",
        )

    # Grant capability at runtime.
    result = await mcp_server.set_nested_puppetry(id="parent-elevate", nested_puppetry=True)
    assert result == {"ok": True, "id": "parent-elevate", "nested_puppetry": True}
    assert parent_spec.nested_puppetry is True
    row = db.get_session("parent-elevate")
    assert bool(row.get("nested_puppetry"))

    # Revoke and verify rejection returns. (We don't actually let the spawn
    # succeed in this test — the stub bridge raises NotImplementedError on
    # bridge.call. Revoking and re-checking the gate is the cheap signal.)
    await mcp_server.set_nested_puppetry(id="parent-elevate", nested_puppetry=False)
    assert parent_spec.nested_puppetry is False
    with pytest.raises(PermissionError):
        await mcp_server.open_session(
            id="child-2",
            cwd=str(tmp_path),
            permission_mode="strict",
            parent_id="parent-elevate",
        )


async def test_set_nested_puppetry_unknown_session() -> None:
    with pytest.raises(ValueError, match="unknown session"):
        await mcp_server.set_nested_puppetry(id="ghost", nested_puppetry=True)


# ---------------------------------------------------------------------------
# Tools that fail at _registry_or_404 before the bridge is called
# ---------------------------------------------------------------------------


async def test_send_keys_unknown_session() -> None:
    with pytest.raises(ValueError, match="unknown session id"):
        await mcp_server.send_keys(id="nope", keys=["<Enter>"])


async def test_send_text_unknown_session() -> None:
    with pytest.raises(ValueError, match="unknown session id"):
        await mcp_server.send_text(id="nope", text="hello")


async def test_interrupt_unknown_session() -> None:
    with pytest.raises(ValueError, match="unknown session id"):
        await mcp_server.interrupt(id="nope")


async def test_resize_session_unknown_session() -> None:
    with pytest.raises(ValueError, match="unknown session id"):
        await mcp_server.resize_session(id="nope", cols=80, rows=24)


@pytest.mark.xfail(reason="depends on resize clamp fix in a parallel branch")
async def test_resize_session_unreasonable_dims() -> None:
    """Resizing an EXISTING session to absurd dims should be rejected.

    This depends on a resize-clamp / validation fix that may live in a parallel
    branch; once both are merged, the test runs on the integrated tree.
    """
    spec = _make_spec("resize-existing")
    mcp_server._registry.register(spec)
    with pytest.raises(ValueError):
        await mcp_server.resize_session(id="resize-existing", cols=99999, rows=99999)


async def test_close_session_unknown_session() -> None:
    with pytest.raises(ValueError, match="unknown session id"):
        await mcp_server.close_session(id="nope")


async def test_read_log_unknown_session() -> None:
    with pytest.raises(ValueError, match="unknown session id"):
        await mcp_server.read_log(id="nope")


async def test_set_permission_mode_unknown_session() -> None:
    with pytest.raises(ValueError, match="unknown session id"):
        await mcp_server.set_permission_mode(id="nope", mode="strict")


async def test_wait_for_idle_unknown_session() -> None:
    with pytest.raises(ValueError, match="unknown session id"):
        await mcp_server.wait_for_idle(id="nope", stable_ms=10, timeout_ms=10)


async def test_wait_and_read_unknown_session() -> None:
    with pytest.raises(ValueError, match="unknown session id"):
        await mcp_server.wait_and_read(id="nope", stable_ms=10, timeout_ms=10)


async def test_wait_for_unknown_session() -> None:
    with pytest.raises(ValueError, match="unknown session id"):
        await mcp_server.wait_for(id="nope", pattern="anything", timeout_ms=10)


# ---------------------------------------------------------------------------
# Tools that look up the DB directly for unknown-id rejection
# ---------------------------------------------------------------------------


async def test_list_descendants_unknown_id() -> None:
    with pytest.raises(ValueError, match="unknown session id"):
        await mcp_server.list_descendants(id="ghost")


async def test_session_tree_unknown_root() -> None:
    with pytest.raises(ValueError, match="unknown session id"):
        await mcp_server.session_tree(root_id="ghost")
