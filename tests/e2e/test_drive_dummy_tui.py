"""End-to-end tests that drive a tiny bash interactive program (no live claude needed)."""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from pathlib import Path

import pytest

from server.bridge import Bridge, BridgeError
from server.sessions import cache_root

pytestmark = pytest.mark.asyncio


async def test_open_write_snapshot_close(bridge: Bridge) -> None:
    sid = f"e2e-{uuid.uuid4().hex[:8]}"
    transcript_dir = cache_root() / sid / "transcripts"
    transcript_dir.mkdir(parents=True, exist_ok=True)

    open_args = {
        "id": sid,
        "cmd": "/usr/bin/env",
        "cmdArgs": ["bash", "-c", "printf 'PROMPT> '; read line; printf 'GOT:%s\\n' \"$line\""],
        "cwd": "/tmp",
        "env": {
            "PATH": os.environ.get("PATH", ""),
            "TERM": "xterm-256color",
            "HOME": str(Path.home()),
        },
        "cols": 80,
        "rows": 24,
        "transcriptDir": str(transcript_dir),
    }
    open_result = await bridge.call("open", open_args)
    assert "pid" in open_result

    snap: dict = {"text": ""}
    for _ in range(30):
        snap = await bridge.call("snapshot", {"id": sid, "mode": "visible"})
        if "PROMPT>" in snap["text"]:
            break
        await asyncio.sleep(0.05)
    else:
        pytest.fail(f"prompt never appeared; got: {snap['text']!r}")

    await bridge.call("write", {"id": sid, "items": ["hello", "<Enter>"], "bracketedPaste": False})

    for _ in range(40):
        snap = await bridge.call("snapshot", {"id": sid, "mode": "visible"})
        if "GOT:hello" in snap["text"]:
            break
        await asyncio.sleep(0.05)
    else:
        pytest.fail(f"echo never appeared; got: {snap['text']!r}")

    await bridge.call("close", {"id": sid})

    transcript = transcript_dir / "transcript.jsonl"
    assert transcript.exists() and transcript.stat().st_size > 0
    lines = [json.loads(l) for l in transcript.read_text().splitlines() if l.strip()]
    dirs = {l["dir"] for l in lines}
    assert "out" in dirs, f"no output captured; lines={lines[:3]}"


async def test_resize(bridge: Bridge) -> None:
    sid = f"resize-{uuid.uuid4().hex[:8]}"
    td = cache_root() / sid / "transcripts"
    td.mkdir(parents=True, exist_ok=True)
    await bridge.call(
        "open",
        {
            "id": sid,
            "cmd": "/usr/bin/env",
            "cmdArgs": ["sleep", "30"],
            "cwd": "/tmp",
            "env": {"PATH": os.environ.get("PATH", ""), "TERM": "xterm-256color"},
            "cols": 80,
            "rows": 24,
            "transcriptDir": str(td),
        },
    )
    await bridge.call("resize", {"id": sid, "cols": 120, "rows": 40})
    snap = await bridge.call("snapshot", {"id": sid, "mode": "visible"})
    assert snap["cols"] == 120 and snap["rows"] == 40
    await bridge.call("close", {"id": sid})


async def test_unresolved_key_errors(bridge: Bridge) -> None:
    """Unknown <key-name> tokens should produce a structured error from the bridge."""
    sid = f"badkey-{uuid.uuid4().hex[:8]}"
    td = cache_root() / sid / "transcripts"
    td.mkdir(parents=True, exist_ok=True)
    await bridge.call(
        "open",
        {
            "id": sid,
            "cmd": "/usr/bin/env",
            "cmdArgs": ["sleep", "10"],
            "cwd": "/tmp",
            "env": {"PATH": os.environ.get("PATH", ""), "TERM": "xterm-256color"},
            "cols": 80,
            "rows": 24,
            "transcriptDir": str(td),
        },
    )
    with pytest.raises(BridgeError, match=r"unresolved"):
        await bridge.call("write", {"id": sid, "items": ["<no-such-key>"], "bracketedPaste": False})
    await bridge.call("close", {"id": sid})
