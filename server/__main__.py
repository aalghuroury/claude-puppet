"""Entrypoint: spawn the Node bridge and serve MCP.

Two transport modes, picked by env:

- ``CLAUDE_PUPPET_PORT`` set → streamable-HTTP transport on that port.
  Used when the server runs as an always-on daemon (systemd) and master
  Claude sessions connect to it over HTTP.
- otherwise → stdio. Used when master Claude spawns the server per-session.
"""

from __future__ import annotations

import asyncio
import os

from . import db
from . import log as log_mod
from . import mcp_server
from .bridge import Bridge
from .lifecycle import install_handlers, shutdown_cascade
from .log import get_logger

log = get_logger("main")


async def _run() -> None:
    db.init_db()
    n = db.mark_crashed_all_alive(reason="daemon_restart")
    if n:
        log.info("marked sessions crashed on startup", count=n)
    bridge = await Bridge.start()
    mcp_server.set_bridge(bridge)
    loop = asyncio.get_running_loop()

    async def _on_shutdown() -> None:
        await shutdown_cascade(bridge, mcp_server._registry)

    install_handlers(loop, on_shutdown=_on_shutdown)

    http_port_env = os.environ.get("CLAUDE_PUPPET_PORT")
    try:
        if http_port_env:
            host = os.environ.get("CLAUDE_PUPPET_HOST", "127.0.0.1")
            port = int(http_port_env)
            mcp_server.mcp.settings.host = host
            mcp_server.mcp.settings.port = port
            log.info("serving streamable-http", host=host, port=port,
                     path=mcp_server.mcp.settings.streamable_http_path)
            await mcp_server.mcp.run_streamable_http_async()
        else:
            await mcp_server.mcp.run_stdio_async()
    except (asyncio.CancelledError, KeyboardInterrupt):
        pass
    finally:
        await shutdown_cascade(bridge, mcp_server._registry)


def main() -> None:
    log_mod.configure()
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
