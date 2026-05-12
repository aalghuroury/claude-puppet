import { useEffect, useState } from "react";
import { Header } from "./components/Header";
import { SessionGrid } from "./components/SessionGrid";
import { FocusedSession } from "./components/FocusedSession";
import { ToolCallTimeline } from "./components/ToolCallTimeline";
import { StatusBar } from "./components/StatusBar";
import { PermissionAlert } from "./components/PermissionAlert";
import { Toasts } from "./components/Toasts";
import { MasterSidebar } from "./components/MasterSidebar";
import { useStore } from "./store";
import { useSettings } from "./settings";
import { useWS } from "./hooks/useWS";

export default function App(): JSX.Element {
  useWS();
  const focusedId = useStore((s) => s.focusedId);
  const setFocused = useStore((s) => s.setFocused);
  const wsStatus = useStore((s) => s.wsStatus);
  const lastConnectedAt = useStore((s) => s.lastConnectedAt);
  const sessions = useStore((s) => s.sessions);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const cls = "reduce-motion";
    if (reduceMotion) document.documentElement.classList.add(cls);
    else document.documentElement.classList.remove(cls);
  }, [reduceMotion]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") {
        setFocused(null);
        return;
      }
      if (e.key === "g") {
        setFocused(null);
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const list = [...sessions.values()].sort(
          (a, b) => a.openedAt - b.openedAt,
        );
        const idx = Number(e.key) - 1;
        if (list[idx]) setFocused(list[idx].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessions, setFocused]);

  useEffect(() => {
    if (focusedId && !sessions.has(focusedId)) {
      setFocused(null);
    }
  }, [focusedId, sessions, setFocused]);

  return (
    <div className="h-screen w-screen flex flex-col bg-canvas overflow-hidden select-accent">
      <Header
        onToggleSidebar={() => setSidebarOpen((x) => !x)}
        sidebarOpen={sidebarOpen}
      />
      <div className="flex-1 flex overflow-hidden">
        <div className="hidden lg:flex">
          <MasterSidebar />
        </div>
        {sidebarOpen && (
          <div className="lg:hidden fixed inset-0 z-40 flex">
            <div
              className="absolute inset-0 bg-canvas/70 backdrop-blur-sm"
              onClick={() => setSidebarOpen(false)}
              aria-hidden
            />
            <div className="relative z-10 h-full">
              <MasterSidebar />
            </div>
          </div>
        )}
        <main className="flex-1 flex flex-col overflow-hidden min-w-0 border-x border-rule">
          {focusedId ? <FocusedSession id={focusedId} /> : <SessionGrid />}
        </main>
        <ToolCallTimeline />
      </div>
      <StatusBar />
      <PermissionAlert />
      <Toasts />
      {wsStatus === "closed" && (
        <ConnectionLost lastConnectedAt={lastConnectedAt} />
      )}
    </div>
  );
}

function ConnectionLost({
  lastConnectedAt,
}: {
  lastConnectedAt: number | null;
}): JSX.Element {
  return (
    <div className="fixed inset-0 z-[60] backdrop-blur-sm bg-canvas/80 flex items-center justify-center pointer-events-auto">
      <div className="relative flex flex-col items-center gap-4 px-10 py-8 border border-rule-bright bg-panel corners">
        <div className="font-display-tight text-[11px] uppercase tracking-ultra-wide text-accent">
          link lost
        </div>
        <div className="font-display-soft text-2xl text-fg leading-none">
          reconnecting<span className="text-fg-dim">…</span>
        </div>
        {lastConnectedAt !== null && (
          <div className="text-[10px] text-fg-dim font-mono tabular-nums">
            last contact · {new Date(lastConnectedAt).toLocaleTimeString()}
          </div>
        )}
      </div>
    </div>
  );
}
