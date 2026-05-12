"""Length-prefixed JSON framing — mirror of pty-bridge/src/protocol.ts.

Newline framing is unsafe (raw PTY bytes contain \\n). Each frame is u32-LE length
followed by UTF-8 JSON of that length.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from typing import Any, Literal


# ---- Op / Reply / Event shapes (typed loosely as dicts; Node validates) ----

OpName = Literal["open", "write", "resize", "snapshot", "signal", "close", "list_sessions", "ping"]
PermissionMode = Literal["strict", "acceptEdits", "plan", "yolo"]
SignalKind = Literal["ctrl-c", "sigint", "sigterm", "sigkill", "ladder"]


@dataclass
class Reply:
    id: int
    ok: bool
    result: Any | None = None
    error: str | None = None


def encode(obj: dict[str, Any]) -> bytes:
    """Encode a single frame: u32-LE length + utf-8 JSON."""
    payload = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(payload)) + payload


class FrameDecoder:
    """Streaming decoder for length-prefixed JSON. Push bytes, get a list of decoded frames."""

    def __init__(self) -> None:
        self._buf = bytearray()

    def push(self, chunk: bytes) -> list[dict[str, Any]]:
        if chunk:
            self._buf.extend(chunk)
        out: list[dict[str, Any]] = []
        while len(self._buf) >= 4:
            (length,) = struct.unpack("<I", bytes(self._buf[:4]))
            if len(self._buf) < 4 + length:
                break
            payload = bytes(self._buf[4 : 4 + length])
            del self._buf[: 4 + length]
            try:
                out.append(json.loads(payload.decode("utf-8")))
            except (UnicodeDecodeError, json.JSONDecodeError):
                # Drop malformed frame; keep going.
                continue
        return out
