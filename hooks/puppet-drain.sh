#!/usr/bin/env bash
# UserPromptSubmit hook: drain claude-puppet events for $OWNER and emit
# them as a small markdown block on stdout. Claude Code prepends stdout to
# the user's prompt before the model sees it, so this auto-injects fresh
# slave activity on every user turn.
#
# Wire-up in ~/.claude/settings.json:
#   "hooks": {
#     "UserPromptSubmit": [
#       { "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/puppet-drain.sh" }] }
#     ]
#   }
#
# Env knobs:
#   PUPPET_OWNER             — which owner queue to drain (default: "me")
#   PUPPET_DRAIN_URL         — endpoint (default: http://localhost:5056/api/drain)
#   PUPPET_DRAIN_QUIET       — "1" → emit nothing on empty queue (default: "1")
#   PUPPET_DRAIN_MAX_AGE_S   — drop events older than N seconds (default: 60).
#                              "0" disables filtering — every queued event is shown.
#                              Stale events are *displayed-suppressed* but still drained.
#   PUPPET_ALERT_PATTERNS    — extra alert regexes, comma-separated (added to defaults).

set -euo pipefail

OWNER="${PUPPET_OWNER:-me}"
URL="${PUPPET_DRAIN_URL:-http://localhost:5056/api/drain}"
QUIET="${PUPPET_DRAIN_QUIET:-1}"
MAX_AGE_S="${PUPPET_DRAIN_MAX_AGE_S:-60}"
EXTRA_PATTERNS="${PUPPET_ALERT_PATTERNS:-}"

# Single non-blocking curl. 250ms connect timeout, 1s total — never hang
# the prompt if the puppet is down.
resp="$(curl -sf --connect-timeout 0.25 --max-time 1 \
    "${URL}?owner=${OWNER}" 2>/dev/null || true)"

if [ -z "$resp" ]; then
  # Puppet unreachable (daemon down, wrong port, etc.). Silently emit
  # nothing so the user's prompt is unaffected.
  exit 0
fi

# Parse, filter, format with python3 — no jq dependency.
python3 - "$resp" "$QUIET" "$MAX_AGE_S" "$EXTRA_PATTERNS" <<'PY'
import json, re, sys, time

resp_text, quiet, max_age_s, extra = sys.argv[1:5]

try:
    data = json.loads(resp_text)
except json.JSONDecodeError:
    sys.exit(0)

events = data.get("events") or []
pending = data.get("pending", 0)

# --- Drop stale events --------------------------------------------------
# `ts` is the server-side emit time in ms-since-epoch. If MAX_AGE_S > 0,
# we display-suppress (NOT re-queue) anything older than that age. The
# events are still consumed by the drain call — we just don't show them.
# Rationale: on reconnect after a break, the queue can hold hundreds of
# stale events that contaminate the master's read of "current" state.
try:
    max_age_ms = int(float(max_age_s)) * 1000
except ValueError:
    max_age_ms = 60_000

now_ms = int(time.time() * 1000)
stale_count = 0
fresh = []
if max_age_ms > 0:
    for ev in events:
        ts = ev.get("ts") or 0
        if (now_ms - int(ts)) > max_age_ms:
            stale_count += 1
            continue
        fresh.append(ev)
else:
    fresh = events

# --- Detect known error patterns in event content -----------------------
# Auth-cascade pattern: a slave silently 401s and reports "done" with
# zero work. The string evidence is in the screen text. We scan the
# event lines (which carry committed slave output) for known patterns
# and prepend an alert block if any match — so the master sees the
# warning BEFORE the events themselves.
DEFAULT_PATTERNS = [
    r"\b401\b",
    r"\bUnauthorized\b",
    r"\bAuthentication\s+(failed|required|error)",
    r"\bcredentials\b",
    r"\bauth\s+(failed|error)\b",
    r"\bError:\s",
    r"\bfailed to\b",
    r"\binvalid\s+(api[_-]?key|token|credential)",
    r"\brate[_-]?limit",
    r"\bpermission\s+denied\b",
]
extra_patterns = [p.strip() for p in (extra or "").split(",") if p.strip()]
patterns = [re.compile(p, re.IGNORECASE) for p in DEFAULT_PATTERNS + extra_patterns]

alerts: list[str] = []   # (sid, matched_text, pattern)
for ev in fresh:
    if ev.get("type") != "new_lines":
        continue
    sid = ev.get("sid", "?")
    for ln in ev.get("lines", []):
        text = ln.get("text", "")
        for pat in patterns:
            if pat.search(text):
                alerts.append(f"[slave {sid}] {pat.pattern!r} matched: {text.strip()[:120]}")
                break   # one match per line is enough

# --- Output -------------------------------------------------------------
if not fresh:
    # Nothing fresh to show. In quiet mode, stay silent regardless of
    # whether stale events were dropped — the master doesn't need to know
    # the queue had garbage. Only chirp if QUIET=0 was explicitly set.
    if quiet == "1":
        sys.exit(0)
    msg = "(none)" if stale_count == 0 else f"(all queued events were stale, dropped {stale_count})"
    print(f"<puppet-events>{msg}</puppet-events>")
    sys.exit(0)

if alerts:
    print("<puppet-alert>")
    print("  Potential anomalies detected in slave output — verify with read_screen.")
    for a in alerts:
        print(f"  • {a}")
    print("</puppet-alert>")

print("<puppet-events>")
for ev in fresh:
    t = ev.get("type")
    sid = ev.get("sid", "?")
    if t == "new_lines":
        lines = ev.get("lines", [])
        print(f"  [slave {sid}] {len(lines)} new line(s):")
        for ln in lines:
            print(f"    {ln.get('text', '')}")
    elif t == "prompt_visible":
        print(f"  [slave {sid}] awaiting input")
    elif t == "exited":
        code = ev.get("code")
        sig = ev.get("signal")
        print(f"  [slave {sid}] exited (code={code}, signal={sig})")
    else:
        print(f"  [slave {sid}] event {t}")

# Tail metadata: pending + stale-dropped counts so the master knows what
# was filtered out without it polluting the events listing.
tail_parts = []
if pending:
    tail_parts.append(f"{pending} still queued")
if stale_count:
    tail_parts.append(f"{stale_count} stale dropped (> {max_age_s}s old)")
if tail_parts:
    print(f"  ({'; '.join(tail_parts)})")
print("</puppet-events>")
PY
