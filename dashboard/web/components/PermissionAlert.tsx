// Heuristic permission-UI detector. We watch each session's pty event ring
// buffer for tokens commonly emitted by Ink modal prompts and surface a toast.

import { useEffect, useState } from "react";
import { ShieldAlert, X } from "lucide-react";
import { useStore } from "../store";

const PATTERNS: RegExp[] = [
  /Allow\s+(this|that|the)/i,
  /Permission\s+required/i,
  /\(Y\)es\s*\/\s*\(N\)o/i,
  /Do you want to (proceed|continue)/i,
  /\bapprove\b.*\?\s*$/im,
  /❯/,
];

type Alert = { id: string; ts: number };

export function PermissionAlert(): JSX.Element {
  const ptyEvents = useStore((s) => s.ptyEvents);
  const focusedId = useStore((s) => s.focusedId);
  const setFocused = useStore((s) => s.setFocused);
  const sessions = useStore((s) => s.sessions);

  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    const fired = new Map<string, number>();
    const next: Alert[] = [];
    const now = Date.now();
    for (const [sid, buf] of ptyEvents) {
      // Aggregate the last few outbound chunks for matching.
      const recent = buf.slice(-6).filter((e) => e.dir === "out");
      const text = recent.map((e) => e.text).join("");
      if (!text) continue;
      const matched = PATTERNS.some((rx) => rx.test(text));
      if (matched) {
        const lastMs = recent[recent.length - 1]?.ts ?? 0;
        if (now - lastMs < 8000) {
          next.push({ id: sid, ts: lastMs });
          fired.set(sid, lastMs);
        }
      }
    }
    setAlerts(next);
  }, [ptyEvents]);

  // Auto-dismiss expired alerts every second.
  useEffect(() => {
    const i = setInterval(() => {
      const now = Date.now();
      setAlerts((prev) => prev.filter((a) => now - a.ts < 8000));
    }, 1000);
    return () => clearInterval(i);
  }, []);

  if (alerts.length === 0) return <></>;

  return (
    <div className="fixed bottom-12 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {alerts
        .filter((a) => a.id !== focusedId && sessions.has(a.id))
        .slice(-3)
        .map((a) => (
          <div
            key={a.id}
            className="pointer-events-auto flex items-start gap-3 px-3 py-2 border border-warn/60 bg-panel animate-fade-up min-w-[280px] max-w-sm corners"
            style={{ borderRadius: 0 }}
          >
            <ShieldAlert size={15} className="text-warn mt-0.5 shrink-0" />
            <div className="flex-1 text-[11px]">
              <div className="text-warn uppercase text-[9px] tracking-ultra-wide">
                permission UI detected
              </div>
              <div className="text-fg-dim truncate mt-1 font-mono">
                session{" "}
                <button
                  type="button"
                  onClick={() => setFocused(a.id)}
                  className="text-accent hover:underline"
                >
                  {a.id}
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setAlerts((p) => p.filter((x) => x.id !== a.id))}
              className="text-fg-dim hover:text-fg"
            >
              <X size={12} />
            </button>
          </div>
        ))}
    </div>
  );
}
