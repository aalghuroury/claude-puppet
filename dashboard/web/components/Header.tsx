import { useEffect, useRef, useState } from "react";
import { Settings, Menu } from "lucide-react";
import { useStore } from "../store";
import { useSettings } from "../settings";

function pingClass(ms: number | null): string {
  if (ms === null) return "text-fg-faint";
  if (ms < 100) return "text-ok";
  if (ms < 500) return "text-warn";
  return "text-err";
}

type HeaderProps = {
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
};

export function Header({ onToggleSidebar, sidebarOpen }: HeaderProps = {}): JSX.Element {
  const wsStatus = useStore((s) => s.wsStatus);
  const statusFilter = useStore((s) => s.statusFilter);
  const toggleStatusFilter = useStore((s) => s.toggleStatusFilter);
  const emptyFilter = useStore((s) => s.emptyFilter);
  const toggleEmptyFilter = useStore((s) => s.toggleEmptyFilter);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const t0 = performance.now();
      try {
        const res = await fetch("/healthz", { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) setPingMs(Math.round(performance.now() - t0));
        else setPingMs(null);
      } catch {
        if (!cancelled) setPingMs(null);
      }
    };
    void tick();
    const i = setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      clearInterval(i);
    };
  }, []);

  const dotColor =
    wsStatus === "open"
      ? "bg-ok"
      : wsStatus === "connecting"
        ? "bg-warn animate-blip"
        : "bg-err";

  return (
    <header className="h-12 flex items-stretch rule-h bg-canvas">
      <div className="flex items-center gap-3 pl-4 pr-5 rule-v">
        {onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label={sidebarOpen ? "Close masters sidebar" : "Open masters sidebar"}
            aria-pressed={!!sidebarOpen}
            className="lg:hidden p-1 text-fg-mid hover:text-accent focus:outline-none"
          >
            <Menu size={15} />
          </button>
        )}
        {/* Brand mark — solid square + bracketed sodium tape */}
        <div className="flex items-center gap-2">
          <div className="relative h-5 w-5">
            <div className="absolute inset-0 border border-accent" />
            <div className="absolute inset-[3px] bg-accent" />
          </div>
          <h1 className="font-display-soft text-[18px] leading-none text-fg select-none">
            claude<span className="text-accent">·</span>puppet
          </h1>
        </div>
        <div className="ml-1 flex flex-col text-[9px] leading-tight uppercase tracking-ultra-wide text-fg-dim">
          <span>telemetry</span>
          <span>desk · v0.3</span>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-end gap-1 px-3">
        <FilterPill
          on={statusFilter === "alive"}
          label={statusFilter === "alive" ? "live only" : "all sessions"}
          onClick={toggleStatusFilter}
          title={
            statusFilter === "alive"
              ? "showing live only — click to show all"
              : "showing all — click to show live only"
          }
        />
        <FilterPill
          on={emptyFilter === "hide"}
          label={emptyFilter === "hide" ? "non-empty" : "include empty"}
          onClick={toggleEmptyFilter}
          title={
            emptyFilter === "hide"
              ? "hiding sessions with 0 bytes — click to show them"
              : "showing all sessions — click to hide empty"
          }
        />

        <div className="mx-3 h-5 w-px bg-rule" />

        <div
          className="flex items-center gap-1.5 px-2 text-[10px] font-mono tabular-nums"
          title={pingMs === null ? "no response from /healthz" : `${pingMs}ms ping`}
        >
          <span className="text-fg-dim uppercase tracking-ultra-wide text-[9px]">link</span>
          <span className={pingClass(pingMs)}>
            {pingMs === null ? "—" : `${pingMs}ms`}
          </span>
        </div>

        <div className="flex items-center gap-2 px-2">
          <span
            className={`inline-block h-2 w-2 ${dotColor}`}
            style={{ borderRadius: 0 }}
            aria-label={wsStatus}
          />
          <span className="text-fg-dim uppercase tracking-ultra-wide text-[9px]">
            {wsStatus}
          </span>
        </div>

        <div className="relative ml-1">
          <button
            ref={settingsBtnRef}
            type="button"
            aria-label="Open settings"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((x) => !x)}
            className={`p-1.5 hover:text-accent focus:outline-none ${
              settingsOpen ? "text-accent" : "text-fg-mid"
            }`}
          >
            <Settings size={14} />
          </button>
          {settingsOpen && (
            <SettingsDropdown onClose={() => setSettingsOpen(false)} />
          )}
        </div>
      </div>
    </header>
  );
}

function FilterPill({
  on,
  label,
  onClick,
  title,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
  title: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className={`h-6 px-2 text-[10px] uppercase tracking-ultra-wide border focus:outline-none transition-colors ${
        on
          ? "border-accent text-accent bg-accent/10"
          : "border-rule text-fg-dim hover:border-accent-quiet hover:text-fg-mid"
      }`}
      style={{ borderRadius: 0 }}
    >
      {label}
    </button>
  );
}

function SettingsDropdown({
  onClose,
}: {
  onClose: () => void;
}): JSX.Element {
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const showToolArgsInline = useSettings((s) => s.showToolArgsInline);
  const autoReplayNewSessions = useSettings((s) => s.autoReplayNewSessions);
  const setS = useSettings((s) => s.set);

  useEffect(() => {
    const close = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-settings-dropdown]")) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      data-settings-dropdown
      className="absolute right-0 top-9 z-50 min-w-[280px] border border-rule-bright bg-panel text-[11px] animate-slide-in-top"
    >
      <div className="px-3 py-2 rule-h text-[9px] uppercase tracking-ultra-wide text-fg-dim flex items-center justify-between">
        <span>settings</span>
        <span className="font-mono text-fg-faint">esc</span>
      </div>
      <Toggle
        label="Reduce motion"
        hint="Disable pulsing and animated effects"
        checked={reduceMotion}
        onChange={(v) => setS("reduceMotion", v)}
      />
      <Toggle
        label="Tool args inline"
        hint="Auto-expand tool-call rows in the timeline"
        checked={showToolArgsInline}
        onChange={(v) => setS("showToolArgsInline", v)}
      />
      <Toggle
        label="Auto-replay new sessions"
        hint="On new slave, write buffered events into the cell"
        checked={autoReplayNewSessions}
        onChange={(v) => setS("autoReplayNewSessions", v)}
      />
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-rule/30 transition-colors">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div className="flex-1 leading-tight">
        <div className="text-fg">{label}</div>
        <div className="text-[10px] text-fg-dim mt-0.5">{hint}</div>
      </div>
    </label>
  );
}
