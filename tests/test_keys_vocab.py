"""Cross-check Node's key-name vocabulary so the Python side stays in lockstep."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

EXPECTED_MIN = [
    "<enter>", "<return>", "<tab>", "<bs>", "<esc>", "<space>",
    "<up>", "<down>", "<left>", "<right>",
    "<s-up>", "<s-down>", "<s-left>", "<s-right>",
    "<home>", "<end>", "<pageup>", "<pagedown>", "<insert>", "<del>",
    "<f1>", "<f5>", "<f12>",
    "<s-tab>",
    "<paste-start>", "<paste-end>",
    "<c-a>", "<c-c>", "<c-z>",
    "<c-@>", "<c-?>",
]


def _bridge_keys_path() -> Path:
    return Path(__file__).resolve().parents[1] / "pty-bridge" / "dist" / "keys.js"


def _dump_keys() -> list[str]:
    bridge = _bridge_keys_path()
    if not bridge.exists():
        pytest.skip(f"pty-bridge not built; run `npm run build` in {bridge.parent.parent}")
    out = subprocess.check_output(
        [
            "node",
            "-e",
            f"import('{bridge.as_posix()}').then(m => process.stdout.write(JSON.stringify(m.knownNames())))",
        ],
        timeout=15,
    )
    return json.loads(out.decode())


def test_known_names_includes_minimum() -> None:
    names = set(_dump_keys())
    missing = [n for n in EXPECTED_MIN if n not in names]
    assert not missing, f"vocab regressed; missing: {missing}"


def test_resolve_arrow_via_node() -> None:
    bridge = _bridge_keys_path()
    if not bridge.exists():
        pytest.skip("not built")
    out = subprocess.check_output(
        [
            "node",
            "-e",
            f"import('{bridge.as_posix()}').then(m => process.stdout.write(m.resolveToken('<Up>').bytes))",
        ],
        timeout=15,
    )
    assert out == b"\x1b[A"
