#!/usr/bin/env bash
# Master-callable HELPER (not a UserPromptSubmit hook). Drain the event
# queue WITHOUT pulling per-event content into the master's context.
#
# When to use: on reconnect (hundreds of stale events queued), or any time
# you know the queue holds replay that you don't need word-for-word but
# want consumed so future drain_events calls return only fresh events.
#
# Cost: ~50 tokens in master context if nothing notable; ~200-500 if alerts
# fire (vs ~5k-10k for the equivalent drain_events call that would land in
# the transcript verbatim).
#
# Usage:
#   bash ~/.claude/hooks/puppet-flush.sh [owner]
#   PUPPET_OWNER=me bash ~/.claude/hooks/puppet-flush.sh
#
# Output format:
#   - Empty queue:   flushed 0 events (pending=0)
#   - Normal:        flushed 47 events (8 fresh, 39 stale; pending=0)
#   - Alerts found:  <puppet-alert>...</puppet-alert> block + one-line summary
#
# Env knobs:
#   PUPPET_OWNER             (default "me")
#   PUPPET_DRAIN_URL         (default http://localhost:5056/api/drain)
#   PUPPET_DRAIN_MAX_AGE_S   (default 60s; 0 disables staleness filtering for the report)
#   PUPPET_FLUSH_BATCH       (default 256; per-curl max_events; we loop until empty)
#   PUPPET_FLUSH_MAX_LOOPS   (default 32; safety cap on the loop count)
#   PUPPET_ALERT_PATTERNS    (extra regexes, comma-separated)
#
# Exit code is always 0 unless the daemon is unreachable (then 0 with empty stdout).

set -euo pipefail

OWNER="${1:-${PUPPET_OWNER:-me}}"
URL="${PUPPET_DRAIN_URL:-http://localhost:5056/api/drain}"
MAX_AGE_S="${PUPPET_DRAIN_MAX_AGE_S:-60}"
BATCH="${PUPPET_FLUSH_BATCH:-256}"
MAX_LOOPS="${PUPPET_FLUSH_MAX_LOOPS:-32}"
EXTRA_PATTERNS="${PUPPET_ALERT_PATTERNS:-}"

# Loop until the queue reports pending=0 (or we hit MAX_LOOPS). Accumulate
# events into one Python invocation at the end so we only parse once.
agg="[]"
loops=0
pending_final=0
while : ; do
    loops=$((loops + 1))
    if [ "$loops" -gt "$MAX_LOOPS" ]; then
        break
    fi
    resp="$(curl -sf --connect-timeout 0.25 --max-time 2 \
        "${URL}?owner=${OWNER}&max_events=${BATCH}" 2>/dev/null || true)"
    if [ -z "$resp" ]; then
        # Daemon unreachable — emit nothing, exit clean.
        exit 0
    fi
    # Append events from this batch to agg; track pending.
    agg="$(python3 - "$agg" "$resp" <<'PY'
import json, sys
agg = json.loads(sys.argv[1])
batch = json.loads(sys.argv[2])
agg.extend(batch.get("events") or [])
agg.append({"__pending__": batch.get("pending", 0)})
print(json.dumps(agg))
PY
)"
    # Did we drain everything? Last appended dict has __pending__.
    pending_final="$(python3 - "$agg" <<'PY'
import json, sys
agg = json.loads(sys.argv[1])
# Find last __pending__ marker
for ev in reversed(agg):
    if isinstance(ev, dict) and "__pending__" in ev:
        print(ev["__pending__"])
        break
PY
)"
    if [ "$pending_final" = "0" ] || [ -z "$pending_final" ]; then
        break
    fi
done

python3 - "$agg" "$MAX_AGE_S" "$EXTRA_PATTERNS" "$pending_final" "$loops" <<'PY'
import json, re, sys, time

agg = json.loads(sys.argv[1])
max_age_s = sys.argv[2]
extra = sys.argv[3]
pending_final = sys.argv[4] or "0"
loops = sys.argv[5]

# Strip out the __pending__ sentinels we used to communicate between loops.
events = [ev for ev in agg if not (isinstance(ev, dict) and "__pending__" in ev)]

try:
    max_age_ms = int(float(max_age_s)) * 1000
except ValueError:
    max_age_ms = 60_000
now_ms = int(time.time() * 1000)

stale = 0
fresh = []
for ev in events:
    ts = ev.get("ts") or 0
    if max_age_ms > 0 and (now_ms - int(ts)) > max_age_ms:
        stale += 1
    else:
        fresh.append(ev)

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
for ev in fresh:
    if ev.get("type") != "new_lines":
        continue
    sid = ev.get("sid", "?")
    for ln in ev.get("lines", []):
        text = ln.get("text", "")
        for pat in patterns:
            if pat.search(text):
                alerts.append(f"[slave {sid}] {pat.pattern!r}: {text.strip()[:140]}")
                break

if alerts:
    print("<puppet-alert>")
    print("  Anomalies detected in flushed events (these were going to be dropped silently)")
    print("  — investigate with read_screen on the named slave(s):")
    for a in alerts:
        print(f"  - {a}")
    print("</puppet-alert>")

# One-line summary.
total = len(events)
parts = [f"flushed {total} events"]
breakdown = []
if len(fresh):
    breakdown.append(f"{len(fresh)} fresh")
if stale:
    breakdown.append(f"{stale} stale (> {max_age_s}s old)")
if breakdown:
    parts.append("(" + ", ".join(breakdown) + ")")
parts.append(f"pending={pending_final}")
if int(loops) > 1:
    parts.append(f"loops={loops}")
print(" ".join(parts))
PY
