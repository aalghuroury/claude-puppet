"""Async fixture starting a real Bridge against the built pty-bridge worker."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
import pytest_asyncio

from server.bridge import Bridge


@pytest_asyncio.fixture
async def bridge() -> AsyncIterator[Bridge]:
    bjs = Path(__file__).resolve().parents[2] / "pty-bridge" / "dist" / "index.js"
    if not bjs.exists():
        pytest.skip("pty-bridge not built")
    b = await Bridge.start(bjs)
    try:
        yield b
    finally:
        await b.close(timeout=5)
