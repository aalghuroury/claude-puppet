#!/usr/bin/env bash
# Master-callable HELPER. Drain the event queue and emit a COMPACT summary:
# tail-N lines per slave + one-liners for prompt_visible/exited + counts.
# Trades word-for-word fidelity for token economy — use when the master
# needs "what's the current state" without paying the cost of full history.
#
# When to use: every supervision check-in where you'd otherwise call
# drain_events. Token cost typically ~200-800 tokens vs ~2-10k for raw
# drain_events on a busy queue.
#
# Usage:
#   bash ~/.claude/hooks/puppet-peek.sh [owner]
#
# Output is sized — at most N lines per slave (default 5), plus a one-line
# tail per slave summarizing total lines / counts.
#
# Env knobs:
#   PUPPET_OWNER             (default "me")
#   PUPPET_DRAIN_URL         (default http://localhost:5056/api/drain)
#   PUPPET_DRAIN_MAX_AGE_S   (default 60s)
#   PUPPET_PEEK_TAIL_N       (default 5; lines kept per slave)
#   PUPPET_ALERT_PATTERNS    (extra regexes, comma-separated)

set -euo pipefail

OWNER="${1:-${PUPPET_OWNER:-me}}"
URL="${PUPPET_DRAIN_URL:-http://localhost:5056/api/drain}"
MAX_AGE_S="${PUPPET_DRAIN_MAX_AGE_S:-60}"
TAIL_N="${PUPPET_PEEK_TAIL_N:-5}"
EXTRA_PATTERNS="${PUPPET_ALERT_PATTERNS:-}"

resp="$(curl -sf --connect-timeout 0.25 --max-time 2 \
    "${URL}?owner=${OWNER}" 2>/dev/null || true)"
if [ -z "$resp" ]; then
    exit 0
fi

python3 - "$resp" "$MAX_AGE_S" "$TAIL_N" "$EXTRA_PATTERNS" <<'PY'
import json, re, sys, time
from collections import defaultdict

resp_text, max_age_s, tail_n_s, extra = sys.argv[1:5]
try:
    data = json.loads(resp_text)
except json.JSONDecodeError:
    sys.exit(0)

events = data.get("events") or []
pending = data.get("pending", 0)
try:
    max_age_ms = int(float(max_age_s)) * 1000
except ValueError:
    max_age_ms = 60_000
try:
    tail_n = max(0, int(tail_n_s))
except ValueError:
    tail_n = 5
now_ms = int(time.time() * 1000)

# Filter stale, group fresh events by sid.
stale = 0
by_sid_lines: dict[str, list[str]] = defaultdict(list)
by_sid_signals: dict[str, list[str]] = defaultdict(list)  # prompt_visible/exited summaries
total_lines_per_sid: dict[str, int] = defaultdict(int)
seen_sids: list[str] = []

for ev in events:
    ts = ev.get("ts") or 0
    if max_age_ms > 0 and (now_ms - int(ts)) > max_age_ms:
        stale += 1
        continue
    sid = ev.get("sid", "?")
    if sid not in seen_sids:
        seen_sids.append(sid)
    t = ev.get("type")
    if t == "new_lines":
        for ln in ev.get("lines", []):
            txt = ln.get("text", "")
            by_sid_lines[sid].append(txt)
            total_lines_per_sid[sid] += 1
    elif t == "prompt_visible":
        by_sid_signals[sid].append("awaiting input")
    elif t == "exited":
        by_sid_signals[sid].append(f"exited (code={ev.get('code')}, signal={ev.get('signal')})")
    else:
        by_sid_signals[sid].append(f"event {t}")

# Alerts (same pattern set as flush hook; check all kept lines).
DEFAULT_PATTERNS = [
    r"\b401\b", r"\bUnauthorized\b",
    r"\bAuthentication\s+(failed|required|error)",
    r"\bcredentials\b", r"\bauth\s+(failed|error)\b",
    r"\bError:\s", r"\bfailed to\b",
    r"\binvalid\s+(api[_-]?key|token|credential)",
    r"\brate[_-]?limit", r"\bpermission\s+denied\b",
]
extra_patterns = [p.strip() for p in (extra or "").split(",") if p.strip()]
patterns = [re.compile(p, re.IGNORECASE) for p in DEFAULT_PATTERNS + extra_patterns]

alerts = []
for sid, lines in by_sid_lines.items():
    for ln in lines:
        for pat in patterns:
            if pat.search(ln):
                alerts.append(f"[slave {sid}] {pat.pattern!r}: {ln.strip()[:140]}")
                break

if not seen_sids and stale == 0:
    sys.exit(0)  # silent on truly empty

if alerts:
    print("<puppet-alert>")
    print("  Anomalies detected — investigate with read_screen on the named slave(s):")
    for a in alerts:
        print(f"  - {a}")
    print("</puppet-alert>")

print("<puppet-peek>")
for sid in seen_sids:
    lines = by_sid_lines.get(sid, [])
    signals = by_sid_signals.get(sid, [])
    total = total_lines_per_sid.get(sid, 0)
    tail = lines[-tail_n:] if tail_n > 0 else []
    omitted = max(0, total - len(tail))
    print(f"  [slave {sid}] {total} new line(s){' (' + str(omitted) + ' elided)' if omitted else ''}:")
    for ln in tail:
        print(f"    {ln}")
    for sig in signals:
        print(f"    · {sig}")

tail_parts = []
if pending:
    tail_parts.append(f"{pending} still queued")
if stale:
    tail_parts.append(f"{stale} stale dropped (> {max_age_s}s old)")
if tail_parts:
    print(f"  ({'; '.join(tail_parts)})")
print("</puppet-peek>")
PY
