#!/usr/bin/env bash
# Install claude-puppet as systemd --user services so the dashboard (:5055)
# and the MCP HTTP server (:5056) survive logout and reboot.
#
# Usage:
#   bash scripts/install-services.sh         # install + enable + start
#   bash scripts/install-services.sh status  # show status
#   bash scripts/install-services.sh logs    # tail journal for both
#   bash scripts/install-services.sh stop    # stop both
#   bash scripts/install-services.sh remove  # disable + remove unit files
#
# To make services run even when no user is logged in (e.g. across reboot
# without auto-login), enable user-linger ONCE — requires sudo:
#   sudo loginctl enable-linger "$USER"

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNITS_DIR="${HOME}/.config/systemd/user"
DASHBOARD_UNIT="claude-puppet-dashboard.service"
MCP_UNIT="claude-puppet-mcp.service"

cmd="${1:-install}"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '· %s\n' "$*"; }
warn()  { printf '! %s\n' "$*" >&2; }

ensure_dirs() { mkdir -p "${UNITS_DIR}"; }

copy_unit() {
  local src="${REPO}/scripts/$1"
  local dst="${UNITS_DIR}/$1"
  install -m 0644 "${src}" "${dst}"
  info "installed ${dst}"
}

case "${cmd}" in
  install)
    bold "claude-puppet :: install services"
    ensure_dirs
    copy_unit "${DASHBOARD_UNIT}"
    copy_unit "${MCP_UNIT}"
    systemctl --user daemon-reload
    systemctl --user enable --now "${DASHBOARD_UNIT}" "${MCP_UNIT}"
    sleep 1
    systemctl --user --no-pager status "${DASHBOARD_UNIT}" "${MCP_UNIT}" | head -40 || true
    cat <<EOF

Both services are enabled and started.

  Dashboard:  http://localhost:5055
  MCP HTTP:   http://localhost:5056/mcp     (streamable-HTTP transport)

To make them survive a full reboot when you are not logged in, run ONCE
(requires sudo):

  sudo loginctl enable-linger "$USER"

EOF
    ;;

  status)
    systemctl --user --no-pager status "${DASHBOARD_UNIT}" "${MCP_UNIT}" || true
    ;;

  logs)
    bold "tailing journal (Ctrl-C to stop)"
    journalctl --user -u "${DASHBOARD_UNIT}" -u "${MCP_UNIT}" -f
    ;;

  stop)
    systemctl --user stop "${DASHBOARD_UNIT}" "${MCP_UNIT}"
    info "stopped"
    ;;

  remove)
    bold "claude-puppet :: remove services"
    systemctl --user disable --now "${DASHBOARD_UNIT}" "${MCP_UNIT}" 2>/dev/null || true
    rm -f "${UNITS_DIR}/${DASHBOARD_UNIT}" "${UNITS_DIR}/${MCP_UNIT}"
    systemctl --user daemon-reload
    info "removed"
    ;;

  *)
    warn "unknown command: ${cmd}"
    sed -n '2,12p' "$0"
    exit 2
    ;;
esac
