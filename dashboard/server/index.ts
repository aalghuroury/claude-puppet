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
import { loadOrCreateToken, makeAuthMiddleware } from "./auth.js";
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
const REPLAY_TOOLCALLS = 200;
const REPLAY_GLOBAL_CAP = 2000;

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
app.use(express.json({ limit: "1mb" }));
// Bearer auth on POST /api/sessions/:id/*. GETs are unauthenticated so the
// read-only UI keeps working.
app.use(makeAuthMiddleware(authInfo.token));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/sessions", (_req, res) => {
  res.json({ sessions: watcher.list() });
});

// Bulk transcript read for replay. since=<byte offset>; max=<bytes>.
app.get("/api/sessions/:id/transcript", async (req, res) => {
  const id = req.params.id;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const since = Math.max(0, Number(req.query.since ?? 0));
  const max = Math.min(1024 * 1024, Math.max(1, Number(req.query.max ?? 65536)));
  const path = join(
    watcher.getRoot(),
    id,
    "transcripts",
    "transcript.jsonl",
  );
  try {
    const stat = await fs.stat(path);
    if (since >= stat.size) {
      res.json({ since, next_offset: stat.size, lines: [] });
      return;
    }
    const fh = await fs.open(path, "r");
    try {
      const len = Math.min(max, stat.size - since);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, since);
      const text = buf.toString("utf8");
      const parts = text.split("\n");
      // Drop trailing partial unless we hit EOF.
      let nextOffset = since + len;
      const trailingEmpty = parts[parts.length - 1] === "";
      if (!trailingEmpty && since + len < stat.size) {
        const lastNl = text.lastIndexOf("\n");
        if (lastNl >= 0) {
          parts.pop();
          nextOffset = since + lastNl + 1;
        }
      } else if (trailingEmpty) {
        parts.pop();
      }
      res.json({ since, next_offset: nextOffset, lines: parts });
    } finally {
      await fh.close();
    }
  } catch {
    res.json({ since, next_offset: since, lines: [] });
  }
});

// ─── MCP control routes ─────────────────────────────────────────────────────
// Each route validates the session id, then proxies to the MCP daemon.

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id) && id.length <= 128;
}

function requireSession(req: Request, res: Response): string | null {
  const id = req.params.id;
  if (!validId(id)) {
    res.status(400).json({ error: "invalid id" });
    return null;
  }
  if (!watcher.has(id)) {
    res.status(404).json({ error: `unknown session: ${id}` });
    return null;
  }
  return id;
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
): Promise<void> {
  const t0 = Date.now();
  let result: unknown = null;
  let errMsg: string | null = null;
  try {
    result = await getMcpClient().callTool(name, args);
    res.json({ ok: true, result });
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
    // 502 — upstream failure (MCP daemon).
    res.status(502).json({ ok: false, error: errMsg });
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

app.post("/api/sessions/:id/keys", async (req, res) => {
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

app.post("/api/sessions/:id/text", async (req, res) => {
  const id = requireSession(req, res);
  if (!id) return;
  const text = req.body?.text;
  if (typeof text !== "string") {
    res.status(400).json({ error: "text must be string" });
    return;
  }
  await callToolAudited(
    req,
    res,
    id,
    "send_text",
    "dashboard_send_text",
    { id, text },
    { text },
  );
});

app.post("/api/sessions/:id/interrupt", async (req, res) => {
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

app.post("/api/sessions/:id/close", async (req, res) => {
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

app.post("/api/sessions/:id/resize", async (req, res) => {
  const id = requireSession(req, res);
  if (!id) return;
  const cols = Number(req.body?.cols);
  const rows = Number(req.body?.rows);
  if (
    !Number.isFinite(cols) ||
    !Number.isFinite(rows) ||
    cols < 10 ||
    rows < 5 ||
    cols > 1000 ||
    rows > 500
  ) {
    res.status(400).json({ error: "cols/rows out of range" });
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
app.get("/api/sessions/:id/snapshot", async (req, res) => {
  const id = requireSession(req, res);
  if (!id) return;
  try {
    const result = (await getMcpClient().callTool("read_screen", {
      id,
      force_full: true,
      view_only: true,
      include_classes: ["chat", "menu", "prompt"],
    })) as {
      text?: string;
      render_hash?: string;
      content_hash?: string;
    };
    if (typeof result?.text !== "string") {
      res.status(503).json({ error: "no text" });
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
      res.status(404).json({ error: msg });
      return;
    }
    res.status(502).json({ ok: false, error: msg });
  }
});

// Static fallback (production build). Hashed asset filenames (Vite emits
// content-hashed JS/CSS into /assets/*) get long-cache; everything else
// (index.html, the favicon SVG) gets no-cache so a redeploy is picked up
// immediately on the next page load instead of waiting for a hard refresh.
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, "..", "web");
app.use(
  express.static(staticDir, {
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
const wss = new WebSocketServer({
  server,
  path: "/ws",
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

  ws.on("message", (raw) => {
    let parsed: ClientMessage | null = null;
    try {
      parsed = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.type === "visible_set" && Array.isArray(parsed.ids)) {
      const set = new Set<string>();
      for (const id of parsed.ids) {
        if (typeof id === "string" && validId(id) && watcher.has(id)) {
          set.add(id);
        }
      }
      clientFocused.set(ws, set);
      recomputeFocusedUnion();
    }
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
