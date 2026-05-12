"""Python ↔ Node pty-bridge subprocess client.

Spawns the Node worker once at startup, multiplexes ops over its stdio.
Length-prefixed JSON in both directions; handles request/reply correlation
plus async events (data / prompt_visible / exit).
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
from collections.abc import Awaitable, Callable
from itertools import count
from pathlib import Path
from typing import Any

from .log import get_logger
from .protocol import FrameDecoder, encode

log = get_logger("bridge")

EventHandler = Callable[[dict[str, Any]], Awaitable[None] | None]


class BridgeError(RuntimeError):
    """Raised when the bridge replies with ok=false or terminates unexpectedly."""


class Bridge:
    """Long-lived Node pty-bridge subprocess.

    Use ``await Bridge.start(...)`` to spawn, ``await call(op, args)`` for
    request/reply ops, and ``add_event_handler`` to subscribe to async events
    emitted by the bridge (data / prompt_visible / exit).
    """

    def __init__(self) -> None:
        self._proc: asyncio.subprocess.Process | None = None
        self._dec = FrameDecoder()
        self._next_id = count(1)
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._event_handlers: list[EventHandler] = []
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._closed = False

    @classmethod
    async def start(cls, bridge_js: Path | None = None) -> "Bridge":
        b = cls()
        await b._spawn(bridge_js)
        return b

    async def _spawn(self, bridge_js: Path | None) -> None:
        path = bridge_js or self._default_bridge_path()
        if not path.exists():
            raise BridgeError(
                f"pty-bridge entry not found at {path}. Did you run `npm run build`?"
            )
        node = shutil.which("node")
        if node is None:
            raise BridgeError("`node` not on PATH")
        log.info("spawning bridge", path=str(path), node=node)
        self._proc = await asyncio.create_subprocess_exec(
            node,
            str(path),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._reader_task = asyncio.create_task(self._read_loop(), name="bridge-reader")
        self._stderr_task = asyncio.create_task(self._drain_stderr(), name="bridge-stderr")
        # Wait until the worker emits its "ready" stderr line, or the first ping replies.
        await self.call("ping", {})
        log.info("bridge ready")

    @staticmethod
    def _default_bridge_path() -> Path:
        env = os.environ.get("CLAUDE_PUPPET_BRIDGE")
        if env:
            return Path(env)
        # repo-relative resolution: server/bridge.py → ../pty-bridge/dist/index.js
        return Path(__file__).resolve().parent.parent / "pty-bridge" / "dist" / "index.js"

    async def _read_loop(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            while True:
                chunk = await self._proc.stdout.read(65536)
                if not chunk:
                    break
                for frame in self._dec.push(chunk):
                    self._handle_frame(frame)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("bridge reader crashed")
        finally:
            self._fail_pending(BridgeError("bridge stdout closed"))
            self._closed = True

    async def _drain_stderr(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        try:
            while True:
                line = await self._proc.stderr.readline()
                if not line:
                    break
                # Forward to our stderr at debug level; users see it via CLAUDE_PUPPET_LOG.
                sys.stderr.write(f"[pty-bridge] {line.decode('utf-8', 'replace').rstrip()}\n")
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("bridge stderr drain crashed")

    def _handle_frame(self, frame: dict[str, Any]) -> None:
        if "event" in frame:
            for h in self._event_handlers:
                res = h(frame)
                if asyncio.iscoroutine(res):
                    asyncio.create_task(res)
            return
        # Reply
        rid = frame.get("id")
        if not isinstance(rid, int):
            return
        fut = self._pending.pop(rid, None)
        if fut is None:
            return
        if frame.get("ok"):
            fut.set_result(frame.get("result"))
        else:
            fut.set_exception(BridgeError(str(frame.get("error", "unknown error"))))

    def _fail_pending(self, exc: BaseException) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    def add_event_handler(self, handler: EventHandler) -> None:
        self._event_handlers.append(handler)

    async def call(self, op: str, args: dict[str, Any], *, timeout: float | None = 30.0) -> Any:
        if self._closed or self._proc is None or self._proc.stdin is None:
            raise BridgeError("bridge not running")
        rid = next(self._next_id)
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        frame = encode({"id": rid, "op": op, "args": args})
        self._proc.stdin.write(frame)
        await self._proc.stdin.drain()
        try:
            if timeout is None:
                return await fut
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(rid, None)
            raise BridgeError(f"bridge call {op!r} timed out after {timeout}s")

    async def close(self, timeout: float = 5.0) -> None:
        if self._proc is None:
            return
        try:
            if self._proc.stdin is not None:
                self._proc.stdin.close()
        except Exception:
            pass
        try:
            await asyncio.wait_for(self._proc.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            log.warning("bridge graceful close timed out — sending SIGTERM")
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                log.warning("bridge SIGTERM timed out — sending SIGKILL")
                self._proc.kill()
                await self._proc.wait()
        if self._reader_task is not None:
            self._reader_task.cancel()
        if self._stderr_task is not None:
            self._stderr_task.cancel()
        self._closed = True
