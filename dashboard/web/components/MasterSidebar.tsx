// Left rail listing every master discovered. Two-column packed grid so 30+
// masters fit between the header (h-12) and the status strip (h-7) without
// vertical scroll on a typical 1080p viewport. Each cell is a single short
// row — full name, totals, and last activity surface via hover tooltip.

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";

function relTime(ms: number, now: number): string {
  if (!ms) return "—";
  const dt = Math.max(0, now - ms);
  const s = Math.floor(dt / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function MasterSidebar(): JSX.Element {
  const masters = useStore((s) => s.masters);
  const selected = useStore((s) => s.selectedMasterId);
  const select = useStore((s) => s.selectMaster);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(i);
  }, []);

  const list = useMemo(() => {
    // Sort: live first (by live count desc), then by last-activity desc.
    return [...masters.values()].sort((a, b) => {
      const lc = (b.liveCount ?? 0) - (a.liveCount ?? 0);
      if (lc !== 0) return lc;
      return (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0);
    });
  }, [masters]);
  const total = list.length;
  const totalLive = list.reduce((acc, m) => acc + (m.liveCount ?? 0), 0);

  return (
    <aside className="w-[268px] shrink-0 bg-canvas flex flex-col overflow-hidden">
      {/* Header band — h-12 to align with the main header on the right */}
      <div className="px-3 h-12 flex items-center rule-h shrink-0">
        <div className="flex flex-col leading-tight">
          <span className="text-[9px] uppercase tracking-ultra-wide text-fg-dim">
            masters
          </span>
          <span className="font-display-soft text-[14px] text-fg leading-none mt-0.5">
            <span className="tabular-nums">{total}</span>
            <span className="text-fg-dim font-ui text-[10px] ml-1.5 tabular-nums">
              · <span className="text-ok">{totalLive}</span> live
            </span>
          </span>
        </div>
      </div>

      {/* "All masters" sash — full-width, separates the all-selector from the
          packed two-column grid below. */}
      <AllMastersRow
        selected={selected === null}
        onClick={() => select(null)}
        totalLive={totalLive}
        total={total}
      />

      {/* The grid itself — 2-column packed, single-line cells, vertical scroll
          only when the master count actually exceeds the available band. */}
      {list.length === 0 ? (
        <div className="px-3 py-6 text-[10px] text-fg-dim text-center font-display-quote italic">
          no masters · yet
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto panel-scroll">
          <div className="grid grid-cols-2" style={{ gap: 0 }}>
            {list.map((m) => (
              <MasterCell
                key={m.id}
                name={m.id}
                isAnonymous={m.id === "anonymous"}
                liveCount={m.liveCount ?? 0}
                totalCount={m.totalCount ?? 0}
                lastActivityRel={relTime(m.lastActivityMs, now)}
                selected={selected === m.id}
                onClick={() => select(m.id === selected ? null : m.id)}
              />
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function AllMastersRow({
  selected,
  onClick,
  totalLive,
  total,
}: {
  selected: boolean;
  onClick: () => void;
  totalLive: number;
  total: number;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`w-full text-left px-3 py-1.5 rule-h transition-colors focus:outline-none ${
        selected ? "tape-l bg-panel" : "hover:bg-panel/50"
      }`}
    >
      <div className="flex items-center justify-between">
        <span
          className={`font-display-soft text-[12px] leading-none ${
            selected ? "text-fg" : "text-fg-mid"
          }`}
          style={{ fontVariationSettings: '"opsz" 24, "SOFT" 50, "WONK" 0' }}
        >
          all masters
        </span>
        <span className="text-[10px] font-mono tabular-nums">
          <span className="text-ok">{totalLive}</span>
          <span className="text-fg-faint">/{total}</span>
        </span>
      </div>
    </button>
  );
}

function MasterCell({
  name,
  isAnonymous,
  liveCount,
  totalCount,
  lastActivityRel,
  selected,
  onClick,
}: {
  name: string;
  isAnonymous?: boolean;
  liveCount: number;
  totalCount: number;
  lastActivityRel: string;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  const isLive = liveCount > 0;
  // Tooltip carries the full name + counts + last-activity since the cell
  // only shows a truncated name + dot + tiny live count.
  const title = `${name} · ${liveCount}/${totalCount} live · last ${lastActivityRel}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={selected}
      className={`group relative text-left h-8 px-2 flex items-center gap-1.5 transition-colors focus:outline-none ${
        selected
          ? "tape-l bg-panel"
          : "hover:bg-panel/50"
      }`}
      style={{
        borderRight: "1px solid var(--rule)",
        borderBottom: "1px solid var(--rule)",
      }}
    >
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 shrink-0 ${
          isLive ? "bg-ok" : "bg-fg-faint"
        } ${isLive && liveCount > 0 ? "animate-blip" : ""}`}
        style={{ borderRadius: 0, opacity: isLive ? 1 : 0.5 }}
      />
      <span
        className={`flex-1 min-w-0 truncate text-[11px] leading-none ${
          isAnonymous ? "text-fg-dim italic" : selected ? "text-fg" : "text-fg-mid"
        }`}
        style={{
          fontFamily: '"Fraunces", serif',
          fontVariationSettings: '"opsz" 14, "SOFT" 50, "WONK" 0',
        }}
      >
        {name}
      </span>
      <span className="text-[9px] font-mono tabular-nums shrink-0">
        <span className={isLive ? "text-ok" : "text-fg-faint"}>{liveCount}</span>
        <span className="text-fg-faint">/</span>
        <span className="text-fg-dim">{totalCount}</span>
      </span>
    </button>
  );
}
