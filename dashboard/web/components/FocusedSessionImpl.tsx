// Heavy focused-session implementation. Code-split out of the initial bundle
// via FocusedSession.tsx (React.lazy wrapper).
//
// Layout: 2-pane CSS-grid. LEFT = the existing xterm + control bar (raw PTY
// from the slave). RIGHT = MasterViewPanel (filtered classifier rows that the
// real master would actually receive). Collapses to single-column on viewports
// narrower than 1024 px so we never cramp the terminal.

import { useEffect, useRef, useState } from "react";
import { Maximize2, Square, Minimize2, X, Send } from "lucide-react";
import { useStore, getReplayBytes } from "../store";
import { useTerminal } from "../hooks/useTerminal";
import { MasterViewPanel } from "./MasterViewPanel";
import { TranscriptReplay } from "./TranscriptReplay";
import { control, authedFetch } from "../control";
import { pushToast } from "./Toasts";
import { useSettings } from "../settings";

type Props = { id: string };

export function FocusedSessionImpl({ id }: Props): JSX.Element {
  const session = useStore((s) => s.sessions.get(id));
  const setFocused = useStore((s) => s.setFocused);
  const subscribe = useStore((s) => s.pushPtyToTerminal);
  const setVisible = useStore((s) => s.setVisible);
  const ptyEvents = useStore((s) => s.ptyEvents.get(id));
  const reduceMotion = useSettings((s) => s.reduceMotion);

  const cols = session?.cols ?? 200;
  const rows = session?.rows ?? 50;

  const { containerRef, innerRef, handleRef } = useTerminal({
    cols,
    rows,
    fontSize: 13,
    fitMode: "scale",
    webgl: false,
    cursorBlink: true,
    scrollback: 20_000,
  });

  const [showReplay, setShowReplay] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [pulse, setPulse] = useState(false);
  const pulseTimer = useRef<number | null>(null);
  const [auditNoticeDismissed, setAuditNoticeDismissed] = useState<boolean>(
    () => {
      try {
        return (
          sessionStorage.getItem("dashboard.audit-notice-dismissed") === "1"
        );
      } catch {
        return false;
      }
    },
  );
  const dismissAuditNotice = (): void => {
    setAuditNoticeDismissed(true);
    try {
      sessionStorage.setItem("dashboard.audit-notice-dismissed", "1");
    } catch {
      /* ignore */
    }
  };

  // Mark this session as visible so the screen-poller polls master_view
  // for it, and the backend keeps its ring fresh.
  useEffect(() => {
    setVisible(id, true);
    return () => {
      setVisible(id, false);
    };
  }, [id, setVisible]);

  // Snapshot reload + live subscribe.
  useEffect(() => {
    const t = handleRef.current;
    if (!t) return;
    let cancelled = false;
    const ac = new AbortController();

    void (async () => {
      try {
        const res = await authedFetch(
          `/api/sessions/${encodeURIComponent(id)}/snapshot`,
          { signal: ac.signal },
        );
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as { text?: string };
          if (typeof data.text === "string" && data.text.length > 0) {
            handleRef.current?.write(data.text);
          }
        } else {
          const initial = getReplayBytes(id);
          if (initial) handleRef.current?.write(initial);
          if (res.status !== 404) {
            // eslint-disable-next-line no-console
            console.warn(
              `[FocusedSession] snapshot ${id} HTTP ${res.status}; fallback to replay buffer`,
            );
          }
        }
      } catch {
        if (cancelled) return;
        const initial = getReplayBytes(id);
        if (initial) handleRef.current?.write(initial);
      }
    })();

    const writer = (text: string): void => {
      handleRef.current?.write(text);
      if (!reduceMotion) {
        setPulse(true);
        if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
        pulseTimer.current = window.setTimeout(() => setPulse(false), 200);
      }
    };
    const unsub = subscribe(id, writer);
    return () => {
      cancelled = true;
      ac.abort();
      unsub();
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reduceMotion]);

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center text-fg-dim text-sm bg-canvas font-display-quote">
        session disappeared · returning to grid
      </div>
    );
  }

  const exited = !!session.exited;
  const crashed = session.status === "crashed";

  const sendKey = async (keys: string[], label: string): Promise<void> => {
    try {
      await control.sendKeys(id, keys);
      pushToast("ok", `${label} → ${id}`);
    } catch (err) {
      pushToast("err", `${label} failed: ${(err as Error).message}`);
    }
  };

  const sendTextSubmit = async (): Promise<void> => {
    const t = textInput;
    if (!t) return;
    try {
      await control.sendText(id, t);
      setTextInput("");
      pushToast("ok", `text → ${id}`);
    } catch (err) {
      pushToast("err", `send text failed: ${(err as Error).message}`);
    }
  };

  const handleClose = async (): Promise<void> => {
    if (!confirm(`Close session ${id}?`)) return;
    try {
      await control.closeSession(id);
      pushToast("ok", `close → ${id}`);
    } catch (err) {
      pushToast("err", `close failed: ${(err as Error).message}`);
    }
  };

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_26rem] overflow-hidden bg-canvas">
      <div className="flex flex-col overflow-hidden">
        {/* Header / control bar */}
        <div className="flex items-center gap-3 px-3 py-1.5 rule-h bg-panel text-xs">
          <button
            type="button"
            onClick={() => setFocused(null)}
            aria-label="Back to grid"
            className="p-1 text-fg-mid hover:text-accent focus:outline-none"
          >
            <Minimize2 size={13} />
          </button>
          <span className="font-mono text-fg" title={id}>
            {id}
          </span>
          {session.owner && (
            <span className="text-[10px] text-fg-dim font-ui" title="self-reported owner">
              <span className="text-fg-faint uppercase tracking-ultra-wide text-[9px]">owner</span>{" "}
              {session.owner}
            </span>
          )}
          <span className="text-[10px] text-fg-faint tabular-nums font-mono">
            {cols}×{rows}
          </span>
          {exited && (
            <span
              className={`text-[9px] uppercase tracking-ultra-wide font-ui ${
                crashed ? "text-err" : "text-fg-dim"
              }`}
            >
              {session.status ?? (crashed ? "crashed" : "closed")}
            </span>
          )}
          <div className="flex-1" />
          <CtrlBtn
            onClick={() => setShowReplay(true)}
            disabled={!ptyEvents || ptyEvents.length === 0}
            hoverColor="accent"
            title="Open transcript replay"
          >
            <Maximize2 size={11} className="inline -mt-0.5 mr-1" />
            replay
          </CtrlBtn>
          <CtrlBtn
            onClick={() => void sendKey(["<C-c>"], "Ctrl-C")}
            hoverColor="warn"
          >
            <Square size={11} className="inline -mt-0.5 mr-1" />
            ^C
          </CtrlBtn>
          <CtrlBtn onClick={() => void handleClose()} hoverColor="err">
            <X size={11} className="inline -mt-0.5 mr-1" />
            close
          </CtrlBtn>
        </div>

        {/* Terminal */}
        <div
          ref={containerRef}
          className={`flex-1 relative bg-recess scanlines xterm-cell overflow-hidden ${
            pulse && !reduceMotion ? "border-y border-accent" : ""
          }`}
        >
          <div ref={innerRef} className="absolute inset-0" />
          {showReplay && ptyEvents && (
            <TranscriptReplay
              sessionId={id}
              events={ptyEvents}
              onClose={() => setShowReplay(false)}
            />
          )}
        </div>

        {/* Audit-notice tip */}
        {!auditNoticeDismissed && (
          <div className="flex items-center gap-2 px-3 py-1 border-t border-rule bg-panel/40 text-fg-dim text-[10px]">
            <span className="flex-1 truncate font-ui">
              Sends from the dashboard appear in this session's tool_calls.jsonl as{" "}
              <code className="text-fg-mid font-mono">dashboard_*</code> ops with{" "}
              <code className="text-fg-mid font-mono">source:"dashboard"</code> — the master sees them.
            </span>
            <button
              type="button"
              onClick={dismissAuditNotice}
              aria-label="Dismiss audit notice"
              className="p-0.5 text-fg-faint hover:text-fg focus:outline-none shrink-0"
            >
              <X size={11} />
            </button>
          </div>
        )}

        {/* Text-send bar */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendTextSubmit();
          }}
          className="flex items-center gap-2 px-3 py-1.5 border-t border-rule bg-panel"
        >
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="send text · enter to submit"
            aria-label="Send text to session"
            className="flex-1 bg-canvas border border-rule text-fg text-[12px] px-2 py-1 focus:outline-none focus:border-accent-quiet placeholder:text-fg-faint placeholder:italic font-mono"
            style={{ borderRadius: 0 }}
            disabled={exited}
          />
          <CtrlBtn
            type="submit"
            disabled={exited || !textInput}
            hoverColor="accent"
          >
            <Send size={11} className="inline -mt-0.5 mr-1" />
            send
          </CtrlBtn>
          <CtrlBtn
            onClick={() => void sendKey(["<Enter>"], "Enter")}
            disabled={exited}
            hoverColor="accent"
            title="Enter"
          >
            ↵
          </CtrlBtn>
          <CtrlBtn
            onClick={() => void sendKey(["<Esc>"], "Esc")}
            disabled={exited}
            hoverColor="accent"
            title="Esc"
          >
            esc
          </CtrlBtn>
        </form>
      </div>

      {/* Right pane — master view (filtered). Hidden on narrow viewports. */}
      <div className="hidden lg:flex overflow-hidden flex-col min-w-0">
        <MasterViewPanel id={id} />
      </div>
    </div>
  );
}

function CtrlBtn({
  children,
  onClick,
  disabled,
  hoverColor,
  type = "button",
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  hoverColor: "accent" | "warn" | "err";
  type?: "button" | "submit";
  title?: string;
}): JSX.Element {
  const hover =
    hoverColor === "accent"
      ? "hover:text-accent hover:border-accent-quiet"
      : hoverColor === "warn"
        ? "hover:text-warn hover:border-warn/50"
        : "hover:text-err hover:border-err/50";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`h-6 px-2 text-[11px] border border-rule text-fg-mid bg-panel ${hover} disabled:opacity-40 disabled:hover:border-rule disabled:hover:text-fg-mid focus:outline-none transition-colors font-ui`}
      style={{ borderRadius: 0 }}
    >
      {children}
    </button>
  );
}
