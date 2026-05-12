import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}G`;
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

export function StatusBar(): JSX.Element {
  const totalBytes = useStore((s) => s.totalBytes);
  const sessions = useStore((s) => s.sessions);
  const recent = useStore((s) => s.recentEventTimes);
  const toolCalls = useStore((s) => s.toolCalls);
  const startedAt = useStore((s) => s.startedAt);
  const masters = useStore((s) => s.masters);
  const [, force] = useState(0);

  const sampleRef = useRef<{ ts: number; total: number }[]>([]);

  useEffect(() => {
    const i = setInterval(() => {
      const now = Date.now();
      sampleRef.current.push({ ts: now, total: useStore.getState().totalBytes });
      sampleRef.current = sampleRef.current.filter((x) => now - x.ts < 5000);
      force((x) => x + 1);
    }, 500);
    return () => clearInterval(i);
  }, []);

  const now = Date.now();
  const eps = recent.filter((t) => now - t < 5000).length / 5;
  const sessList = [...sessions.values()];
  const live = sessList.filter((s) => !s.exited).length;
  const crashed = sessList.filter((s) => s.status === "crashed").length;
  const exited = sessList.length - live - crashed;
  const upMs = now - startedAt;

  const samples = sampleRef.current;
  let bps = 0;
  if (samples.length >= 2) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = (last.ts - first.ts) / 1000;
    if (dt > 0) bps = Math.max(0, (last.total - first.total) / dt);
  }

  const tcCutoff = now - 5 * 60_000;
  const tcRecent = toolCalls.filter((t) => t.ts >= tcCutoff).length;
  const tcPerMin = Math.round((tcRecent / 5) * 10) / 10;

  return (
    <footer
      className="h-7 flex items-stretch bg-panel text-[10px] text-fg-mid font-mono tabular-nums"
      style={{ borderTop: "1px solid var(--rule)" }}
    >
      <Cell label="masters" value={String(masters.size)} accent />
      <Cell
        label="sessions"
        value={
          <>
            <span className="text-ok">{live}</span>
            <span className="text-fg-faint">/{exited}</span>
            {crashed > 0 && (
              <span className="text-err">·{crashed}</span>
            )}
          </>
        }
      />
      <Cell label="ev/s" value={eps.toFixed(1)} accent={eps > 0} />
      <Cell label="rate" value={`${fmtBytes(bps)}/s`} accent={bps > 0} />
      <Cell label="calls/min" value={String(tcPerMin)} />
      <Cell label="total" value={fmtBytes(totalBytes)} />
      <div className="flex-1" />
      <Cell label="uptime" value={fmtUptime(upMs)} />
    </footer>
  );
}

function Cell({
  label,
  value,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  accent?: boolean;
}): JSX.Element {
  return (
    <div className="px-3 flex items-center gap-1.5 rule-v border-rule">
      <span className="text-[8px] uppercase tracking-ultra-wide text-fg-dim">
        {label}
      </span>
      <span className={accent ? "text-accent" : "text-fg"}>{value}</span>
    </div>
  );
}
