import { memo, useState } from "react";
import { ChevronDown, ChevronRight, AlertTriangle, Eye } from "lucide-react";
import { useSettings } from "../settings";
import type { ToolCallEvent as ToolCallEventT } from "../types";

const OP_COLORS: Record<string, string> = {
  read_screen: "text-info",
  read_log: "text-info",
  drain_events: "text-info",
  send_keys: "text-warn",
  send_text: "text-warn",
  open_session: "text-ok",
  close_session: "text-fg-dim",
  interrupt: "text-err",
  wait_for: "text-fg-mid",
  wait_for_idle: "text-fg-mid",
  wait_and_read: "text-fg-mid",
  list_sessions: "text-fg",
  list_descendants: "text-fg",
  session_tree: "text-fg",
  resume_session: "text-ok",
  resize_session: "text-fg",
  set_permission_mode: "text-accent",
};

function opClass(op: string): string {
  if (OP_COLORS[op]) return OP_COLORS[op];
  if (op.startsWith("read") || op.startsWith("drain")) return "text-info";
  if (op.startsWith("wait")) return "text-fg-mid";
  if (op.startsWith("send")) return "text-warn";
  return "text-fg";
}

function relTime(ts: number, now: number): string {
  const ms = now - ts;
  if (ms < 1000) return `${ms}ms ago`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

type Props = {
  event: ToolCallEventT;
  now: number;
  onSessionClick: (id: string) => void;
};

function ToolCallRowImpl({ event, now, onSessionClick }: Props): JSX.Element {
  const showInline = useSettings((s) => s.showToolArgsInline);
  const [open, setOpen] = useState(showInline);
  const [showFull, setShowFull] = useState(false);
  const hasErr = !!event.error;
  return (
    <div
      className={`px-3 py-1.5 rule-h border-rule text-[11px] hover:bg-panel/50 transition-colors animate-slide-in-top font-mono ${
        hasErr ? "bg-err/5" : ""
      }`}
    >
      <div className="w-full flex items-center gap-2 text-left">
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          aria-label={open ? "Collapse details" : "Expand details"}
          aria-expanded={open}
          className="flex items-center gap-2 flex-1 min-w-0 focus:outline-none"
        >
          {open ? (
            <ChevronDown size={10} className="text-fg-faint shrink-0" />
          ) : (
            <ChevronRight size={10} className="text-fg-faint shrink-0" />
          )}
          <span
            className="text-fg-dim tabular-nums w-14 shrink-0 text-[10px]"
            title={new Date(event.ts).toLocaleString()}
          >
            {relTime(event.ts, now)}
          </span>
          <span
            className={`truncate min-w-0 ${opClass(event.op)}`}
            style={{ fontWeight: 500 }}
          >
            {event.op}
          </span>
          {event.source === "dashboard" && (
            <span
              className="px-1 text-[9px] tracking-ultra-wide bg-accent text-canvas shrink-0 font-ui"
              title="originated from the dashboard control surface"
            >
              DASH
            </span>
          )}
          {event.id && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (event.id) onSessionClick(event.id);
              }}
              aria-label={`Focus session ${event.id}`}
              className="px-1 text-[9px] text-fg-mid hover:text-accent border border-rule hover:border-accent-quiet truncate max-w-[120px]"
              title={event.id}
            >
              {event.id}
            </button>
          )}
          <span className="text-fg-faint tabular-nums ml-auto shrink-0 text-[10px]">
            {event.duration_ms}ms
          </span>
          {hasErr && (
            <AlertTriangle size={10} className="text-err shrink-0" />
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setShowFull((x) => !x);
          }}
          aria-label="View full args and result"
          title="View full args and result"
          className="p-0.5 text-fg-faint hover:text-accent focus:outline-none"
        >
          <Eye size={10} />
        </button>
      </div>
      {open && (
        <div className="mt-1.5 pl-4 grid gap-1 text-[10px]">
          <div>
            <span className="text-fg-faint mr-2 text-[9px] uppercase tracking-ultra-wide font-ui">
              args
            </span>
            <pre className="inline whitespace-pre-wrap break-all text-fg-mid">
              {showFull
                ? prettyJson(event.args)
                : tryStringify(event.args, 400)}
            </pre>
          </div>
          <div>
            <span className="text-fg-faint mr-2 text-[9px] uppercase tracking-ultra-wide font-ui">
              result
            </span>
            <pre className="inline whitespace-pre-wrap break-all text-fg-mid">
              {showFull
                ? prettyJson(event.result)
                : tryStringify(event.result, 400)}
            </pre>
          </div>
          {event.error && (
            <div>
              <span className="text-fg-faint mr-2 text-[9px] uppercase tracking-ultra-wide font-ui">
                error
              </span>
              <span className="text-err">{event.error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function tryStringify(v: unknown, maxLen: number): string {
  if (v === null || v === undefined) return "—";
  try {
    const s = JSON.stringify(v);
    return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
  } catch {
    return String(v);
  }
}

function prettyJson(v: unknown): string {
  if (v === null || v === undefined) return "—";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export const ToolCallRow = memo(ToolCallRowImpl);
