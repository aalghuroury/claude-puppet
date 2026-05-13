// Express + WebSocket server for the claude-puppet dashboard.
//
// On connect we send a "snapshot" of all currently-tracked sessions plus a
// short replay of the last N events globally and last 200 master tool calls
// so the UI has context. After that, all new events stream live.
//
// We also expose a small HTTP control surface (`/api/sessions/:id/...`) which
// proxies to the puppet's MCP daemon at :5056. This keeps tool-calling logic
// + session-id state in one place (the dashboard backend) instead of leaking
// it into the browser.

import express, { type Request, type Response } from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { promises as fs } from "node:fs";
import { SessionsWatcher, defaultCacheRoot } from "./watcher.js";
import { getMcpClient } from "./mcp-client.js";
import { coalescePtyData } from "./pty-coalesce.js";
import { ScreenPoller } from "./screen-poller.js";
import { appendAudit } from "./audit.js";
import { loadOrCreateToken, makeAuthMiddleware, checkBearer } from "./auth.js";
import type {
  ClientMessage,
  MasterSummaryEvent,
  PtyDataEvent,
  ServerEvent,
  SessionInfo,
  ToolCallEvent,
} from "./types.js";

const PORT = Number(process.env.PORT ?? 5055);
const REPLAY_PER_SESSION = 200;
// Per-WS-connect replay caps. Lowered from 200/2000 → 50/300 to keep the
// initial replay payload small (large replays were ~1MB+ on busy hosts).
// Override via PUPPET_DASH_REPLAY_TOOLS / PUPPET_DASH_REPLAY_PTY env vars.
const REPLAY_TOOLCALLS = Math.max(
  0,
  Number(process.env.PUPPET_DASH_REPLAY_TOOLS ?? 50),
);
const REPLAY_GLOBAL_CAP = Math.max(
  0,
  Number(process.env.PUPPET_DASH_REPLAY_PTY ?? 300),
);

// Origin allowlist for cross-origin POSTs. Same-origin requests (no Origin
// header on GET, or matching loopback origin) pass through unchanged.
// Entries are parsed into {protocol, host, port} so the incoming Origin
// can be normalized (lowercase host, drop trailing slash / path) before the
// compare — defeats trivial bypass-by-typo and trailing-slash mismatches.
const ALLOWED_ORIGINS: ReadonlyArray<{ protocol: string; host: string; port: string }> = [
  { protocol: "http:", host: "localhost", port: String(PORT) },
  { protocol: "http:", host: "127.0.0.1", port: String(PORT) },
];

/**
 * Parse an Origin header into its components and check it against the
 * allowlist. Returns the canonical `<scheme>://<host>:<port>` string on
 * success (for echoing back into Access-Control-Allow-Origin), or null on
 * any failure (unparseable, non-http scheme, or not in allowlist).
 *
 * Rejects:
 *   - the literal `null` (sandboxed contexts) — URL constructor throws on it
 *   - non-http/https schemes
 *   - hosts/ports not on the allowlist
 */
function checkOriginAllowed(origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  const proto = parsed.protocol;
  const host = parsed.hostname.toLowerCase();
  // URL.port is "" when the URL's port equals the protocol's default. We
  // require an explicit port in our allowlist entries, so normalize here.
  const port =
    parsed.port || (proto === "https:" ? "443" : proto === "http:" ? "80" : "");
  for (const allow of ALLOWED_ORIGINS) {
    if (allow.protocol === proto && allow.host === host && allow.port === port) {
      return `${proto}//${host}:${port}`;
    }
  }
  return null;
}

// Session-id regex used by both HTTP routes and the WS visible_set handler.
// Stricter than the old `[a-zA-Z0-9_-]+`: must start with alnum/underscore,
// rejects leading dash (which could be confused for argv flags). Allows
// dot/dash/underscore in the body; length 1-128.
const SESSION_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_\-.]{0,127}$/;

// Max bytes for a transcript GET. ~2000 lines worst-case.
const TRANSCRIPT_MAX_DEFAULT = 200;
const TRANSCRIPT_MAX_CAP = 2000;

// Backpressure threshold (per-client) — if `bufferedAmount` is over this many
// bytes, skip the next ws.send rather than balloon the Node heap.
const BACKPRESSURE_BYTES = 4 * 1024 * 1024;

// Per-session ring TTL: a session whose last visible-set timestamp is older
// than this is evicted from the in-memory ptyRing.
const RING_TTL_MS = 60_000;
const RING_GC_INTERVAL_MS = 30_000;

// In-memory ring buffers (per session) used for fresh-connection catch-up.
const ptyRing = new Map<string, PtyDataEvent[]>();
const toolCallRing: ToolCallEvent[] = [];
const lastVisibleMs = new Map<string, number>();

let lastMasterSummary: MasterSummaryEvent | null = null;

function ringPush<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

const watcher = new SessionsWatcher(process.env.CLAUDE_PUPPET_SESSIONS_DIR, {
  onSessionOpen(info) {
    broadcast({ type: "session_open", session: info });
  },
  onSessionClose(id, ts) {
    broadcast({ type: "session_close", id, ts });
  },
  onPtyData(ev) {
    handlePtyData(ev);
  },
  onToolCall(ev) {
    ringPush(toolCallRing, ev, REPLAY_TOOLCALLS);
    broadcast(ev);
  },
  onMasterSummary(ev) {
    lastMasterSummary = ev;
    broadcast(ev);
  },
  onStatusChange(ev) {
    broadcast(ev);
  },
});

// Wrap pty_data path in the 50ms / 8KB coalescer (only "out" direction).
const handlePtyData = coalescePtyData((ev: PtyDataEvent) => {
  let buf = ptyRing.get(ev.id);
  if (!buf) {
    buf = [];
    ptyRing.set(ev.id, buf);
  }
  ringPush(buf, ev, REPLAY_PER_SESSION);
  broadcast(ev);
}, 50, 8192);

// Resolve auth token before any routes are wired so POSTs are never
// reachable in an unauthenticated state, even briefly.
const authInfo = loadOrCreateToken();

const app = express();
// 256kb is enough for paste-large-snippet use cases without inviting DoS via
// 100MB JSON blobs. Anything larger trips entity.parse.failed/413 which our
// JSON-error middleware below converts to a plain {"error": "..."} response.
app.use(express.json({ limit: "256kb" }));

// JSON parse / payload-size error → 400 JSON instead of Express's default
// HTML page (and instead of bubbling into the unauthenticated default
// handler).
app.use((err: unknown, _req: Request, res: Response, next: express.NextFunction): void => {
  if (err && typeof err === "object") {
    const e = err as { type?: string; status?: number; statusCode?: number };
    if (e.type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid JSON body" });
      return;
    }
    if (e.type === "entity.too.large") {
      res.status(413).json({ error: "payload too large" });
      return;
    }
  }
  next(err);
});

// Origin allowlist. Same-origin requests don't carry an Origin header, so we
// allow those through. Cross-origin requests must come from a whitelisted
// loopback origin or are rejected with 403 before reaching any route handler.
// The check normalizes the incoming Origin (lowercases host, drops trailing
// slash/path via URL parsing) before compare — so trivial mismatches like
// `http://LOCALHOST:5055` or `http://localhost:5055/` still pass, while the
// literal `null` Origin (sandboxed contexts) and non-http schemes are
// rejected.
app.use((req: Request, res: Response, next: express.NextFunction): void => {
  const origin = req.headers.origin;
  if (!origin) {
    next();
    return;
  }
  const canonical = checkOriginAllowed(origin);
  if (canonical !== null) {
    res.setHeader("Access-Control-Allow-Origin", canonical);
    res.setHeader("Vary", "Origin");
    next();
    return;
  }
  res.status(403).json({ error: "origin not allowed" });
});

// Health check is mounted at the app level so it stays auth-less.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Index/HTML serving with bearer-token injection. The frontend reads the
// token from a `<meta name="x-dashboard-token">` tag in <head>, so the SPA
// can call POST routes without prompting the user for the token. The
// inserted meta tag is only sent to same-host requests (the Origin check
// above already gates non-loopback callers).
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, "..", "web");
// Match either the empty placeholder the frontend ships with OR an already-
// injected tag with any prior token value (e.g. after `npm run dev` or a
// rebuild that produced a fresh token); replace in-place so we never end up
// with two tags (only the first is read by `document.querySelector`).
const TOKEN_META_RE = /<meta\s+name="x-dashboard-token"\s+content="[^"]*"\s*\/?>/i;

async function serveIndexWithToken(_req: Request, res: Response): Promise<void> {
  try {
    const html = await fs.readFile(join(staticDir, "index.html"), "utf8");
    const tag = `<meta name="x-dashboard-token" content="${authInfo.token}" />`;
    let injected: string;
    if (TOKEN_META_RE.test(html)) {
      injected = html.replace(TOKEN_META_RE, tag);
    } else if (html.includes("</head>")) {
      injected = html.replace("</head>", `  ${tag}\n  </head>`);
    } else {
      injected = tag + html;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(injected);
  } catch {
    res.status(404).json({ error: "index.html not found" });
  }
}
app.get("/", (req, res) => void serveIndexWithToken(req, res));
app.get("/index.html", (req, res) => void serveIndexWithToken(req, res));

// All /api/* routes go through bearer auth (both GET and POST). The
// read-only UI receives the bearer in the meta tag (see serveIndexWithToken)
// and adds it to every fetch / WS connect.
const api = express.Router();
api.use(makeAuthMiddleware(authInfo.token));

api.get("/sessions", (_req, res) => {
  res.json({ sessions: watcher.list() });
});

// Bulk transcript read for replay. since=<byte offset>; max=<line count cap>.
api.get("/sessions/:id/transcript", async (req, res) => {
  const id = req.params.id;
  if (!SESSION_ID_RE.test(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  // Strict parsing: reject NaN, negative, non-integer.
  const sinceRaw = req.query.since;
  const sinceStr =
    typeof sinceRaw === "string" ? sinceRaw : sinceRaw === undefined ? "0" : "";
  const since = Number.parseInt(sinceStr, 10);
  if (!Number.isFinite(since) || since < 0 || String(since) !== sinceStr.trim()) {
    res.status(400).json({ error: "since must be non-negative integer" });
    return;
  }
  const maxRaw = req.query.max;
  let max = TRANSCRIPT_MAX_DEFAULT;
  if (maxRaw !== undefined) {
    const maxStr = typeof maxRaw === "string" ? maxRaw : "";
    max = Number.parseInt(maxStr, 10);
    if (!Number.isFinite(max) || max < 1 || max > TRANSCRIPT_MAX_CAP) {
      res.status(400).json({ error: `max must be 1..${TRANSCRIPT_MAX_CAP}` });
      return;
    }
  }
  const path = join(
    watcher.getRoot(),
    id,
    "transcripts",
    "transcript.jsonl",
  );
  // `max` is a line cap; read in chunks until we have that many lines or EOF.
  // Worst-case payload bound: max * MAX_LINE_BYTES (= 16kb), so 2000 * 16k = 32MB
  // theoretical, but in practice transcripts have ~200-byte lines.
  const READ_CHUNK = 64 * 1024;
  try {
    const stat = await fs.stat(path);
    if (since >= stat.size) {
      res.json({ since, next_offset: stat.size, lines: [] });
      return;
    }
    const fh = await fs.open(path, "r");
    try {
      const lines: string[] = [];
      let nextOffset = since;
      let carry = "";
      while (lines.length < max && nextOffset < stat.size) {
        const remaining = stat.size - nextOffset;
        const len = Math.min(READ_CHUNK, remaining);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, nextOffset);
        nextOffset += len;
        const text = carry + buf.toString("utf8");
        const parts = text.split("\n");
        // Last element is a partial line unless we just hit EOF AND the file
        // ended with \n (in which case the last split element is "").
        carry = parts.pop() ?? "";
        for (const ln of parts) {
          lines.push(ln);
          if (lines.length >= max) break;
        }
        if (lines.length >= max) {
          // Recompute nextOffset to point at the byte right after the last
          // emitted line's newline.
          let consumed = 0;
          for (let i = 0; i < lines.length; i++) {
            consumed += Buffer.byteLength(lines[i], "utf8") + 1; // +1 for '\n'
          }
          nextOffset = since + consumed;
          carry = "";
          break;
        }
      }
      // If carry is non-empty AND we're at EOF, treat it as a final line.
      // Otherwise it's a partial we leave for the next fetch.
      if (nextOffset >= stat.size && carry.length > 0 && lines.length < max) {
        lines.push(carry);
        nextOffset = stat.size;
        carry = "";
      }
      res.json({ since, next_offset: nextOffset, lines });
    } finally {
      await fh.close();
    }
  } catch {
    res.json({ since, next_offset: since, lines: [] });
  }
});

// ─── MCP control routes ─────────────────────────────────────────────────────
// Each route validates the session id, then proxies to the MCP daemon.
//
// Response envelope: POST control routes return the MCP tool result fields
// directly merged with `{ok: true, ...}` rather than double-wrapping as
// `{ok: true, result: {...}}`. On MCP failure we return `{ok: false, error}`
// with an appropriate non-2xx status (400 for client error, 404 for unknown
// session, 502 for upstream MCP failure).

function validId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/**
 * Returns true iff the watcher knows about this session AND its current
 * state.db status is still alive/running.
 *
 * Note: the watcher's `exited` flag is unreliable — it can be true for
 * sessions whose state.db row still says `alive` (the flag is set by the
 * transcript stream as soon as the slave's claude exits, but state.db
 * tracks the puppet's own bookkeeping which may not have caught up, or
 * vice versa). state.db is the source of truth; trust `status` only.
 */
function sessionIsActive(id: string): boolean {
  if (!watcher.has(id)) return false;
  const info = watcher.list().find((s) => s.id === id);
  if (!info) return false;
  const status = info.status;
  // No status yet → fresh session whose state.db row hasn't been read; allow.
  if (!status) return true;
  return status === "running" || status === "alive";
}

function requireSession(req: Request, res: Response): string | null {
  const id = req.params.id;
  if (!validId(id)) {
    res.status(400).json({ error: "invalid id" });
    return null;
  }
  if (!sessionIsActive(id)) {
    res.status(404).json({ error: "unknown session" });
    return null;
  }
  return id;
}

/**
 * Classify an MCP tool-call result into one of:
 *   - {kind: "ok", value}     — success
 *   - {kind: "error", status, message} — MCP signalled an error (isError=true
 *     on the tool response, or the lone content block starts with the
 *     well-known "Error executing tool" prefix that python-mcp emits).
 *
 * The HTTP status is mapped from the error text:
 *   - "unknown session id" → 404
 *   - "unresolved key names" → 400
 *   - anything else → 502 (bad gateway: MCP failure)
 */
function classifyMcpResult(
  result: unknown,
): { kind: "ok"; value: unknown } | { kind: "error"; status: number; message: string } {
  // mcp-client.ts collapses isError responses to either:
  //   - the parsed structured result (rare for errors)
  //   - the raw text of content[0].text when it starts with "Error..."
  //
  // We detect the textual form here, which covers every error path
  // python-mcp produces today.
  let errText: string | null = null;
  if (typeof result === "string" && result.startsWith("Error executing tool")) {
    errText = result;
  } else if (
    result &&
    typeof result === "object" &&
    "isError" in result &&
    (result as { isError?: unknown }).isError === true
  ) {
    const r = result as {
      content?: Array<{ text?: string }>;
      text?: string;
    };
    errText = r.content?.[0]?.text ?? r.text ?? "MCP tool returned error";
  }
  if (errText === null) return { kind: "ok", value: result };

  let status = 502;
  if (/unknown session id/i.test(errText)) status = 404;
  else if (/unresolved key names?/i.test(errText)) status = 400;
  return { kind: "error", status, message: errText };
}

function remoteOf(req: Request): string | undefined {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff;
  if (Array.isArray(xff) && xff.length > 0) return xff[0];
  return req.socket.remoteAddress ?? undefined;
}

async function callToolAudited(
  req: Request,
  res: Response,
  sid: string,
  name: string,
  auditOp: string,
  args: Record<string, unknown>,
  auditArgs: unknown,
  extraResponse?: Record<string, unknown>,
): Promise<void> {
  const t0 = Date.now();
  let result: unknown = null;
  let errMsg: string | null = null;
  try {
    result = await getMcpClient().callTool(name, args);
    const classified = classifyMcpResult(result);
    if (classified.kind === "error") {
      errMsg = classified.message;
      res.status(classified.status).json({ ok: false, error: classified.message });
    } else {
      // Envelope: merge MCP result fields with {ok: true, ...} rather than
      // double-wrapping. Object results merge in; primitive results land in
      // a `result` key for back-compat. `extraResponse` (when provided)
      // contributes route-level fields like /text's stripped_bytes that
      // sit alongside (not inside) the MCP result.
      if (classified.value && typeof classified.value === "object" && !Array.isArray(classified.value)) {
        res.json({
          ok: true,
          ...(extraResponse ?? {}),
          ...(classified.value as Record<string, unknown>),
        });
      } else {
        res.json({ ok: true, ...(extraResponse ?? {}), result: classified.value });
      }
    }
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
    // 404 if the underlying MCP error indicates an unknown session id; else
    // 502 (upstream MCP failure).
    const status = /unknown session id/i.test(errMsg) ? 404 : 502;
    res.status(status).json({ ok: false, error: errMsg });
  }
  const rec = {
    ts: Date.now(),
    op: auditOp,
    args: auditArgs,
    result: errMsg ? null : result,
    error: errMsg,
    duration_ms: Date.now() - t0,
    source: "dashboard" as const,
    remote: remoteOf(req),
  };
  void appendAudit(sid, rec).catch(() => {
    /* already logged inside appendAudit */
  });
}

api.post("/sessions/:id/keys", async (req, res) => {
  const id = requireSession(req, res);
  if (!id) return;
  const keys = req.body?.keys;
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) {
    res.status(400).json({ error: "keys must be string[]" });
    return;
  }
  await callToolAudited(
    req,
    res,
    id,
    "send_keys",
    "dashboard_send_keys",
    { id, keys },
    { keys },
  );
});

/**
 * Strip C0 control bytes (except \t \n \r) and CSI/OSC escape sequences from
 * the input. Prevents the dashboard from being used as a vector to inject
 * raw ANSI/VT escape sequences (which would otherwise be passed straight
 * through to the slave PTY by `send_text`).
 */
function stripControls(s: string): string {
  // ORDER MATTERS: CSI and OSC sequences start with \x1b, which is also a C0
  // control byte. If we strip C0 first, the \x1b vanishes and the rest of the
  // sequence (e.g. "[2J", "]0;title\x07") leaks through as literal text. So
  // recognize multi-byte sequences first, then mop up any remaining C0 bytes.
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")   // CSI: \x1b[ ... <final byte>
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*\x07/g, "")        // OSC: \x1b] ... \x07 (BEL)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""); // remaining C0 + DEL (keep \t \n \r)
}

api.post("/sessions/:id/text", async (req, res) => {
  const id = requireSession(req, res);
  if (!id) return;
  const text = req.body?.text;
  if (typeof text !== "string") {
    res.status(400).json({ error: "text must be string" });
    return;
  }
  // Track the byte delta from sanitization so the client can detect
  // injection attempts (anything that was stripped is suspicious — clients
  // shouldn't be sending raw CSI/OSC/C0 sequences through this route).
  const original_len = text.length;
  const sanitized = stripControls(text);
  const stripped = original_len - sanitized.length;
  await callToolAudited(
    req,
    res,
    id,
    "send_text",
    "dashboard_send_text",
    { id, text: sanitized },
    { text: sanitized },
    { original_bytes: original_len, stripped_bytes: stripped },
  );
});

api.post("/sessions/:id/interrupt", async (req, res) => {
  const id = requireSession(req, res);
  if (!id) return;
  const force = !!req.body?.force;
  await callToolAudited(
    req,
    res,
    id,
    "interrupt",
    "dashboard_interrupt",
    { id, force },
    { force },
  );
});

api.post("/sessions/:id/close", async (req, res) => {
  const id = requireSession(req, res);
  if (!id) return;
  await callToolAudited(
    req,
    res,
    id,
    "close_session",
    "dashboard_close",
    { id },
    {},
  );
});

api.post("/sessions/:id/resize", async (req, res) => {
  const id = requireSession(req, res);
  if (!id) return;
  const cols = Number(req.body?.cols);
  const rows = Number(req.body?.rows);
  // Aligned with puppet's resize_session check in server/sessions.py:430 and
  // server/mcp_server.py:1323 — same lower/upper bounds, same error semantics.
  if (
    !Number.isFinite(cols) ||
    !Number.isFinite(rows) ||
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 20 ||
    cols > 1000 ||
    rows < 5 ||
    rows > 200
  ) {
    res.status(400).json({ error: "cols must be 20..1000, rows must be 5..200" });
    return;
  }
  const c = cols | 0;
  const r = rows | 0;
  await callToolAudited(
    req,
    res,
    id,
    "resize_session",
    "dashboard_resize",
    { id, cols: c, rows: r },
    { cols: c, rows: r },
  );
});

// ─── Snapshot route ─────────────────────────────────────────────────────────
// First-mount of a SessionCell hits this; we return a single rendered text
// from `read_screen` (force_full + view_only) so the frontend can render an
// accurate initial frame in xterm.js without having to replay raw PTY bytes.
api.get("/sessions/:id/snapshot", async (req, res) => {
  const id = requireSession(req, res);
  if (!id) return;
  try {
    const raw = await getMcpClient().callTool("read_screen", {
      id,
      force_full: true,
      view_only: true,
      include_classes: ["chat", "menu", "prompt"],
    });
    const classified = classifyMcpResult(raw);
    if (classified.kind === "error") {
      res.status(classified.status).json({ error: classified.message });
      return;
    }
    const result = classified.value as {
      text?: string;
      render_hash?: string;
      content_hash?: string;
    } | null;
    if (!result || typeof result.text !== "string") {
      res.status(502).json({ error: "MCP returned no text" });
      return;
    }
    res.json({
      text: result.text,
      render_hash: typeof result.render_hash === "string" ? result.render_hash : "",
      content_hash:
        typeof result.content_hash === "string" ? result.content_hash : "",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unknown session id/i.test(msg)) {
      res.status(404).json({ error: "unknown session" });
      return;
    }
    res.status(502).json({ ok: false, error: msg });
  }
});

// Mount the api router after all routes are registered.
app.use("/api", api);

// Static fallback (production build). Hashed asset filenames (Vite emits
// content-hashed JS/CSS into /assets/*) get long-cache; everything else
// (the favicon SVG, etc.) gets no-cache so a redeploy is picked up
// immediately on the next page load instead of waiting for a hard refresh.
//
// Note: GET / and /index.html are handled above by serveIndexWithToken so
// the bearer-token meta tag is injected. This static mount only fires for
// /assets/* and other non-index resources.
app.use(
  express.static(staticDir, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${sep}assets${sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

const server = createServer(app);

/**
 * WebSocket upgrade auth. The /ws endpoint exposes the full live event
 * stream (session snapshot with cwd/pid/owner, all pty_data, all
 * tool_call events) — same threat profile as /api/* routes, so it MUST
 * require the same bearer token.
 *
 * Token transport: query parameter `?token=<TOKEN>` on the upgrade URL.
 * The frontend reads the token from the same `<meta x-dashboard-token>`
 * tag that `web/control.ts` uses for HTTP, then appends it to the WS URL.
 *
 * Validation reuses `checkBearer` (constant-time compare via
 * `crypto.timingSafeEqual`). We synthesize a "Bearer <token>" header from
 * the query param so we don't have to duplicate the compare logic.
 *
 * On mismatch: `verifyClient` callback returns false with 401, which the
 * ws library translates into an HTTP 401 response on the upgrade socket
 * and the connection never reaches `wss.on('connection')`.
 */
function verifyWsClient(
  info: { req: import("node:http").IncomingMessage },
  cb: (verified: boolean, code?: number, message?: string) => void,
): void {
  // req.url is the path+query of the upgrade request (e.g. "/ws?token=abc").
  // Parse with URL — needs a base since req.url is relative.
  const reqUrl = info.req.url ?? "/";
  let token = "";
  try {
    const parsed = new URL(reqUrl, "http://localhost");
    token = parsed.searchParams.get("token") ?? "";
  } catch {
    token = "";
  }
  if (!checkBearer(`Bearer ${token}`, authInfo.token)) {
    cb(false, 401, "unauthorized");
    return;
  }
  cb(true);
}

const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: verifyWsClient,
  perMessageDeflate: process.env.WS_DEFLATE === "1" ? true : false,
});

const clients = new Set<WebSocket>();
// Per-client visible (focused / on-screen) ids. Aggregated into the screen
// poller's union focused-set.
const clientFocused = new Map<WebSocket, Set<string>>();
// Per-client backpressure-drop counters, gated to one log per second.
const dropCounters = new Map<
  WebSocket,
  { dropped: number; lastLogMs: number }
>();

const screenPoller = new ScreenPoller(broadcast, 1000);

function recomputeFocusedUnion(): void {
  const union = new Set<string>();
  for (const set of clientFocused.values()) {
    for (const id of set) union.add(id);
  }
  screenPoller.setFocusedIds(union);
  // Update lastVisibleMs for all visible ids.
  const now = Date.now();
  for (const id of union) {
    lastVisibleMs.set(id, now);
  }
}

function broadcast(ev: ServerEvent): void {
  const msg = JSON.stringify(ev);
  for (const c of clients) {
    if (c.readyState !== WebSocket.OPEN) continue;
    if (c.bufferedAmount > BACKPRESSURE_BYTES) {
      const ctr = dropCounters.get(c) ?? { dropped: 0, lastLogMs: 0 };
      ctr.dropped += 1;
      const now = Date.now();
      if (now - ctr.lastLogMs > 1000) {
        // eslint-disable-next-line no-console
        console.warn(
          `[dashboard] backpressure: dropping ws send for slow client (dropped=${ctr.dropped})`,
        );
        ctr.lastLogMs = now;
      }
      dropCounters.set(c, ctr);
      continue;
    }
    try {
      c.send(msg);
    } catch {
      // client will be cleaned up on close
    }
  }
}

// Periodic ring TTL eviction. A session whose lastVisibleMs is older than
// RING_TTL_MS is evicted from ptyRing — its replay buffer is dropped to
// stop unbounded memory growth on long-lived processes.
setInterval(() => {
  const now = Date.now();
  for (const id of [...ptyRing.keys()]) {
    const v = lastVisibleMs.get(id);
    if (v === undefined || now - v > RING_TTL_MS) {
      ptyRing.delete(id);
    }
  }
}, RING_GC_INTERVAL_MS).unref?.();

wss.on("connection", (ws) => {
  clients.add(ws);
  clientFocused.set(ws, new Set());

  // 1) initial snapshot
  const sessions: SessionInfo[] = watcher.list();
  ws.send(JSON.stringify({ type: "snapshot", sessions } satisfies ServerEvent));

  // 1a) latest master summary (so the sidebar paints immediately).
  const summary = lastMasterSummary ?? {
    type: "master_summary" as const,
    masters: watcher.buildMasterSummary(),
  };
  ws.send(JSON.stringify(summary));

  // 2) replay last N pty events globally, capped at REPLAY_GLOBAL_CAP, in
  //    chronological order. (Keeps per-session interleaving correct.)
  const all: PtyDataEvent[] = [];
  for (const buf of ptyRing.values()) {
    for (const ev of buf) all.push(ev);
  }
  all.sort((a, b) => a.ts - b.ts);
  const sliceFrom = Math.max(0, all.length - REPLAY_GLOBAL_CAP);
  for (let i = sliceFrom; i < all.length; i++) {
    ws.send(JSON.stringify(all[i]));
  }

  // 3) replay last N tool calls
  for (const ev of toolCallRing) {
    ws.send(JSON.stringify(ev));
  }

  const sendWsError = (message: string): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "error", message }));
    } catch {
      /* ignore — client likely disconnected */
    }
  };

  ws.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      sendWsError("invalid JSON");
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      sendWsError("invalid message");
      return;
    }
    const msg = parsed as Partial<ClientMessage> & { type?: unknown };
    if (msg.type !== "visible_set") {
      sendWsError("unknown message type");
      return;
    }
    if (!Array.isArray(msg.ids)) {
      sendWsError("visible_set.ids must be an array of strings");
      return;
    }
    const set = new Set<string>();
    for (const id of msg.ids) {
      if (typeof id === "string" && validId(id) && watcher.has(id)) {
        set.add(id);
      }
    }
    clientFocused.set(ws, set);
    recomputeFocusedUnion();
  });

  ws.on("close", () => {
    clients.delete(ws);
    clientFocused.delete(ws);
    dropCounters.delete(ws);
    recomputeFocusedUnion();
  });
  ws.on("error", () => {
    clients.delete(ws);
    clientFocused.delete(ws);
    dropCounters.delete(ws);
    recomputeFocusedUnion();
  });
});

async function main(): Promise<void> {
  await watcher.start();
  // Bind to loopback only — there is no legitimate use case for remote
  // access to the dashboard's control surface, and the POST routes drive a
  // local PTY. (See auth.ts for the bearer-token defense-in-depth on top.)
  server.listen(PORT, "127.0.0.1", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[dashboard] listening on http://127.0.0.1:${PORT} (loopback only) · root=${defaultCacheRoot()}`,
    );
    // Log the active auth token to stderr so the user sees it on first
    // start. Subsequent starts re-read it from the token file.
    if (authInfo.source === "generated") {
      // eslint-disable-next-line no-console
      console.error(
        `[dashboard] generated new auth token (saved to ${authInfo.path}, mode 0600): ${authInfo.token}`,
      );
    } else if (authInfo.source === "file") {
      // eslint-disable-next-line no-console
      console.error(
        `[dashboard] auth token loaded from ${authInfo.path}: ${authInfo.token}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.error(
        "[dashboard] auth token loaded from CLAUDE_PUPPET_DASHBOARD_TOKEN env var",
      );
    }
  });
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[dashboard] fatal:", err);
  process.exit(1);
});

const shutdown = async (): Promise<void> => {
  screenPoller.stop();
  await watcher.stop();
  server.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
