// Single Zustand store. All ws events flow through `applyEvent`.

import { create } from "zustand";
import { sendClientMessage } from "./ws";
import type {
  Bucket,
  MasterSummary,
  MasterViewRow,
  Metrics,
  PtyDataEvent,
  ServerEvent,
  SessionInfo,
  ToolCallEvent,
  WsStatus,
} from "./types";

const PTY_RING_SIZE = 200;
const TOOLCALL_RING_SIZE = 1000;
const METRIC_WINDOW_SEC = 60;

const VISIBLE_SET_DEBOUNCE_MS = 5000;

export type MasterViewState = {
  rows: MasterViewRow[];
  ts: number;
  render_hash: string;
  content_hash: string;
};

export type StatusFilter = "alive" | "all";
export type EmptyFilter = "hide" | "show";

type State = {
  sessions: Map<string, SessionInfo>;
  toolCalls: ToolCallEvent[];
  ptyEvents: Map<string, PtyDataEvent[]>;
  metrics: Map<string, Metrics>;
  startedAt: number;
  totalBytes: number;
  totalEvents: number;
  recentEventTimes: number[]; // for events/sec rolling window
  focusedId: string | null;
  wsStatus: WsStatus;
  lastConnectedAt: number | null;

  // Master sidebar / filtering / master-view slices.
  masters: Map<string, MasterSummary>;
  selectedMasterId: string | null;
  statusFilter: StatusFilter;
  emptyFilter: EmptyFilter;          // hide sessions whose transcript has 0 bytes
  bytesSeenById: Map<string, number>; // accumulated bytes per session (for empty-filter)
  masterViews: Map<string, MasterViewState>;
  visibleSessionIds: Set<string>;

  // actions
  setFocused: (id: string | null) => void;
  setWsStatus: (s: WsStatus) => void;
  applyEvent: (ev: ServerEvent) => void;
  pushPtyToTerminal: (id: string, listener: (text: string) => void) => () => void;
  toggleStatusFilter: () => void;
  toggleEmptyFilter: () => void;
  selectMaster: (id: string | null) => void;
  setVisible: (id: string, visible: boolean) => void;
  flushVisibleSetNow: () => void;
};

// Per-session live "subscribers" — used by xterm cells to receive new bytes
// without re-rendering React on every chunk. Lives outside the store state
// because writes are extremely high-frequency.
const subscribers = new Map<string, Set<(text: string) => void>>();

function notifyPty(id: string, text: string): void {
  const set = subscribers.get(id);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(text);
    } catch {
      /* ignore */
    }
  }
}

function pushBucket(buckets: Bucket[], ts: number, bytes: number): Bucket[] {
  const sec = Math.floor(ts / 1000);
  const last = buckets[buckets.length - 1];
  if (last && last.ts === sec) {
    last.v += bytes;
  } else {
    buckets.push({ ts: sec, v: bytes });
  }
  const cutoff = sec - METRIC_WINDOW_SEC;
  let drop = 0;
  while (drop < buckets.length && buckets[drop].ts < cutoff) drop++;
  if (drop > 0) buckets.splice(0, drop);
  return buckets;
}

// Debounced visible_set flush.
let visibleSetTimer: number | null = null;
function scheduleVisibleSetFlush(): void {
  if (typeof window === "undefined") return;
  if (visibleSetTimer !== null) return;
  visibleSetTimer = window.setTimeout(() => {
    visibleSetTimer = null;
    const ids = [...useStore.getState().visibleSessionIds];
    sendClientMessage({ type: "visible_set", ids });
  }, VISIBLE_SET_DEBOUNCE_MS);
}

export const useStore = create<State>((set, get) => ({
  sessions: new Map(),
  toolCalls: [],
  ptyEvents: new Map(),
  metrics: new Map(),
  startedAt: Date.now(),
  totalBytes: 0,
  totalEvents: 0,
  recentEventTimes: [],
  focusedId:
    (typeof sessionStorage !== "undefined" &&
      sessionStorage.getItem("focusedId")) ||
    null,
  wsStatus: "connecting",
  lastConnectedAt: null,

  masters: new Map(),
  selectedMasterId: null,
  statusFilter: "alive",
  emptyFilter: "hide",
  bytesSeenById: new Map(),
  masterViews: new Map(),
  visibleSessionIds: new Set(),

  setFocused: (id) => {
    if (typeof sessionStorage !== "undefined") {
      if (id) sessionStorage.setItem("focusedId", id);
      else sessionStorage.removeItem("focusedId");
    }
    set({ focusedId: id });
  },

  setWsStatus: (s) =>
    set((prev) => ({
      wsStatus: s,
      lastConnectedAt: s === "open" ? Date.now() : prev.lastConnectedAt,
    })),

  toggleStatusFilter: () =>
    set((prev) => ({
      statusFilter: prev.statusFilter === "alive" ? "all" : "alive",
    })),

  toggleEmptyFilter: () =>
    set((prev) => ({
      emptyFilter: prev.emptyFilter === "hide" ? "show" : "hide",
    })),

  selectMaster: (id) => set({ selectedMasterId: id }),

  setVisible: (id, visible) => {
    const cur = get().visibleSessionIds;
    const has = cur.has(id);
    if (visible && has) return;
    if (!visible && !has) return;
    const next = new Set(cur);
    if (visible) next.add(id);
    else next.delete(id);
    set({ visibleSessionIds: next });
    scheduleVisibleSetFlush();
  },

  flushVisibleSetNow: () => {
    if (typeof window === "undefined") return;
    if (visibleSetTimer !== null) {
      window.clearTimeout(visibleSetTimer);
      visibleSetTimer = null;
    }
    const ids = [...get().visibleSessionIds];
    sendClientMessage({ type: "visible_set", ids });
  },

  applyEvent: (ev) => {
    const now = Date.now();
    switch (ev.type) {
      case "snapshot": {
        const sessions = new Map<string, SessionInfo>();
        const bytesSeenById = new Map<string, number>();
        for (const s of ev.sessions) {
          sessions.set(s.id, s);
          bytesSeenById.set(s.id, s.bytesSeen ?? 0);
        }
        set({ sessions, bytesSeenById });
        return;
      }
      case "session_open": {
        const sessions = new Map(get().sessions);
        sessions.set(ev.session.id, ev.session);
        const bytesSeenById = new Map(get().bytesSeenById);
        bytesSeenById.set(ev.session.id, ev.session.bytesSeen ?? 0);
        set({ sessions, bytesSeenById });
        return;
      }
      case "session_close": {
        const prev = get().sessions.get(ev.id);
        if (!prev) return;
        const sessions = new Map(get().sessions);
        sessions.set(ev.id, { ...prev, exited: true });
        set({ sessions });
        return;
      }
      case "status_change": {
        const prev = get().sessions.get(ev.id);
        if (!prev) return;
        const sessions = new Map(get().sessions);
        const isExited = ev.status !== "running" && ev.status !== "alive";
        sessions.set(ev.id, {
          ...prev,
          status: ev.status,
          exited: isExited ? true : prev.exited,
        });
        set({ sessions });
        return;
      }
      case "master_summary": {
        const m = new Map<string, MasterSummary>();
        for (const ms of ev.masters) m.set(ms.id, ms);
        set({ masters: m });
        return;
      }
      case "master_view": {
        const m = new Map(get().masterViews);
        m.set(ev.id, {
          rows: ev.rows,
          ts: ev.ts,
          render_hash: ev.render_hash,
          content_hash: ev.content_hash,
        });
        set({ masterViews: m });
        return;
      }
      case "pty_data": {
        // Append to ring buffer (used by FocusedSession event stream view).
        const map = new Map(get().ptyEvents);
        const buf = (map.get(ev.id) ?? []).slice();
        buf.push(ev);
        if (buf.length > PTY_RING_SIZE) buf.splice(0, buf.length - PTY_RING_SIZE);
        map.set(ev.id, buf);

        // Bump bytesSeen — drives the empty-session filter.
        const bytesSeenById = new Map(get().bytesSeenById);
        const prevBytes = bytesSeenById.get(ev.id) ?? 0;
        bytesSeenById.set(ev.id, prevBytes + ev.text.length);

        // Update metrics (only for outbound bytes — that's the visible terminal flow).
        const bytes = ev.dir === "out" ? ev.text.length : 0;
        const metrics = new Map(get().metrics);
        const m: Metrics = metrics.get(ev.id) ?? {
          bytesPerSec: [],
          totalBytes: 0,
          lastDataTs: 0,
        };
        const updated: Metrics = {
          bytesPerSec: pushBucket(m.bytesPerSec.slice(), ev.ts, bytes),
          totalBytes: m.totalBytes + bytes,
          lastDataTs: ev.ts,
        };
        metrics.set(ev.id, updated);

        // Forward to any xterm.js subscribers — out-of-react streaming.
        if (ev.dir === "out") notifyPty(ev.id, ev.text);

        // Rolling events/sec window (last 5s)
        const recent = get().recentEventTimes.filter((t) => now - t < 5_000);
        recent.push(now);

        set({
          ptyEvents: map,
          metrics,
          bytesSeenById,
          totalBytes: get().totalBytes + bytes,
          totalEvents: get().totalEvents + 1,
          recentEventTimes: recent,
        });
        return;
      }
      case "tool_call": {
        const tc = get().toolCalls.slice();
        tc.unshift(ev); // newest at top
        if (tc.length > TOOLCALL_RING_SIZE) tc.length = TOOLCALL_RING_SIZE;
        const recent = get().recentEventTimes.filter((t) => now - t < 5_000);
        recent.push(now);
        set({
          toolCalls: tc,
          totalEvents: get().totalEvents + 1,
          recentEventTimes: recent,
        });
        return;
      }
    }
  },

  pushPtyToTerminal: (id, listener) => {
    let set_ = subscribers.get(id);
    if (!set_) {
      set_ = new Set();
      subscribers.set(id, set_);
    }
    set_.add(listener);
    return () => {
      const s = subscribers.get(id);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) subscribers.delete(id);
    };
  },
}));

// Helper: snapshot recent pty bytes for a session, to feed the terminal on mount.
export function getReplayBytes(id: string): string {
  const buf = useStore.getState().ptyEvents.get(id);
  if (!buf) return "";
  let out = "";
  for (const ev of buf) {
    if (ev.dir === "out") out += ev.text;
  }
  return out;
}

// ─── Memoized derived selector ──────────────────────────────────────────────
//
// `selectVisibleSessions` returns a referentially-stable array when the
// inputs (selectedMasterId, statusFilter, sessions snapshot) haven't changed.

let lastInput: {
  sessionsRef: Map<string, SessionInfo>;
  bytesRef: Map<string, number>;
  selectedMasterId: string | null;
  statusFilter: StatusFilter;
  emptyFilter: EmptyFilter;
  cacheKey: string;
} | null = null;
let lastResult: SessionInfo[] = [];

export function selectVisibleSessions(s: State): SessionInfo[] {
  const { sessions, selectedMasterId, statusFilter, emptyFilter, bytesSeenById } = s;
  // Cheap structural cache key: ids + statuses + size + nonzero-bytes set.
  let cacheKey = `${selectedMasterId ?? "*"}|${statusFilter}|${emptyFilter}|${sessions.size}|`;
  for (const v of sessions.values()) {
    const has = (bytesSeenById.get(v.id) ?? 0) > 0 ? "1" : "0";
    cacheKey += `${v.id}:${v.status ?? ""}:${v.exited ? "1" : "0"}:${v.owner ?? ""}:${has};`;
  }
  if (
    lastInput &&
    lastInput.cacheKey === cacheKey &&
    lastInput.sessionsRef === sessions &&
    lastInput.bytesRef === bytesSeenById
  ) {
    return lastResult;
  }
  const out: SessionInfo[] = [];
  for (const v of sessions.values()) {
    const owner = v.owner ?? "anonymous";
    const isAlive =
      !v.exited &&
      (v.status === undefined || v.status === "running" || v.status === "alive");
    const hasContent = (bytesSeenById.get(v.id) ?? 0) > 0;
    if (statusFilter === "alive" && !isAlive) continue;
    if (emptyFilter === "hide" && !hasContent) continue;
    if (selectedMasterId !== null && owner !== selectedMasterId) continue;
    out.push(v);
  }
  // Stable order by openedAt.
  out.sort((a, b) => a.openedAt - b.openedAt);
  lastInput = {
    sessionsRef: sessions,
    bytesRef: bytesSeenById,
    selectedMasterId,
    statusFilter,
    emptyFilter,
    cacheKey,
  };
  lastResult = out;
  return out;
}
