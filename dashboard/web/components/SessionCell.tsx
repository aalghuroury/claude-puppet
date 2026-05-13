import { memo, useEffect, useRef, useState } from "react";
import { Maximize2, Square, X } from "lucide-react";
import { useStore, getReplayBytes } from "../store";
import { useTerminal } from "../hooks/useTerminal";
import { useIntersection } from "../hooks/useIntersection";
import { SparklineSvg } from "./SparklineSvg";
import { control, authedFetch } from "../control";
import { pushToast } from "./Toasts";
import { useSettings } from "../settings";
import type { SessionInfo } from "../types";

type Props = {
  session: SessionInfo;
  index: number; // for keyboard shortcut hint (1-9)
};

const PERM_COLORS: Record<string, string> = {
  strict: "text-ok border-ok/40",
  acceptEdits: "text-info border-info/40",
  plan: "text-accent-soft border-accent-quiet/50",
  yolo: "text-err border-err/40",
};

function permClass(mode?: string): string {
  return (
    PERM_COLORS[mode ?? ""] ??
    "text-fg-dim border-rule"
  );
}

// Per-cell off-screen ring cap (chars). Matches plan's 32 KB hint.
const OFFSCREEN_RING_BYTES = 32 * 1024;

function SessionCellImpl({ session, index }: Props): JSX.Element {
  const cols = session.cols ?? 200;
  const rows = session.rows ?? 50;

  const { ref: intersectRef, isIntersecting } = useIntersection<HTMLDivElement>({
    rootMargin: "200px",
  });

  // Only instantiate xterm.js after we've ever intersected at least once.
  const [hasIntersected, setHasIntersected] = useState(false);
  useEffect(() => {
    if (isIntersecting && !hasIntersected) setHasIntersected(true);
  }, [isIntersecting, hasIntersected]);

  return (
    <div ref={intersectRef} className="contents">
      {hasIntersected ? (
        <SessionCellLive
          session={session}
          index={index}
          cols={cols}
          rows={rows}
          isVisible={isIntersecting}
        />
      ) : (
        <PlaceholderCell session={session} cols={cols} rows={rows} />
      )}
    </div>
  );
}

function PlaceholderCell({
  session,
  cols,
  rows,
}: {
  session: SessionInfo;
  cols: number;
  rows: number;
}): JSX.Element {
  const setFocused = useStore((s) => s.setFocused);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setFocused(session.id)}
      className="group relative flex flex-col text-left border border-rule bg-panel hover:border-accent-quiet overflow-hidden focus:outline-none focus:ring-1 focus:ring-accent [contain:strict]"
      style={{ minHeight: 200 }}
    >
      <div className="flex items-center justify-between px-3 py-1.5 rule-h border-rule text-[11px]">
        <span className="font-mono text-fg-mid truncate" title={session.id}>
          {session.id}
        </span>
        <span className="text-fg-faint tabular-nums text-[10px] font-mono">
          {cols}×{rows}
        </span>
      </div>
      <div className="flex-1 flex items-center justify-center text-[9px] uppercase tracking-ultra-wide text-fg-faint">
        idle — scroll to load
      </div>
    </div>
  );
}

type LiveProps = {
  session: SessionInfo;
  index: number;
  cols: number;
  rows: number;
  isVisible: boolean;
};

function SessionCellLive({
  session,
  index,
  cols,
  rows,
  isVisible,
}: LiveProps): JSX.Element {
  const { containerRef, innerRef, handleRef } = useTerminal({
    cols,
    rows,
    fontSize: 11,
    fitMode: "scale",
    webgl: false,
    cursorBlink: true,
  });
  const setFocused = useStore((s) => s.setFocused);
  const setVisible = useStore((s) => s.setVisible);
  const subscribe = useStore((s) => s.pushPtyToTerminal);
  const metrics = useStore((s) => s.metrics.get(session.id));
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const [pulse, setPulse] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const pulseTimer = useRef<number | null>(null);
  const offscreenRingRef = useRef<string>("");

  // Report visibility to the store (debounced flush sends visible_set over WS).
  useEffect(() => {
    setVisible(session.id, isVisible);
    return () => {
      // On unmount, clear visibility for this id.
      setVisible(session.id, false);
    };
  }, [session.id, isVisible, setVisible]);

  // Snapshot reload on first mount, then subscribe to live data.
  useEffect(() => {
    const t = handleRef.current;
    if (!t) return;
    let cancelled = false;
    const ac = new AbortController();

    void (async () => {
      try {
        const res = await authedFetch(
          `/api/sessions/${encodeURIComponent(session.id)}/snapshot`,
          { signal: ac.signal },
        );
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as { text?: string };
          if (typeof data.text === "string" && data.text.length > 0) {
            handleRef.current?.write(data.text);
          }
        } else {
          // Fall back to replay-buffer.
          const initial = getReplayBytes(session.id);
          if (initial) handleRef.current?.write(initial);
          if (res.status !== 404) {
            // eslint-disable-next-line no-console
            console.warn(
              `[SessionCell] snapshot ${session.id} HTTP ${res.status}; using replay buffer fallback`,
            );
          }
        }
      } catch {
        if (cancelled) return;
        const initial = getReplayBytes(session.id);
        if (initial) handleRef.current?.write(initial);
      }
    })();

    const writer = (text: string): void => {
      if (!isVisibleRef.current) {
        // Buffer to per-cell ring while off-screen (capped at OFFSCREEN_RING_BYTES).
        offscreenRingRef.current = (offscreenRingRef.current + text).slice(
          -OFFSCREEN_RING_BYTES,
        );
        return;
      }
      handleRef.current?.write(text);
      if (!reduceMotion) {
        setPulse(true);
        if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
        pulseTimer.current = window.setTimeout(() => setPulse(false), 200);
      }
    };
    const unsub = subscribe(session.id, writer);

    return () => {
      cancelled = true;
      ac.abort();
      unsub();
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, reduceMotion]);

  // Track latest visibility in a ref so the writer above sees it without
  // re-subscribing.
  const isVisibleRef = useRef(isVisible);
  useEffect(() => {
    const wasVisible = isVisibleRef.current;
    isVisibleRef.current = isVisible;
    if (!wasVisible && isVisible) {
      // Just re-intersected — flush the off-screen ring into xterm.
      const buf = offscreenRingRef.current;
      offscreenRingRef.current = "";
      if (buf) handleRef.current?.write(buf);
    }
  }, [isVisible]);

  // Close context menu on any outside click / escape.
  useEffect(() => {
    if (!contextMenu) return;
    const close = (): void => setContextMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  const exited = !!session.exited;
  const crashed = session.status === "crashed";
  const closed = session.status === "closed" || (exited && !crashed);
  const idle =
    metrics && metrics.lastDataTs
      ? Date.now() - metrics.lastDataTs > 1500
      : true;

  const borderClass = crashed
    ? "border-err/70"
    : closed
      ? "border-rule opacity-60"
      : pulse && !reduceMotion
        ? "border-accent"
        : "border-rule";

  const statusPill = crashed
    ? { dot: "bg-err animate-blip", txt: "text-err" }
    : closed
      ? { dot: "bg-fg-dim", txt: "text-fg-dim" }
      : idle
        ? { dot: "bg-ok", txt: "text-ok" }
        : { dot: "bg-ok animate-blip", txt: "text-ok" };

  const handleAction = async (action: "interrupt" | "close"): Promise<void> => {
    try {
      if (action === "interrupt") {
        await control.interrupt(session.id, false);
        pushToast("ok", `interrupt → ${session.id}`);
      } else if (action === "close") {
        if (!confirm(`Close session ${session.id}?`)) return;
        await control.closeSession(session.id);
        pushToast("ok", `close → ${session.id}`);
      }
    } catch (err) {
      pushToast("err", `${action} failed: ${(err as Error).message}`);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      data-status={crashed ? "crashed" : closed ? "closed" : "alive"}
      onClick={() => setFocused(session.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setFocused(session.id);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
      aria-label={`Focus session ${session.id}`}
      className={`group relative flex flex-col text-left border bg-panel hover:border-accent-quiet transition-colors animate-fade-up overflow-hidden focus:outline-none focus:ring-1 focus:ring-accent [contain:strict] ${borderClass}`}
      style={{ minHeight: 200 }}
    >
      <div className="flex items-center justify-between px-3 py-1.5 rule-h border-rule text-[11px]">
        <div className="flex items-center gap-2 min-w-0">
          <span
            aria-hidden
            className={`inline-block h-1.5 w-1.5 shrink-0 ${statusPill.dot}`}
            style={{ borderRadius: 0 }}
          />
          <span
            className="font-mono text-fg truncate max-w-[180px]"
            title={`${session.id} · ${cols}×${rows}`}
          >
            {session.id}
          </span>
          {session.pid !== undefined && (
            <span className="text-fg-faint tabular-nums font-mono text-[10px]">
              :{session.pid}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {index < 9 && (
            <kbd className="hidden md:inline-block h-4 min-w-[16px] px-1 text-center bg-rule/60 text-fg-dim text-[9px] tabular-nums font-mono leading-[16px]">
              {index + 1}
            </kbd>
          )}
          <span
            className={`px-1.5 py-0.5 border text-[9px] uppercase tracking-ultra-wide font-ui ${permClass(
              session.permissionMode,
            )}`}
            title={`permission mode: ${session.permissionMode ?? "unknown"}`}
          >
            {session.permissionMode ?? "—"}
          </span>
        </div>
      </div>
      <div
        ref={containerRef}
        className="xterm-cell relative flex-1 bg-recess scanlines overflow-hidden"
      >
        <div ref={innerRef} className="absolute inset-0" />
        {/* Hover action overlay */}
        <div
          className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity z-10"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label="Focus session"
            title="Focus"
            onClick={() => setFocused(session.id)}
            className="p-1 bg-panel/90 border border-rule text-fg-mid hover:text-accent hover:border-accent-quiet"
          >
            <Maximize2 size={11} />
          </button>
          <button
            type="button"
            aria-label="Interrupt session"
            title="Interrupt (Ctrl-C)"
            onClick={() => void handleAction("interrupt")}
            className="p-1 bg-panel/90 border border-rule text-fg-mid hover:text-warn hover:border-warn/50"
          >
            <Square size={11} />
          </button>
          <button
            type="button"
            aria-label="Close session"
            title="Close"
            onClick={() => void handleAction("close")}
            className="p-1 bg-panel/90 border border-rule text-fg-mid hover:text-err hover:border-err/50"
          >
            <X size={11} />
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between px-3 py-1.5 rule-h border-t border-rule text-[10px] text-fg-dim tabular-nums font-mono" style={{ borderBottom: 0 }}>
        <span title={`${cols} cols × ${rows} rows`}>
          <span className="text-fg-faint">{cols}×{rows}</span>
          <span className="text-fg-faint mx-1.5">·</span>
          <span className="text-fg-mid">{metrics ? metrics.totalBytes : 0}</span>
          <span className="text-fg-faint">b</span>
        </span>
        <span className="flex-1 mx-3 max-w-[140px]">
          <SparklineSvg data={metrics?.bytesPerSec ?? []} height={18} />
        </span>
        <span
          className={`uppercase tracking-ultra-wide text-[9px] font-ui ${statusPill.txt}`}
        >
          {crashed ? "crash" : closed ? "closed" : idle ? "idle" : "live"}
        </span>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          sessionId={session.id}
          onClose={() => setContextMenu(null)}
          onFocus={() => setFocused(session.id)}
        />
      )}
    </div>
  );
}

function ContextMenu({
  x,
  y,
  sessionId,
  onClose,
  onFocus,
}: {
  x: number;
  y: number;
  sessionId: string;
  onClose: () => void;
  onFocus: () => void;
}): JSX.Element {
  const send = async (keys: string[], label: string): Promise<void> => {
    try {
      await control.sendKeys(sessionId, keys);
      pushToast("ok", `${label} → ${sessionId}`);
    } catch (err) {
      pushToast("err", `${label} failed: ${(err as Error).message}`);
    }
    onClose();
  };
  const handleClose = async (): Promise<void> => {
    if (!confirm(`Close session ${sessionId}?`)) {
      onClose();
      return;
    }
    try {
      await control.closeSession(sessionId);
      pushToast("ok", `close → ${sessionId}`);
    } catch (err) {
      pushToast("err", `close failed: ${(err as Error).message}`);
    }
    onClose();
  };
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ position: "fixed", top: y, left: x }}
      className="z-50 min-w-[180px] border border-rule-bright bg-panel text-[11px] py-1 animate-slide-in-top"
    >
      <CtxItem onClick={() => { onFocus(); onClose(); }}>Focus</CtxItem>
      <CtxItem onClick={() => void send(["<C-c>"], "Ctrl-C")}>Send Ctrl-C</CtxItem>
      <CtxItem onClick={() => void send(["<Enter>"], "Enter")}>Send Enter</CtxItem>
      <CtxItem onClick={() => void send(["<Esc>"], "Esc")}>Send Esc</CtxItem>
      <CtxDivider />
      <CtxItem onClick={() => void handleClose()} danger>
        Close
      </CtxItem>
    </div>
  );
}

function CtxItem({
  onClick,
  children,
  danger,
}: {
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 hover:bg-rule/40 transition-colors ${
        danger ? "text-err hover:text-err" : "text-fg"
      }`}
    >
      {children}
    </button>
  );
}
function CtxDivider(): JSX.Element {
  return <div className="h-px bg-rule my-1" />;
}

export const SessionCell = memo(SessionCellImpl);
