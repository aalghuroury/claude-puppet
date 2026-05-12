"""Idle / prompt-visible heuristics over bridge snapshots."""

from __future__ import annotations

import time
from typing import Any

PROMPT_GLYPHS = (">", "│ >", "❯", "?")
BOTTOM_LINES = 4


def _now_ms() -> int:
    return int(time.time() * 1000)


def _cursor_in_bottom(snapshot: dict[str, Any]) -> bool:
    cur = snapshot.get("cursor") or {}
    row = int(cur.get("row", 0))
    rows = int(snapshot.get("rows", 0))
    if rows <= 0:
        return False
    return row >= max(0, rows - BOTTOM_LINES)


def _last_non_empty_line(text: str) -> str:
    for line in reversed(text.splitlines()):
        if line.strip():
            return line
    return ""


def looks_like_prompt(snapshot: dict[str, Any]) -> bool:
    """Loose detector for 'input prompt visible'."""
    last_prompt = snapshot.get("lastPromptAtMs")
    if isinstance(last_prompt, int) and (_now_ms() - last_prompt) <= 5000:
        return True
    if not _cursor_in_bottom(snapshot):
        return False
    line = _last_non_empty_line(snapshot.get("text", "") or "")
    return any(g in line for g in PROMPT_GLYPHS)


def is_idle(snapshot: dict[str, Any], history: list[dict[str, Any]], stable_ms: int = 600) -> bool:
    """True if the rendered buffer hash has been stable for >= stable_ms."""
    if not history or len(history) < 2:
        return False
    cur_hash = snapshot.get("hash")
    if cur_hash is None:
        return False
    if any(h.get("hash") != cur_hash for h in history):
        return False
    span = history[-1].get("ts", 0) - history[0].get("ts", 0)
    if span < stable_ms:
        return False
    return True


def compute_idle_metrics(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Metadata fields surfaced by the read_screen tool."""
    return {
        "idle_since_ms": int(snapshot.get("idleSinceMs", 0) or 0),
        "last_prompt_at_ms": snapshot.get("lastPromptAtMs"),
        "looks_like_prompt": looks_like_prompt(snapshot),
    }


def hash_history_push(
    history: list[dict[str, Any]], snapshot: dict[str, Any], max_len: int = 32
) -> None:
    """Append the snapshot's hash + current ts to history; trim to max_len."""
    history.append({"ts": _now_ms(), "hash": snapshot.get("hash")})
    if len(history) > max_len:
        del history[: len(history) - max_len]
