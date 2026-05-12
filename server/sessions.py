"""Per-slave HOME isolation, environment scrub, permission-mode → argv.

Each slave gets its own ``$HOME`` under ``~/.cache/claude-puppet/sessions/<id>/home``
with a real writable ``.claude/`` subtree.

- ``.credentials.json`` is **copied** (not symlinked) from the master's real
  ``~/.claude/`` and chmod'd 0o600. We re-sync this copy from master each time
  the slave is about to do work (see ``sync_credentials_from_master``); without
  that re-sync the slave's local copy goes stale after the master rotates the
  OAuth refresh token, and the slave's eventual refresh attempt 401s with the
  master's now-invalidated old refresh token.
- ``settings.json`` is symlinked (not a secret; master changes should propagate).
- Everything mutable (``projects/``, ``sessions/``, ``history.jsonl``, etc.) is
  private per slave to avoid cross-slave races.
"""

from __future__ import annotations

import os
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from .log import get_logger

log = get_logger("sessions")

PermissionMode = Literal["strict", "acceptEdits", "plan", "yolo"]
VALID_MODES: tuple[PermissionMode, ...] = ("strict", "acceptEdits", "plan", "yolo")

# Permissiveness ranking; higher = more permissive. Child must be <= parent.
PERMISSION_RANK: dict[str, int] = {"plan": 0, "strict": 1, "acceptEdits": 2, "yolo": 3}

# Session id must start with [A-Za-z0-9_] (no leading hyphen → blocks CLI-flag
# injection) and contain only ASCII alphanum / hyphen / underscore. Length is
# capped separately at the call site so the error message can be specific.
_SID_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]*$")

# HTTP endpoint at which the always-on daemon serves the puppet MCP. Slaves
# granted nested mastery dial back into this same daemon.
PUPPET_MCP_URL = "http://localhost:5056/mcp"


def assert_permission_monotonic(parent_mode: str, child_mode: str) -> None:
    """Reject child_mode more permissive than parent_mode."""
    if parent_mode not in PERMISSION_RANK:
        raise ValueError(f"unknown parent permission_mode {parent_mode!r}")
    if child_mode not in PERMISSION_RANK:
        raise ValueError(f"unknown child permission_mode {child_mode!r}")
    if PERMISSION_RANK[child_mode] > PERMISSION_RANK[parent_mode]:
        raise ValueError(
            f"permission monotonicity: child {child_mode!r} more permissive than parent {parent_mode!r}"
        )

# Env vars to strip from inherited env before launching a slave. CLAUDECODE etc.
# are set when running inside Claude Code; we don't want a recursive slave to
# inherit them and gate its own behavior on "I'm inside Claude Code".
SCRUB_ENV_PREFIXES = ("CLAUDECODE", "CLAUDE_CODE_", "CLAUDE_AGENT_")
SCRUB_ENV_EXACT = ("NO_COLOR", "CI")

# Hard-set env on slave (after scrub). HOME is set per session.
TERMINAL_ENV = {
    "TERM": "xterm-256color",
    "COLORTERM": "truecolor",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "FORCE_COLOR": "3",
}

DEFAULT_COLS = 200
DEFAULT_ROWS = 50

# Where session HOME dirs live.
def cache_root() -> Path:
    base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    root = Path(base) / "claude-puppet" / "sessions"
    root.mkdir(parents=True, exist_ok=True)
    return root


@dataclass
class SessionSpec:
    """Resolved spec for spawning one slave."""

    id: str
    cwd: str
    permission_mode: PermissionMode
    allowed_tools: list[str] | None
    env: dict[str, str]
    cols: int
    rows: int
    home: Path
    transcript_dir: Path
    cmd: str
    cmd_args: list[str]
    mcp_servers: dict[str, Any] | None = None
    opened_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    parent_id: str | None = None
    depth: int = 0
    max_depth: int = 3
    nested_puppetry: bool = False


class SessionRegistry:
    """In-process registry of active slaves.

    The actual PTY + Terminal lives in the Node bridge; this just tracks
    metadata so the master-facing tools can answer ``list_sessions`` etc.
    """

    def __init__(self) -> None:
        self._by_id: dict[str, SessionSpec] = {}

    def register(self, spec: SessionSpec) -> None:
        self._by_id[spec.id] = spec

    def get(self, sid: str) -> SessionSpec | None:
        return self._by_id.get(sid)

    def remove(self, sid: str) -> SessionSpec | None:
        return self._by_id.pop(sid, None)

    def all(self) -> list[SessionSpec]:
        return list(self._by_id.values())


def _claude_binary() -> str:
    """Resolve the slave `claude` binary path. Override via CLAUDE_PUPPET_CLAUDE."""
    override = os.environ.get("CLAUDE_PUPPET_CLAUDE")
    if override:
        return override
    found = shutil.which("claude")
    if not found:
        raise RuntimeError("`claude` CLI not found on PATH; set CLAUDE_PUPPET_CLAUDE to override")
    return found


def _build_argv(
    permission_mode: PermissionMode,
    allowed_tools: list[str] | None,
    mcp_config_path: Path,
) -> list[str]:
    """Assemble the slave's claude argv from permission mode and allow-list."""
    argv: list[str] = []
    if permission_mode == "acceptEdits":
        argv += ["--permission-mode", "acceptEdits"]
    elif permission_mode == "plan":
        argv += ["--permission-mode", "plan"]
    elif permission_mode == "yolo":
        argv += ["--dangerously-skip-permissions"]
    elif permission_mode == "strict":
        pass  # default
    else:
        raise ValueError(f"unknown permission_mode {permission_mode!r}")

    if allowed_tools:
        # `--allowedTools` accepts a single space-separated string in Claude CLI.
        argv += ["--allowedTools", " ".join(allowed_tools)]

    # Strict empty MCP config by default — prevents recursive load of claude-puppet
    # in the slave. Per-session opt-in via mcp_servers param writes a real config.
    argv += ["--strict-mcp-config", "--mcp-config", str(mcp_config_path)]

    return argv


def _build_env(user_env: dict[str, str] | None, home: Path) -> dict[str, str]:
    """Build the slave's env: parent env minus scrubs, plus terminal/HOME overrides."""
    env: dict[str, str] = {}
    for k, v in os.environ.items():
        if any(k.startswith(p) for p in SCRUB_ENV_PREFIXES):
            continue
        if k in SCRUB_ENV_EXACT:
            continue
        env[k] = v
    env.update(TERMINAL_ENV)
    env["HOME"] = str(home)
    if user_env:
        env.update(user_env)
    return env


def _atomic_copy_credentials(src: Path, dst: Path) -> None:
    """Copy `src` to `dst` atomically (write temp + os.replace) at mode 0o600.

    Atomicity matters because the slave's `claude` may concurrently open `dst`
    to read its OAuth tokens; a non-atomic write (truncate+rewrite) could
    expose a half-written file. ``os.replace`` swaps the directory entry in a
    single syscall — readers either see the old inode in full or the new inode
    in full, never a partial write.
    """
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    try:
        shutil.copyfile(src, tmp)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, dst)
    finally:
        # Clean up the temp file if os.replace didn't consume it (e.g. on error).
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


def sync_credentials_from_master(home: Path) -> bool:
    """Refresh `<home>/.claude/.credentials.json` from master if master is newer.

    The slave keeps a private *copy* of master's credentials (so each slave gets
    its own 0o600 file). When master's `claude` rotates the OAuth refresh token
    (every few hours under normal use), the slave's copy goes stale: the
    slave's own refresh attempt then sends master's *old, now-invalidated*
    refresh token and the auth server replies 401. The slave has no way to
    self-recover — it needs us to push the new refresh token into its HOME.

    This function is the push. It is safe to call repeatedly and from any path
    that knows the slave's HOME; it no-ops if master's file is missing or
    already <= slave's mtime.

    Returns True iff a sync actually happened.
    """
    try:
        master_dir = _master_claude_dir()
        creds_src = master_dir / ".credentials.json"
        creds_dst = home / ".claude" / ".credentials.json"
        if not creds_src.exists():
            return False
        # Ensure slave's .claude/ exists (defensive — should already by spawn time).
        creds_dst.parent.mkdir(parents=True, exist_ok=True)
        if not creds_dst.exists():
            _atomic_copy_credentials(creds_src, creds_dst)
            return True
        try:
            src_mtime = creds_src.stat().st_mtime_ns
            dst_mtime = creds_dst.stat().st_mtime_ns
        except OSError:
            return False
        if src_mtime > dst_mtime:
            _atomic_copy_credentials(creds_src, creds_dst)
            return True
        return False
    except OSError as e:
        # Never raise from a credential-sync best-effort path; the caller wants
        # the slave operation to proceed even if the sync fails.
        log.warning("could not sync credentials from master: %s", e)
        return False


def _materialize_home(home: Path, master_claude_dir: Path) -> None:
    """Create per-session HOME with a real .claude/ subtree.

    Credentials are COPIED (not symlinked) and chmod'd 0o600 so sibling slaves
    can't read each other's bearer tokens, and so the slave's claude-code can
    safely write a refreshed token back without clobbering master's file or
    breaking a shared symlink for sibling slaves. Settings is symlinked since
    it's not a secret and master changes should propagate. The HOME and
    .claude/ dirs are 0o700 so other slaves can't traverse into them.

    The credentials copy is a snapshot; over a long-lived slave it goes stale
    when master rotates the OAuth refresh token. Re-syncing happens at runtime
    via ``sync_credentials_from_master`` — see that function and the callers
    in ``mcp_server.py``.
    """
    home.mkdir(parents=True, exist_ok=True)
    # Tighten so other slaves (sibling sessions/<id>/home) can't read this one.
    try:
        os.chmod(home, 0o700)
    except OSError:
        pass
    claude_dir = home / ".claude"
    claude_dir.mkdir(exist_ok=True)
    try:
        os.chmod(claude_dir, 0o700)
    except OSError:
        pass

    # Credentials: COPY (not symlink) so each slave has a private copy at 0o600.
    # On session create we always sync (overwriting any pre-existing slave copy
    # from a prior run of the same id) so the slave starts with master's
    # current refresh token. Atomic so a concurrent reader can't tear the read.
    creds_src = master_claude_dir / ".credentials.json"
    creds_dst = claude_dir / ".credentials.json"
    if creds_src.exists():
        try:
            _atomic_copy_credentials(creds_src, creds_dst)
        except OSError as e:
            log.warning("could not copy credentials: %s", e)

    # Settings: symlink is fine — not a secret, master changes should propagate.
    settings_src = master_claude_dir / "settings.json"
    settings_dst = claude_dir / "settings.json"
    if not settings_dst.exists() and not settings_dst.is_symlink() and settings_src.exists():
        try:
            settings_dst.symlink_to(settings_src)
        except OSError as e:
            log.warning("could not symlink settings: %s", e)
    # Pre-create writable subdirs so first slave write doesn't race with another.
    for sub in ("projects", "sessions", "shell-snapshots", "paste-cache", "telemetry", "backups"):
        (claude_dir / sub).mkdir(exist_ok=True)
    # Real file at $HOME/.claude.json (NOT inside .claude/) — copy master's if present
    user_state = home / ".claude.json"
    if not user_state.exists():
        master_state = Path(os.path.expanduser("~")) / ".claude.json"
        if master_state.exists():
            shutil.copyfile(master_state, user_state)
        else:
            user_state.write_text("{}\n")


def _write_mcp_config(
    home: Path,
    mcp_servers: dict[str, Any] | None,
) -> Path:
    """Write the slave's MCP config file with the puppet entry always present.

    The slave's claude reads MCP config at process startup; it does not
    hot-reload. To make nested-puppetry runtime-mutable (master can grant
    or revoke a slave's sub-spawn capability without restarting the slave),
    we always load the puppet MCP server into the slave. The actual
    authorization lives server-side: open_session(parent_id=...) checks the
    parent's nested_puppetry flag and rejects unauthorized callers. Toggle
    that flag via the set_nested_puppetry tool.
    """
    servers: dict[str, Any] = {
        "claude-puppet": {"type": "http", "url": PUPPET_MCP_URL}
    }
    if mcp_servers:
        # Caller-provided MCP servers can override anything EXCEPT the puppet
        # entry — that one is managed by the daemon and we don't let masters
        # shadow it (would break the gate).
        for k, v in mcp_servers.items():
            if k == "claude-puppet":
                continue
            servers[k] = v
    config = {"mcpServers": servers}
    path = home / ".claude" / "mcp-config.json"
    import json

    path.write_text(json.dumps(config, indent=2))
    return path


def _master_claude_dir() -> Path:
    """Where the *parent* (master) Claude's .claude/ lives.

    We resolve this from the *real* user $HOME, which may differ from anything
    the master tries to override. Falls back to ~/.claude.
    """
    real_home = Path(os.path.expanduser("~"))
    return real_home / ".claude"


def spec_from_db_row(row: dict[str, Any]) -> SessionSpec:
    """Rebuild a SessionSpec from a persisted DB row (no env reconstruction)."""
    import json as _json

    return SessionSpec(
        id=row["id"],
        cwd=row["cwd"],
        permission_mode=row["permission_mode"],
        allowed_tools=None,
        env={},
        cols=int(row["cols"]),
        rows=int(row["rows"]),
        home=Path(row["home"]),
        transcript_dir=Path(row["transcript_dir"]),
        cmd=row["cmd"],
        cmd_args=_json.loads(row["cmd_args"]),
        mcp_servers=None,
        opened_at_ms=int(row["created_at_ms"]),
        parent_id=row.get("parent_id"),
        depth=int(row.get("depth") or 0),
        max_depth=int(row.get("max_depth") or 3),
        nested_puppetry=bool(row.get("nested_puppetry") or 0),
    )


def build_spec(
    *,
    sid: str,
    cwd: str,
    permission_mode: PermissionMode = "strict",
    allowed_tools: list[str] | None = None,
    env: dict[str, str] | None = None,
    cols: int = DEFAULT_COLS,
    rows: int = DEFAULT_ROWS,
    mcp_servers: dict[str, Any] | None = None,
    parent_id: str | None = None,
    depth: int = 0,
    max_depth: int = 3,
    nested_puppetry: bool = False,
) -> SessionSpec:
    if permission_mode not in VALID_MODES:
        raise ValueError(f"permission_mode must be one of {VALID_MODES}, got {permission_mode!r}")
    if not sid or len(sid) > 64 or not _SID_RE.match(sid):
        raise ValueError(
            f"session id must be 1-64 chars of [A-Za-z0-9_-] and must not start with '-', got {sid!r}"
        )
    if cols < 20 or cols > 1000 or rows < 5 or rows > 200:
        raise ValueError(f"unreasonable cols/rows: {cols}x{rows}")
    if not isinstance(cwd, str) or not cwd.strip():
        raise ValueError(f"cwd must be a non-empty path, got {cwd!r}")
    if not Path(cwd).is_dir():
        raise ValueError(f"cwd does not exist or is not a directory: {cwd!r}")

    home = cache_root() / sid / "home"
    transcript_dir = cache_root() / sid / "transcripts"
    home.mkdir(parents=True, exist_ok=True)
    transcript_dir.mkdir(parents=True, exist_ok=True)
    _materialize_home(home, _master_claude_dir())
    mcp_config_path = _write_mcp_config(home, mcp_servers)

    cmd = _claude_binary()
    cmd_args = _build_argv(permission_mode, allowed_tools, mcp_config_path)
    full_env = _build_env(env, home)

    return SessionSpec(
        id=sid,
        cwd=cwd,
        permission_mode=permission_mode,
        allowed_tools=allowed_tools,
        env=full_env,
        cols=cols,
        rows=rows,
        home=home,
        transcript_dir=transcript_dir,
        cmd=cmd,
        cmd_args=cmd_args,
        mcp_servers=mcp_servers,
        parent_id=parent_id,
        depth=int(depth),
        max_depth=int(max_depth),
        nested_puppetry=bool(nested_puppetry),
    )
