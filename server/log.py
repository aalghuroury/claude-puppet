"""Structured logging via structlog.

We log to stderr only — stdout is reserved for MCP traffic to the master Claude.
"""

from __future__ import annotations

import logging
import os
import sys

import structlog


def configure(level: str | None = None) -> None:
    lvl = (level or os.environ.get("CLAUDE_PUPPET_LOG", "INFO")).upper()
    logging.basicConfig(
        level=getattr(logging, lvl, logging.INFO),
        format="%(message)s",
        stream=sys.stderr,
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.dev.ConsoleRenderer(colors=False),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, lvl, logging.INFO)),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str = "claude-puppet") -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
