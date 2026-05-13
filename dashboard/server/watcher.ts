// Watches the cache root for new session directories.
//
// Layout (see server/sessions.py + server/mcp_server.py):
//
//   ~/.cache/claude-puppet/sessions/
//     <id>/
//       home/.claude/                ← session "appears" once this exists
//       transcripts/transcript.jsonl
//       tool_calls.jsonl
//     tool_calls.jsonl               ← non-session-scoped master calls
//
// We watch the parent directory (depth 0) for new <id>/ subdirs. For each one
// we then check for transcripts/ and tool_calls.jsonl and spin up tailers.
//
// We also maintain an owner-index (sessionId → owner) populated from state.db
// at session-open time. After every open/close we emit a `master_summary`
// event aggregating live + total counts and last-activity per owner.
// And every STATUS_POLL_INTERVAL_MS (default 750ms, env-tunable via
// PUPPET_DASH_STATUS_POLL_MS) we poll state.db for status flips on watched
// ids and emit `status_change` events.

import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import os from "node:os";
import chokidar from "chokidar";
import { TranscriptStream } from "./transcript-stream.js";
import { JsonlTail } from "./tail.js";
import { StateDb } from "./state-db.js";
import type {
  MasterSummary,
  MasterSummaryEvent,
  PtyDataEvent,
  SessionInfo,
  StatusChangeEvent,
  ToolCallEvent,
  ToolCallLine,
} from "./types.js";

export function defaultCacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(os.homedir(), ".cache");
  return join(base, "claude-puppet", "sessions");
}

type SessionState = {
  info: SessionInfo;
  transcript: TranscriptStream | null;
  toolCalls: JsonlTail | null;
  /** Last time we saw any pty data or tool call for this session. */
  lastActivityMs: number;
};

export type WatcherEvents = {
  onSessionOpen: (info: SessionInfo) => void;
  onSessionClose: (id: string, ts: number) => void;
  onPtyData: (ev: PtyDataEvent) => void;
  onToolCall: (ev: ToolCallEvent) => void;
  onMasterSummary: (ev: MasterSummaryEvent) => void;
  onStatusChange: (ev: StatusChangeEvent) => void;
};

// Module-level pointer to the most-recently-started watcher. The screen
// poller imports `getSessionStatus()` below to skip ticks for non-alive
// sessions without having to receive the watcher as a constructor arg
// (the wiring lives in index.ts, which we don't own). Set in start().
let _active: SessionsWatcher | null = null;

/**
 * Look up the cached status of a watched session, or `null` if the session
 * isn't tracked. Used by the screen poller to skip ticks for closed slaves
 * before issuing an MCP `read_screen` call.
 */
export function getSessionStatus(id: string): string | null {
  if (!_active) return null;
  const info = _active.getSessionInfo(id);
  if (!info) return null;
  return info.status ?? null;
}

// Status-flip poll cadence. The puppet daemon exposes no notification channel
// for status changes (the MCP transport is request/reply only), so we poll
// state.db. Trade-off: lower = snappier alive→closed UX at the cost of more
// SQLite reads per second. 750ms keeps perceived lag under ~1s while keeping
// the steady-state read rate well under 2 Hz. Floor is 500ms — below that the
// constant SQLite overhead becomes a dashboard CPU floor with no UX gain.
const STATUS_POLL_INTERVAL_MS = Math.max(
  500,
  Number(process.env.PUPPET_DASH_STATUS_POLL_MS) || 750,
);

export class SessionsWatcher {
  private readonly root: string;
  private readonly sessions = new Map<string, SessionState>();
  private rootWatcher: chokidar.FSWatcher | null = null;
  private globalToolCalls: JsonlTail | null = null;
  private readonly stateDb = new StateDb();
  private statusPollTimer: NodeJS.Timeout | null = null;

  constructor(
    root: string | undefined,
    private readonly handlers: WatcherEvents,
  ) {
    this.root = root ?? defaultCacheRoot();
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  getRoot(): string {
    return this.root;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  /** Snapshot of the cached SessionInfo for a watched id, or undefined. */
  getSessionInfo(id: string): SessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  /** Build a fresh master_summary aggregate from current session state. */
  buildMasterSummary(): MasterSummary[] {
    const byOwner = new Map<string, MasterSummary>();
    for (const st of this.sessions.values()) {
      const owner = st.info.owner ?? "anonymous";
      let m = byOwner.get(owner);
      if (!m) {
        m = { id: owner, liveCount: 0, totalCount: 0, lastActivityMs: 0 };
        byOwner.set(owner, m);
      }
      m.totalCount += 1;
      const isLive =
        !st.info.exited &&
        (st.info.status === undefined ||
          st.info.status === "running" ||
          st.info.status === "alive");
      if (isLive) m.liveCount += 1;
      if (st.lastActivityMs > m.lastActivityMs) {
        m.lastActivityMs = st.lastActivityMs;
      }
    }
    return [...byOwner.values()].sort((a, b) => {
      // Live first, then most-recent activity.
      if (a.liveCount !== b.liveCount) return b.liveCount - a.liveCount;
      return b.lastActivityMs - a.lastActivityMs;
    });
  }

  private emitMasterSummary(): void {
    this.handlers.onMasterSummary({
      type: "master_summary",
      masters: this.buildMasterSummary(),
    });
  }

  async start(): Promise<void> {
    // Register as the active watcher so the module-level getSessionStatus()
    // accessor (used by screen-poller) sees this instance.
    _active = this;
    await fs.mkdir(this.root, { recursive: true });

    // Pick up sessions that already exist before we started.
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          await this.handleSessionDir(join(this.root, e.name));
        }
      }
    } catch {
      // ignore
    }

    // Watch parent dir for new session subdirs (depth 0).
    this.rootWatcher = chokidar.watch(this.root, {
      depth: 0,
      ignoreInitial: true,
      persistent: true,
    });
    this.rootWatcher.on("addDir", (p) => {
      if (p === this.root) return;
      void this.handleSessionDir(p);
    });
    this.rootWatcher.on("unlinkDir", (p) => {
      if (p === this.root) return;
      const id = basename(p);
      void this.closeSession(id);
    });

    // Start the non-session-scoped master tool_calls.jsonl tail.
    const globalPath = join(this.root, "tool_calls.jsonl");
    this.globalToolCalls = new JsonlTail(globalPath, (line) =>
      this.emitToolCallLine(null, line),
    );
    await this.globalToolCalls.start();

    // Initial summary emit (so a fresh client snapshot has it).
    this.emitMasterSummary();

    // Status-flip poller. Runs every STATUS_POLL_INTERVAL_MS and emits
    // status_change events for any watched session whose state.db row's
    // status doesn't match our cached SessionInfo.status.
    this.statusPollTimer = setInterval(
      () => void this.pollStatusFlips(),
      STATUS_POLL_INTERVAL_MS,
    );
    this.statusPollTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (_active === this) _active = null;
    if (this.rootWatcher) {
      await this.rootWatcher.close();
      this.rootWatcher = null;
    }
    if (this.globalToolCalls) {
      await this.globalToolCalls.stop();
      this.globalToolCalls = null;
    }
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
    for (const [id] of this.sessions) {
      await this.closeSession(id);
    }
  }

  private async handleSessionDir(dirPath: string): Promise<void> {
    const id = basename(dirPath);
    if (this.sessions.has(id)) return;

    let openedAt = Date.now();
    try {
      const s = await fs.stat(dirPath);
      openedAt = s.birthtimeMs || s.ctimeMs || Date.now();
    } catch {
      // ignore
    }

    // Enrich from state.db when available (cols/rows/status/pid/permission_mode/owner).
    const dbRow = await this.stateDb.getRow(id);

    // Initial transcript size — drives the "hide empty (0-line) sessions" filter.
    let bytesSeen = 0;
    try {
      const tStat = await fs.stat(join(dirPath, "transcripts", "transcript.jsonl"));
      bytesSeen = tStat.size;
    } catch {
      // file may not exist yet; bytesSeen stays 0
    }

    const info: SessionInfo = {
      id,
      openedAt: Math.round(openedAt),
      cols: dbRow?.cols ?? 200,
      rows: dbRow?.rows ?? 50,
      pid: dbRow?.pid ?? undefined,
      permissionMode: dbRow?.permission_mode ?? undefined,
      cwd: dbRow?.cwd ?? undefined,
      status: dbRow?.status ?? "running",
      exited: dbRow?.status && dbRow.status !== "running" ? true : undefined,
      exitCode: dbRow?.exit_code ?? undefined,
      exitSignal: dbRow?.exit_signal ?? undefined,
      owner: dbRow?.owner ?? undefined,
      bytesSeen,
    };
    const state: SessionState = {
      info,
      transcript: null,
      toolCalls: null,
      lastActivityMs: info.openedAt,
    };
    this.sessions.set(id, state);
    this.handlers.onSessionOpen(info);
    this.emitMasterSummary();

    // Start transcript tail. The transcripts/ dir + transcript.jsonl may not
    // exist yet at the instant the session dir appears; chokidar tolerates
    // watching a non-existent path and will fire 'add' once it shows up.
    const transcriptPath = join(dirPath, "transcripts", "transcript.jsonl");
    state.transcript = new TranscriptStream(id, transcriptPath, (ev) => {
      state.lastActivityMs = ev.ts;
      this.handlers.onPtyData(ev);
    });
    await state.transcript.start();

    // Per-session tool_calls.jsonl
    const toolCallsPath = join(dirPath, "tool_calls.jsonl");
    state.toolCalls = new JsonlTail(toolCallsPath, (line) =>
      this.emitToolCallLine(id, line),
    );
    await state.toolCalls.start();
  }

  private async closeSession(id: string): Promise<void> {
    const state = this.sessions.get(id);
    if (!state) return;
    this.sessions.delete(id);
    if (state.transcript) {
      await state.transcript.stop();
    }
    if (state.toolCalls) {
      await state.toolCalls.stop();
    }
    state.info.exited = true;
    // Try to get final status from DB (may have been updated to crashed/exited).
    const finalRow = await this.stateDb.getRow(id);
    if (finalRow) {
      state.info.status = finalRow.status;
      state.info.exitCode = finalRow.exit_code ?? undefined;
      state.info.exitSignal = finalRow.exit_signal ?? undefined;
    }
    this.handlers.onSessionClose(id, Date.now());
    this.emitMasterSummary();
  }

  private async pollStatusFlips(): Promise<void> {
    const ids = [...this.sessions.keys()];
    if (ids.length === 0) return;
    const map = await this.stateDb.getStatusForIds(ids);
    let summaryDirty = false;
    if (map.size > 0) {
      for (const id of ids) {
        const newStatus = map.get(id);
        if (!newStatus) continue;
        const st = this.sessions.get(id);
        if (!st) continue;
        const prev = st.info.status;
        if (prev !== newStatus) {
          st.info.status = newStatus;
          if (newStatus !== "running" && newStatus !== "alive") {
            st.info.exited = true;
          }
          this.handlers.onStatusChange({
            type: "status_change",
            id,
            status: newStatus,
            ts: Date.now(),
          });
          summaryDirty = true;
        }
      }
    }
    // Late-arriving owner: when a slave is opened, the dir appears slightly
    // before the puppet daemon writes the owner column. Sweep the
    // owner-less sessions on each tick and pull the owner if it's appeared.
    for (const id of ids) {
      const st = this.sessions.get(id);
      if (!st) continue;
      if (st.info.owner) continue;
      const owner = await this.stateDb.getOwner(id);
      if (owner) {
        st.info.owner = owner;
        summaryDirty = true;
      }
    }
    if (summaryDirty) this.emitMasterSummary();
  }

  private emitToolCallLine(sessionId: string | null, line: string): void {
    let parsed: ToolCallLine;
    try {
      parsed = JSON.parse(line) as ToolCallLine;
    } catch {
      return;
    }
    if (typeof parsed?.ts !== "number" || typeof parsed.op !== "string") return;
    if (sessionId) {
      const st = this.sessions.get(sessionId);
      if (st) st.lastActivityMs = parsed.ts;
    }
    this.handlers.onToolCall({
      type: "tool_call",
      id: sessionId,
      ts: parsed.ts,
      op: parsed.op,
      args: parsed.args,
      result: parsed.result,
      error: parsed.error ?? null,
      duration_ms:
        typeof parsed.duration_ms === "number" ? parsed.duration_ms : 0,
      source: typeof parsed.source === "string" ? parsed.source : undefined,
    });
  }
}
