import { useEffect, useMemo, useRef, useState } from "react";
import { Pin, PinOff, Search, Layers } from "lucide-react";
import { useStore } from "../store";
import { ToolCallRow } from "./ToolCallEvent";
import type { ToolCallEvent } from "../types";

function IconBtn({
  on,
  onClick,
  label,
  children,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      title={label}
      className={`h-6 w-6 flex items-center justify-center border focus:outline-none transition-colors ${
        on
          ? "border-accent text-accent bg-accent/10"
          : "border-rule text-fg-dim hover:border-accent-quiet hover:text-fg-mid"
      }`}
      style={{ borderRadius: 0 }}
    >
      {children}
    </button>
  );
}

export function ToolCallTimeline(): JSX.Element {
  const calls = useStore((s) => s.toolCalls);
  const sessions = useStore((s) => s.sessions);
  const setFocused = useStore((s) => s.setFocused);

  const [sessionFilter, setSessionFilter] = useState<string | "all">("all");
  const [search, setSearch] = useState<string>("");
  const [groupBySession, setGroupBySession] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [now, setNow] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  // Auto-scroll back to top on new events when enabled.
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [calls.length, autoScroll]);

  // Build a regex-tolerant matcher: try regex, fall back to substring.
  const matcher = useMemo(() => {
    const q = search.trim();
    if (!q) return null;
    try {
      const rx = new RegExp(q, "i");
      return (s: string) => rx.test(s);
    } catch {
      const lc = q.toLowerCase();
      return (s: string) => s.toLowerCase().includes(lc);
    }
  }, [search]);

  const filtered = useMemo(() => {
    return calls.filter((c) => {
      if (sessionFilter !== "all" && c.id !== sessionFilter) return false;
      if (matcher) {
        const hay = `${c.op} ${c.id ?? ""}`;
        if (!matcher(hay)) return false;
      }
      return true;
    });
  }, [calls, sessionFilter, matcher]);

  const grouped = useMemo(() => {
    if (!groupBySession) return null;
    const m = new Map<string, ToolCallEvent[]>();
    for (const ev of filtered) {
      const key = ev.id ?? "(global)";
      let bucket = m.get(key);
      if (!bucket) {
        bucket = [];
        m.set(key, bucket);
      }
      bucket.push(ev);
    }
    return [...m.entries()];
  }, [filtered, groupBySession]);

  const sessionIds = [...sessions.keys()];

  return (
    <aside className="w-[324px] shrink-0 bg-canvas flex flex-col overflow-hidden">
      <div className="px-3 h-12 flex items-center gap-2 rule-h">
        <div className="flex flex-col leading-tight">
          <span className="text-[9px] uppercase tracking-ultra-wide text-fg-dim">
            timeline
          </span>
          <span className="font-display-soft text-[13px] text-fg leading-none mt-0.5 tabular-nums">
            <span className="text-accent">{filtered.length}</span>
            <span className="text-fg-faint font-ui text-[10px]"> / {calls.length}</span>
          </span>
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <IconBtn
            on={groupBySession}
            onClick={() => setGroupBySession((x) => !x)}
            label={groupBySession ? "Ungroup tool calls" : "Group by session"}
          >
            <Layers size={12} />
          </IconBtn>
          <IconBtn
            on={autoScroll}
            onClick={() => setAutoScroll((x) => !x)}
            label={autoScroll ? "Pause auto-scroll" : "Resume auto-scroll"}
          >
            {autoScroll ? <Pin size={12} /> : <PinOff size={12} />}
          </IconBtn>
        </div>
      </div>
      <div className="px-3 py-2 rule-h grid gap-1.5">
        <select
          value={sessionFilter}
          onChange={(e) => setSessionFilter(e.target.value as typeof sessionFilter)}
          aria-label="Filter by session"
          className="bg-panel border border-rule text-fg text-[11px] px-1.5 py-1 focus:outline-none focus:border-accent-quiet font-mono"
          style={{ borderRadius: 0 }}
        >
          <option value="all">all sessions</option>
          {sessionIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search
            size={10}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-dim pointer-events-none"
          />
          <input
            type="text"
            placeholder="op or sid · regex"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search tool calls by op or session"
            className="w-full bg-panel border border-rule text-fg text-[11px] pl-6 pr-1.5 py-1 focus:outline-none focus:border-accent-quiet placeholder:text-fg-faint placeholder:italic font-mono tabular-nums"
            style={{ borderRadius: 0 }}
          />
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const top = (e.target as HTMLDivElement).scrollTop;
          if (top > 50 && autoScroll) setAutoScroll(false);
        }}
        className="flex-1 overflow-y-auto panel-scroll"
      >
        {filtered.length === 0 ? (
          <div className="p-6 text-[11px] text-fg-dim text-center font-display-quote">
            no events · yet
          </div>
        ) : grouped ? (
          grouped.map(([sid, evs]) => (
            <div key={sid}>
              <div className="sticky top-0 z-10 px-3 py-1 bg-panel rule-h border-rule text-[9px] uppercase tracking-ultra-wide text-fg-dim flex items-center gap-2">
                <span className="font-mono text-fg-mid">{sid}</span>
                <span className="ml-auto text-fg-faint tabular-nums">{evs.length}</span>
              </div>
              {evs.map((ev, i) => (
                <ToolCallRow
                  key={`${ev.ts}-${ev.op}-${i}`}
                  event={ev}
                  now={now}
                  onSessionClick={(id) => setFocused(id)}
                />
              ))}
            </div>
          ))
        ) : (
          filtered.map((ev, i) => (
            <ToolCallRow
              key={`${ev.ts}-${ev.op}-${i}`}
              event={ev}
              now={now}
              onSessionClick={(id) => setFocused(id)}
            />
          ))
        )}
      </div>
    </aside>
  );
}
