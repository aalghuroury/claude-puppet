"""Tests for v2 swarm primitives — spawn_role, swarm_* DB+tools, critique_loop,
vote. Bridge calls are stubbed; we test the in-process + DB plumbing only.
"""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Any

import pytest

from server import db, mcp_server, sessions
from server.sessions import SessionSpec


class _StubBridge:
    """Bridge stub. Records `write` calls so we can assert on them."""

    def __init__(self) -> None:
        self._handlers: list = []
        self.writes: list[dict[str, Any]] = []

    def add_event_handler(self, h: Any) -> None:
        self._handlers.append(h)

    async def call(self, op: str, args: dict[str, Any]) -> Any:
        if op == "write":
            self.writes.append(args)
            return {"ok": True}
        if op == "open":
            return {"pid": 12345}
        if op == "list_sessions":
            return []
        if op == "snapshot":
            return {"text": "", "cursor": {"row": 0}, "rows": 24, "cols": 80,
                    "alt": False, "idleSinceMs": 0, "lastPromptAtMs": None}
        raise NotImplementedError(f"stub bridge cannot handle {op!r}")


@pytest.fixture(autouse=True)
def _wire_stub_bridge(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Per-test isolation: tmp DB + tmp cache + clean registry + stub bridge."""
    db_path = tmp_path / "state.db"
    db.init_db(db_path)

    cache_base = tmp_path / "cache" / "claude-puppet" / "sessions"
    cache_base.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(mcp_server, "cache_root", lambda: cache_base)
    monkeypatch.setattr(sessions, "cache_root", lambda: cache_base)

    # Pre-create a fake puppet-roles tree pointed at by the spawn_role machinery.
    roles_root = tmp_path / "puppet-roles"
    roles_root.mkdir()
    (roles_root / "base.md").write_text("# base preamble\n")
    for role in ("critic", "researcher", "synthesizer", "planner",
                 "executor", "tester", "auditor"):
        d = roles_root / role
        d.mkdir()
        (d / "SKILL.md").write_text(f"# {role} skill\n")
        (d / "brief.template.md").write_text(
            "{{INCLUDE_BASE}}\n\n"
            f"# {role}\n"
            "swarm={{SWARM_NAME}} dir={{SWARM_DIR}} sid={{SID}} "
            "target={{TARGET_SID}} round={{ROUND}} role={{ROLE}} date={{DATE}}\n"
        )
    monkeypatch.setattr(mcp_server, "_ROLE_DIR", roles_root)

    mcp_server._registry = mcp_server.SessionRegistry()
    mcp_server._history.clear()
    mcp_server._last_data_ts.clear()
    mcp_server._last_prompt_ts.clear()
    mcp_server._exited.clear()
    mcp_server._master_last_hash.clear()
    mcp_server._master_last_text.clear()
    mcp_server._master_last_render_hash.clear()
    mcp_server._master_last_content_hash.clear()
    mcp_server._owner_by_sid.clear()
    mcp_server._event_queue.clear()
    mcp_server._event_signal.clear()

    stub = _StubBridge()
    mcp_server.set_bridge(stub)
    yield stub


# ---------------------------------------------------------------------------
# spawn_role
# ---------------------------------------------------------------------------


async def test_spawn_role_rejects_unknown_role(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="not found"):
        await mcp_server.spawn_role(
            role="nonexistent", id="sl-1", cwd=str(tmp_path),
        )


async def test_spawn_role_creates_skill_in_slave_home(tmp_path: Path) -> None:
    result = await mcp_server.spawn_role(
        role="critic", id="sl-1", cwd=str(tmp_path), owner="me",
    )
    # The skill must have been pre-populated into the slave's HOME before
    # any open machinery touched it.
    expected = mcp_server.cache_root() / "sl-1" / "home" / ".claude" / "skills" / "critic" / "SKILL.md"
    assert expected.exists()
    assert "critic skill" in expected.read_text()
    assert result["role"] == "critic"
    assert result["skill_path"] == str(expected)


async def test_spawn_role_renders_brief_with_substitutions(tmp_path: Path) -> None:
    result = await mcp_server.spawn_role(
        role="researcher", id="sl-2", cwd=str(tmp_path),
        owner="me", swarm="alpha-swarm", round_num=3,
    )
    brief = result["brief"]
    assert "swarm=alpha-swarm" in brief
    assert "sid=sl-2" in brief
    assert "role=researcher" in brief
    assert "round=3" in brief
    assert "puppet-swarm/alpha-swarm" in brief
    # base.md was inlined
    assert "base preamble" in brief
    # No unsubstituted markers
    assert "{{" not in brief.replace("{{INCLUDE_BASE}}", "")


async def test_spawn_role_extra_brief_vars(tmp_path: Path) -> None:
    """Test that extra_brief_vars get into the brief renderer."""
    # First add a custom marker into the role template
    custom_role_dir = mcp_server._ROLE_DIR / "critic"
    template = custom_role_dir / "brief.template.md"
    template.write_text(template.read_text() + "\nextra={{CUSTOM_FOO}}\n")

    result = await mcp_server.spawn_role(
        role="critic", id="sl-3", cwd=str(tmp_path),
        extra_brief_vars={"custom-foo": "bar-value"},
    )
    assert "extra=bar-value" in result["brief"]


# ---------------------------------------------------------------------------
# Swarm DB + MCP tools
# ---------------------------------------------------------------------------


async def test_swarm_create_persists() -> None:
    result = await mcp_server.swarm_create(name="s1", brief="hello brief")
    assert result["ok"] and result["created"] is True
    row = db.swarm_get("s1")
    assert row is not None
    assert row["brief"] == "hello brief"
    # Idempotent — second call returns existing without error.
    result2 = await mcp_server.swarm_create(name="s1")
    assert result2["created"] is False


async def test_swarm_add_member_persists() -> None:
    await mcp_server.swarm_create(name="s2")
    await mcp_server.swarm_add_member(swarm="s2", sid="x1", role="critic")
    await mcp_server.swarm_add_member(swarm="s2", sid="x2", role="producer")
    members = db.swarm_members("s2")
    assert {m["sid"] for m in members} == {"x1", "x2"}
    roles = {m["sid"]: m["role"] for m in members}
    assert roles["x1"] == "critic"
    assert roles["x2"] == "producer"
    # Upsert: re-add x1 with a different role.
    await mcp_server.swarm_add_member(swarm="s2", sid="x1", role="auditor")
    roles = {m["sid"]: m["role"] for m in db.swarm_members("s2")}
    assert roles["x1"] == "auditor"


async def test_swarm_add_member_rejects_unknown_swarm() -> None:
    with pytest.raises(ValueError, match="unknown swarm"):
        await mcp_server.swarm_add_member(swarm="ghost", sid="x1", role="critic")


async def test_swarm_memory_append_and_read() -> None:
    await mcp_server.swarm_create(name="s3")
    await mcp_server.swarm_memory_append(
        swarm="s3", content="first note", author_sid="alpha", kind="finding"
    )
    time.sleep(0.005)
    await mcp_server.swarm_memory_append(
        swarm="s3", content="second note", author_sid="beta", kind="decision"
    )
    result = await mcp_server.swarm_memory_read(swarm="s3", limit=10)
    entries = result["entries"]
    assert len(entries) == 2
    # Newest first
    assert entries[0]["content"] == "second note"
    assert entries[0]["author_sid"] == "beta"
    assert entries[1]["content"] == "first note"
    # limit honoured
    result_one = await mcp_server.swarm_memory_read(swarm="s3", limit=1)
    assert len(result_one["entries"]) == 1


async def test_swarm_list_returns_recent_first() -> None:
    await mcp_server.swarm_create(name="oldest")
    time.sleep(0.005)
    await mcp_server.swarm_create(name="middle")
    time.sleep(0.005)
    await mcp_server.swarm_create(name="newest")
    result = await mcp_server.swarm_list()
    names = [s["name"] for s in result["swarms"]]
    assert names == ["newest", "middle", "oldest"]


async def test_swarm_memory_rejects_unknown_swarm() -> None:
    with pytest.raises(ValueError, match="unknown swarm"):
        await mcp_server.swarm_memory_append(swarm="ghost", content="x")
    with pytest.raises(ValueError, match="unknown swarm"):
        await mcp_server.swarm_memory_read(swarm="ghost")
