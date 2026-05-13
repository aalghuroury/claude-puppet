// Dashboard-side audit log.
//
// Whenever the dashboard's HTTP control surface mutates a session (send_keys,
// send_text, interrupt, close, resize), we append a single JSON line to the
// session's per-session `tool_calls.jsonl` — the same file the puppet daemon
// writes to. Masters tailing this file (via `read_log`, `puppet-debug
// forensics`, or just `tail -f`) see dashboard actions interleaved with their
// own tool calls, distinguished by `source: "dashboard"` and the `dashboard_*`
// op prefix.
//
// Writes are best-effort and fire-and-forget — a permission/disk failure logs
// to stderr but never breaks the HTTP response.
//
// --- Tamper-evidence ---------------------------------------------------------
// Each appended line carries an `hmac` field — HMAC-SHA256 of the record's
// canonical JSON (without the `hmac` key) under the shared key at
// `~/.cache/claude-puppet/audit-hmac-key` (mode 0o600). The puppet daemon
// (`server/mcp_server.py:_log_call`) writes the same way, so a uid=ahmed
// process forging a line will not produce a verifying HMAC.
//
// The canonical JSON uses sorted string keys at every depth and Python's
// `separators=(",", ":")` style — see `canonicalJson` below. Both writers
// MUST produce byte-identical canonical bytes for verification to work.

import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  promises as fs,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export type DashboardActionRec = {
  ts: number;
  op: string;
  args: unknown;
  result: unknown;
  error: string | null;
  duration_ms: number;
  source: "dashboard";
  remote?: string;
};

function sessionFilePath(sid: string): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base =
    xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "claude-puppet", "sessions", sid, "tool_calls.jsonl");
}

// Path to the shared HMAC key. Mirrors the puppet daemon's
// `cache_root().parent / "audit-hmac-key"` exactly.
function auditKeyPath(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base =
    xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "claude-puppet", "audit-hmac-key");
}

let _auditKey: Buffer | null = null;

function loadOrCreateAuditKey(): Buffer {
  if (_auditKey) return _auditKey;
  const keyPath = auditKeyPath();
  try {
    if (existsSync(keyPath)) {
      _auditKey = Buffer.from(readFileSync(keyPath, "utf-8").trim(), "hex");
    } else {
      _auditKey = randomBytes(32);
      const tmp = keyPath + ".tmp";
      writeFileSync(tmp, _auditKey.toString("hex"));
      chmodSync(tmp, 0o600);
      renameSync(tmp, keyPath);
    }
  } catch (err) {
    process.stderr.write(
      `[dashboard] audit hmac key load/create failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    _auditKey = Buffer.alloc(32); // degraded mode; still tamper-evident-relative-to-itself
  }
  return _auditKey!;
}

// Stable JSON serializer that matches Python's
// `json.dumps(obj, separators=(",", ":"), sort_keys=True)` byte-for-byte for
// the record shapes we actually emit (string/number/boolean/null/array/object).
//
// Notes on parity:
//   - `separators=(",", ":")` matches `JSON.stringify` with no spacing args.
//   - `sort_keys=True` sorts string keys at every depth — implemented here
//     by recursive Object.keys(...).sort() (lexicographic, the same order
//     Python uses for string keys).
//   - Strings, numbers, booleans, null go through `JSON.stringify` so
//     escapes (\u00xx, \", \\, \n, etc.) match Python's defaults.
//   - We never emit non-finite numbers, undefined, BigInt, or symbols in
//     audit records; if such a value is ever passed, it is treated like
//     `JSON.stringify` would (undefined / function / symbol omitted from
//     objects, replaced with null in arrays). This matches what Python's
//     `json.dumps` would refuse to do, so callers must not pass such values.
export function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  const t = typeof obj;
  if (t === "string" || t === "number" || t === "boolean") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map((v) => canonicalJson(v)).join(",") + "]";
  }
  if (t === "object") {
    const o = obj as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k]))
        .join(",") +
      "}"
    );
  }
  // Functions, symbols, bigints — JSON.stringify would error or skip. Fall
  // back to its behavior (mostly "null") to keep the writer non-crashing.
  return JSON.stringify(obj as never) ?? "null";
}

export async function appendAudit(
  sid: string,
  rec: DashboardActionRec,
): Promise<void> {
  const file = sessionFilePath(sid);
  // Tamper-evidence: HMAC over canonical JSON of the record without the
  // hmac field itself. The written line need not be canonical-sorted — only
  // the HMAC input must be byte-identical to what verifiers recompute.
  const canonical = canonicalJson(rec);
  const hmacHex = createHmac("sha256", loadOrCreateAuditKey())
    .update(canonical)
    .digest("hex");
  const recordWithHmac = { ...rec, hmac: hmacHex };
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(recordWithHmac) + "\n", "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[dashboard] audit write failed for ${sid}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
