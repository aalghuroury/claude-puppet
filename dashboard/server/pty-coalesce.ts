// Coalesces high-frequency `pty_data` "out" events per session.
//
// Spinner/timer repaints from a slave Claude can fire at ~16 events per
// second; rebroadcasting each one over WS to multiple clients dominates
// dashboard token-economy noise. This wrapper holds incoming "out" chunks
// per session and flushes when EITHER `flushMs` ms have elapsed since the
// first held byte OR accumulated `text` length exceeds `flushBytes`.
//
// "in" direction events (master keystrokes) are passed through unchanged
// — those are user-meaningful per-event and very low-frequency.

import type { PtyDataEvent } from "./types.js";

type PendingChunk = {
  text: string;
  totalLen: number;
  firstTs: number;
  lastTs: number;
  timer: NodeJS.Timeout | null;
};

export function coalescePtyData(
  emit: (ev: PtyDataEvent) => void,
  flushMs: number = 50,
  flushBytes: number = 8192,
): (ev: PtyDataEvent) => void {
  const pending = new Map<string, PendingChunk>();

  const flush = (id: string): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = null;
    }
    emit({
      type: "pty_data",
      id,
      ts: p.lastTs,
      dir: "out",
      text: p.text,
    });
  };

  return (ev: PtyDataEvent): void => {
    if (ev.dir !== "out") {
      // Master keystrokes / "in" direction — pass through immediately.
      // Any pending out-chunk for this id is preserved (it has a timer).
      emit(ev);
      return;
    }

    const existing = pending.get(ev.id);
    if (!existing) {
      const p: PendingChunk = {
        text: ev.text,
        totalLen: ev.text.length,
        firstTs: ev.ts,
        lastTs: ev.ts,
        timer: null,
      };
      // If this single chunk already exceeds the byte threshold, emit it
      // immediately. Otherwise schedule a flush.
      if (p.totalLen >= flushBytes) {
        emit({ type: "pty_data", id: ev.id, ts: p.lastTs, dir: "out", text: p.text });
        return;
      }
      p.timer = setTimeout(() => flush(ev.id), flushMs);
      pending.set(ev.id, p);
      return;
    }

    existing.text += ev.text;
    existing.totalLen += ev.text.length;
    existing.lastTs = ev.ts;

    if (existing.totalLen >= flushBytes) {
      flush(ev.id);
    }
  };
}
