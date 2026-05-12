#!/usr/bin/env bash
# claude-puppet installer
#
# Reproduces the maintainer's working setup exactly:
#   - MCP server registered as HTTP in ~/.claude.json under
#     mcpServers.claude-puppet -> {type: http, url: http://localhost:5056/mcp}
#   - claude-puppet-mcp.service + claude-puppet-dashboard.service installed
#     as systemd user units (enabled + started)
#   - SKILL.md copied to ~/.claude/skills/claude-puppet/ so any master claude
#     auto-loads it when it hears puppet trigger phrases
#   - Hook helpers copied to ~/.claude/hooks/ (puppet-{flush,peek,drain}.sh)
#   - ENABLE_EXPERIMENTAL_MCP_CLI set in ~/.claude/settings.json
#
# After this completes, a fresh master claude session asking
#   "spawn a slave claude in /tmp/demo, write fizzbuzz, then close it"
# will (a) auto-load the SKILL, (b) propose open_session via the MCP tools,
# (c) talk to the puppet daemon at :5056. Identical to the maintainer's box.
#
# Flags (defaults are "match this device" — change only if you need to):
#   --stdio              stdio MCP instead of HTTP daemon (no :5056 server)
#   --no-services        skip systemd user units (only useful with --stdio
#                        or when the services are managed externally)
#   --wire-drain-hook    auto-prepend fresh slave events to every master
#                        prompt via hooks.UserPromptSubmit (OPT-IN — the
#                        maintainer's box does NOT have this wired)
#   --force              overwrite an existing SKILL / hooks / MCP entry
#
# Idempotent: re-running is safe.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CLAUDE_DIR="${HOME}/.claude"
SKILLS_DIR="${CLAUDE_DIR}/skills/claude-puppet"
HOOKS_DIR="${CLAUDE_DIR}/hooks"
SETTINGS_PATH="${CLAUDE_DIR}/settings.json"
CLAUDE_JSON_PATH="${HOME}/.claude.json"

USE_HTTP=1
INSTALL_SERVICES=1
WIRE_DRAIN_HOOK=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stdio) USE_HTTP=0; shift ;;
    --no-services) INSTALL_SERVICES=0; shift ;;
    --http) USE_HTTP=1; shift ;;   # kept for explicitness; default anyway
    --services) INSTALL_SERVICES=1; shift ;;
    --wire-drain-hook) WIRE_DRAIN_HOOK=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help)
      sed -n '1,33p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]   \033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[error]  \033[0m %s\n' "$*" >&2; }

# ---- 0. Prerequisites ------------------------------------------------------
log "Checking prerequisites…"
missing=()
for cmd in uv node npm python3; do
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  err "missing prerequisites: ${missing[*]}"
  err "  uv:   curl -LsSf https://astral.sh/uv/install.sh | sh"
  err "  node: see https://nodejs.org or your package manager"
  exit 1
fi

# ---- 1. Build pty-bridge ---------------------------------------------------
log "Building pty-bridge…"
( cd "$REPO_ROOT/pty-bridge" && npm install --silent && npm run build --silent )

# ---- 2. Python deps --------------------------------------------------------
log "uv sync …"
( cd "$REPO_ROOT" && uv sync --quiet )

# ---- 3. SKILL.md -----------------------------------------------------------
mkdir -p "$SKILLS_DIR"
if [[ -f "$SKILLS_DIR/SKILL.md" && "$FORCE" -eq 0 ]]; then
  warn "skill exists at $SKILLS_DIR/SKILL.md — pass --force to overwrite"
else
  cp "$REPO_ROOT/skill/SKILL.md" "$SKILLS_DIR/SKILL.md"
  log "Installed skill -> $SKILLS_DIR/SKILL.md"
fi

# ---- 4. Hooks --------------------------------------------------------------
mkdir -p "$HOOKS_DIR"
for h in puppet-flush.sh puppet-peek.sh puppet-drain.sh; do
  dst="$HOOKS_DIR/$h"
  if [[ -f "$dst" && "$FORCE" -eq 0 ]]; then
    warn "hook exists: $dst (skipped)"
  else
    install -m 755 "$REPO_ROOT/hooks/$h" "$dst"
    log "Installed hook -> $dst"
  fi
done

# ---- 5. Register MCP server in ~/.claude.json ------------------------------
# Claude Code loads MCP servers from ~/.claude.json (NOT ~/.claude/settings.json).
# We only touch the mcpServers.claude-puppet sub-key — everything else
# (userID, projects, theme, …) is left untouched.
log "Registering mcpServers.claude-puppet in $CLAUDE_JSON_PATH…"
python3 - "$CLAUDE_JSON_PATH" "$REPO_ROOT" "$USE_HTTP" "$FORCE" <<'PY'
import json, sys
from pathlib import Path

path = Path(sys.argv[1])
repo_root = sys.argv[2]
use_http = sys.argv[3] == "1"
force = sys.argv[4] == "1"

data = json.loads(path.read_text()) if path.exists() else {}
servers = data.setdefault("mcpServers", {})

if use_http:
    entry = {"type": "http", "url": "http://localhost:5056/mcp"}
    mode = "HTTP (:5056/mcp)"
else:
    entry = {
        "command": "uv",
        "args": ["run", "--project", repo_root, "python", "-m", "server"],
        "env": {},
    }
    mode = "stdio (uv run -m server)"

existing = servers.get("claude-puppet")
if existing and not force:
    # Preserve usageCount/lastUsedAt etc. Only update transport-relevant keys.
    transport_keys = {"type", "url", "command", "args", "env"}
    drift = {k: v for k, v in entry.items()
             if existing.get(k) != v}
    if drift:
        # Update transport keys, preserve metadata fields
        merged = {k: v for k, v in existing.items() if k not in transport_keys}
        merged.update(entry)
        servers["claude-puppet"] = merged
        path.write_text(json.dumps(data, indent=2))
        print(f"[install] mcpServers.claude-puppet transport updated -> {mode}")
    else:
        print(f"[install] mcpServers.claude-puppet already matches ({mode})")
else:
    servers["claude-puppet"] = entry
    path.write_text(json.dumps(data, indent=2))
    print(f"[install] mcpServers.claude-puppet -> {mode}")
PY

# ---- 6. ENABLE_EXPERIMENTAL_MCP_CLI in ~/.claude/settings.json -------------
log "Setting env.ENABLE_EXPERIMENTAL_MCP_CLI in $SETTINGS_PATH…"
mkdir -p "$CLAUDE_DIR"
python3 - "$SETTINGS_PATH" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
data = json.loads(path.read_text()) if path.exists() else {}
env = data.setdefault("env", {})
if env.get("ENABLE_EXPERIMENTAL_MCP_CLI") == "true":
    print("[install] ENABLE_EXPERIMENTAL_MCP_CLI already set")
else:
    env["ENABLE_EXPERIMENTAL_MCP_CLI"] = "true"
    path.write_text(json.dumps(data, indent=2))
    print("[install] env.ENABLE_EXPERIMENTAL_MCP_CLI = true")
PY

# ---- 7. systemd user services ----------------------------------------------
if [[ "$INSTALL_SERVICES" -eq 1 ]]; then
  log "Installing claude-puppet-{mcp,dashboard}.service via install-services.sh…"
  bash "$REPO_ROOT/scripts/install-services.sh" install
else
  warn "skipping systemd services (--no-services)"
fi

# ---- 8. Optional UserPromptSubmit hook -------------------------------------
if [[ "$WIRE_DRAIN_HOOK" -eq 1 ]]; then
  log "Wiring puppet-drain.sh into hooks.UserPromptSubmit (settings.json)…"
  python3 - "$SETTINGS_PATH" "$HOOKS_DIR/puppet-drain.sh" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
cmd  = sys.argv[2]
data = json.loads(path.read_text()) if path.exists() else {}
ups  = data.setdefault("hooks", {}).setdefault("UserPromptSubmit", [])
if any((isinstance(e, dict) and e.get("command") == cmd) or e == cmd for e in ups):
    print("[install] hooks.UserPromptSubmit already wired")
else:
    ups.append({"command": cmd})
    path.write_text(json.dumps(data, indent=2))
    print(f"[install] hooks.UserPromptSubmit += {cmd}")
PY
fi

# ---- 9. Verify -------------------------------------------------------------
echo
log "Verifying install…"
ok=0; tot=0
check() { tot=$((tot+1)); if eval "$1"; then echo "  ✓ $2"; ok=$((ok+1)); else echo "  ✗ $2"; fi; }
check "[[ -f $SKILLS_DIR/SKILL.md ]]" "SKILL.md at $SKILLS_DIR/SKILL.md"
check "[[ -x $HOOKS_DIR/puppet-flush.sh ]]" "hooks installed in $HOOKS_DIR"
check "python3 -c \"import json; assert 'claude-puppet' in json.load(open('$CLAUDE_JSON_PATH'))['mcpServers']\" 2>/dev/null" "mcpServers.claude-puppet present in $CLAUDE_JSON_PATH"
if [[ "$INSTALL_SERVICES" -eq 1 ]]; then
  check "systemctl --user is-active --quiet claude-puppet-mcp.service" "claude-puppet-mcp.service active"
  check "systemctl --user is-active --quiet claude-puppet-dashboard.service" "claude-puppet-dashboard.service active"
  check "curl -sf http://localhost:5056/mcp -o /dev/null -m 2 || curl -sf http://localhost:5056/ -o /dev/null -m 2" "MCP HTTP responds at :5056"
fi
echo "  $ok/$tot checks passed."

cat <<EOF

[install] done.

Test it: open a fresh master claude session and ask
  > spawn a slave claude in /tmp/demo, have it write fizzbuzz.py, then close it

If the master proposes calling open_session — the install is working.

Live observation: http://localhost:5055 (dashboard)
EOF
