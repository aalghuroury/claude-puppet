// Transcript replay overlay. Renders a separate xterm.js instance on top of
// the live terminal, fed from the in-memory ring buffer (`ptyEvents`).
//
// On mount we capture the current event list (immutable for replay duration).
// Scrubber slider sets the cursor index; play+speed pumps it forward via
// requestAnimationFrame using the original wall-clock deltas (scaled by
// speed). When closed, the live terminal resumes from its stream — no special
// handoff needed because we're rendered as an absolute overlay.

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, X, Rewind, FastForward } from "lucide-react";
import { useTerminal } from "../hooks/useTerminal";
import { useStore } from "../store";
import type { PtyDataEvent } from "../types";

type Props = {
  sessionId: string;
  events: PtyDataEvent[];
  onClose: () => void;
};

const SPEEDS = [0.5, 1, 2, 5, 10] as const;

export function TranscriptReplay({
  sessionId,
  events,
  onClose,
}: Props): JSX.Element {
  // Snapshot the events at mount time so the slider has a stable range.
  const snapshot = useMemo(
    () => events.filter((e) => e.dir === "out").slice(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const session = useStore((s) => s.sessions.get(sessionId));
  const cols = session?.cols ?? 200;
  const rows = session?.rows ?? 50;

  const { containerRef, innerRef, handleRef } = useTerminal({
    cols,
    rows,
    fontSize: 13,
    fitMode: "scale",
    webgl: false,
    cursorBlink: false,
    scrollback: 20_000,
  });

  const [cursor, setCursor] = useState(0); // index in snapshot
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const lastWrittenRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Write all bytes from `lastWrittenRef.current` up to `cursor`.
  useEffect(() => {
    const t = handleRef.current;
    if (!t) return;
    if (cursor < lastWrittenRef.current) {
      // Scrubbed backwards — full reset.
      t.clear();
      lastWrittenRef.current = 0;
    }
    for (let i = lastWrittenRef.current; i < cursor; i++) {
      t.write(snapshot[i]?.text ?? "");
    }
    lastWrittenRef.current = cursor;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  // Play loop — wall-clock-faithful, scaled by speed.
  useEffect(() => {
    if (!playing) return;
    if (cursor >= snapshot.length) {
      setPlaying(false);
      return;
    }
    let lastTick = performance.now();
    const tick = (): void => {
      const now = performance.now();
      const elapsed = (now - lastTick) * speed;
      lastTick = now;
      // Advance through events whose inter-arrival time fits in `elapsed` ms.
      // Use a budget so a long idle gap doesn't rocket the cursor instantly.
      let budget = elapsed;
      let nextCursor = cursor;
      while (nextCursor < snapshot.length - 1 && budget > 0) {
        const dt = Math.max(
          1,
          (snapshot[nextCursor + 1].ts - snapshot[nextCursor].ts) / speed,
        );
        if (dt > budget) {
          budget = 0;
          break;
        }
        budget -= dt;
        nextCursor++;
      }
      // Always advance at least one event per frame so we never stall.
      if (nextCursor === cursor && cursor < snapshot.length) nextCursor = cursor + 1;
      setCursor(Math.min(nextCursor, snapshot.length));
      if (nextCursor >= snapshot.length) {
        setPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed]);

  if (snapshot.length === 0) {
    return (
      <div className="absolute inset-0 z-20 bg-canvas/95 backdrop-blur-sm flex flex-col items-center justify-center text-fg-dim text-sm gap-3">
        <div className="font-display-quote italic">no replay buffer for this session · yet</div>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1 text-xs border border-rule hover:border-accent-quiet hover:text-accent font-ui"
          style={{ borderRadius: 0 }}
        >
          close
        </button>
      </div>
    );
  }

  const first = snapshot[0]?.ts ?? 0;
  const last = snapshot[snapshot.length - 1]?.ts ?? 0;
  const cur = snapshot[Math.max(0, cursor - 1)]?.ts ?? first;
  const elapsedSec = ((cur - first) / 1000).toFixed(1);
  const totalSec = ((last - first) / 1000).toFixed(1);

  return (
    <div className="absolute inset-0 z-20 bg-canvas/96 backdrop-blur-sm flex flex-col">
      <div className="flex items-center justify-between px-3 py-1.5 rule-h bg-panel text-xs">
        <div className="flex items-center gap-2 text-accent">
          <Rewind size={13} />
          <span className="font-ui tracking-ultra-wide uppercase text-[9px]">
            replay mode
          </span>
          <span className="text-fg-dim ml-2 tabular-nums font-mono">
            event {cursor}/{snapshot.length} · {elapsedSec}s / {totalSec}s
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Exit replay"
          className="flex items-center gap-1 px-2 py-0.5 text-fg-mid hover:text-err focus:outline-none font-ui"
        >
          <X size={12} />
          exit
        </button>
      </div>

      <div
        ref={containerRef}
        className="flex-1 relative bg-recess scanlines xterm-cell overflow-hidden"
      >
        <div ref={innerRef} className="absolute inset-0" />
      </div>

      <div className="flex items-center gap-3 px-3 py-2 border-t border-rule bg-panel">
        <button
          type="button"
          onClick={() => setPlaying((x) => !x)}
          aria-label={playing ? "Pause replay" : "Play replay"}
          className="p-1.5 border border-rule text-fg hover:border-accent-quiet hover:text-accent focus:outline-none"
          style={{ borderRadius: 0 }}
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <input
          type="range"
          min={0}
          max={snapshot.length}
          step={1}
          value={cursor}
          onChange={(e) => {
            setPlaying(false);
            setCursor(Number(e.target.value));
          }}
          aria-label="Replay scrubber"
          className="flex-1 accent-accent"
          style={{ accentColor: "var(--accent)" }}
        />
        <div className="flex items-center gap-1">
          <FastForward size={11} className="text-fg-dim" />
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              aria-label={`Replay speed ${s}x`}
              aria-pressed={s === speed}
              className={`px-1.5 py-0.5 text-[10px] tabular-nums border focus:outline-none font-mono ${
                s === speed
                  ? "border-accent text-accent bg-accent/10"
                  : "border-rule text-fg-dim hover:text-fg"
              }`}
              style={{ borderRadius: 0 }}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
