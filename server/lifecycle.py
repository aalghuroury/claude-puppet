"""Signal handlers and shutdown cascade for the MCP parent."""

from __future__ import annotations

import asyncio
import atexit
import signal
import sys
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from .log import get_logger

if TYPE_CHECKING:
    from .bridge import Bridge
    from .sessions import SessionRegistry

log = get_logger("lifecycle")

_shutdown_called = False
_SHUTDOWN_TIMEOUT = 10.0


def install_handlers(
    loop: asyncio.AbstractEventLoop, on_shutdown: Callable[[], Awaitable[None]]
) -> None:
    """Register SIGTERM/SIGINT + atexit handlers that invoke on_shutdown once."""

    def _trigger(signame: str) -> None:
        global _shutdown_called
        if _shutdown_called:
            return
        _shutdown_called = True
        log.info("signal received, shutting down", signal=signame)
        loop.create_task(_run_with_timeout(on_shutdown))

    if sys.platform != "win32":
        for sig, name in ((signal.SIGTERM, "SIGTERM"), (signal.SIGINT, "SIGINT")):
            try:
                loop.add_signal_handler(sig, _trigger, name)
            except (NotImplementedError, RuntimeError) as e:
                log.warning("could not install signal handler", signal=name, error=str(e))

    def _atexit() -> None:
        global _shutdown_called
        if _shutdown_called:
            return
        _shutdown_called = True
        try:
            running = loop.is_running() and not loop.is_closed()
        except Exception:
            running = False
        if running:
            return
        log.info("atexit shutdown")
        try:
            asyncio.run(_run_with_timeout(on_shutdown))
        except Exception:
            log.exception("atexit shutdown failed")

    atexit.register(_atexit)


async def _run_with_timeout(on_shutdown: Callable[[], Awaitable[None]]) -> None:
    try:
        await asyncio.wait_for(on_shutdown(), timeout=_SHUTDOWN_TIMEOUT)
    except asyncio.TimeoutError:
        log.warning("shutdown exceeded timeout", timeout=_SHUTDOWN_TIMEOUT)
    except Exception:
        log.exception("shutdown handler raised")


async def shutdown_cascade(
    bridge: "Bridge",
    registry: "SessionRegistry",
    *,
    per_session_timeout: float = 5.0,
    bridge_timeout: float = 5.0,
) -> None:
    """Close every session, then the bridge. Errors are logged, never raised."""
    sessions = registry.all()
    log.info("shutdown cascade starting", sessions=len(sessions))
    for spec in sessions:
        sid = spec.id
        try:
            await asyncio.wait_for(bridge.call("close", {"id": sid}), timeout=per_session_timeout)
            log.info("session closed", id=sid)
        except asyncio.TimeoutError:
            log.warning("session close timed out", id=sid, timeout=per_session_timeout)
        except Exception as e:
            log.warning("session close failed", id=sid, error=str(e))
        finally:
            registry.remove(sid)
    try:
        await bridge.close(timeout=bridge_timeout)
        log.info("bridge closed")
    except Exception:
        log.exception("bridge close failed")
