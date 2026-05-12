import { useStore, selectVisibleSessions } from "../store";
import { SessionCell } from "./SessionCell";

export function SessionGrid(): JSX.Element {
  const list = useStore(selectVisibleSessions);
  const totalSessions = useStore((s) => s.sessions.size);
  const selectedMasterId = useStore((s) => s.selectedMasterId);
  const statusFilter = useStore((s) => s.statusFilter);

  if (list.length === 0) {
    if (totalSessions > 0) {
      return (
        <FilteredEmpty
          masterId={selectedMasterId}
          statusFilter={statusFilter}
        />
      );
    }
    return <EmptyState />;
  }
  return (
    <div className="p-3 grid gap-2 grid-cols-[repeat(auto-fill,minmax(304px,1fr))] auto-rows-[minmax(204px,auto)] overflow-auto panel-scroll bg-canvas">
      {list.map((s, i) => (
        <SessionCell key={s.id} session={s} index={i} />
      ))}
    </div>
  );
}

function FilteredEmpty({
  masterId,
  statusFilter,
}: {
  masterId: string | null;
  statusFilter: "alive" | "all";
}): JSX.Element {
  const masterLabel = masterId ?? "selection";
  const liveOnly = statusFilter === "alive";
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-fg-dim select-none p-8 gap-3 bg-canvas">
      <div className="text-[10px] uppercase tracking-ultra-wide text-accent">
        no matches
      </div>
      <div className="font-display-soft text-xl text-fg-mid">
        {liveOnly ? (
          <>
            no live sessions for{" "}
            <span className="text-fg italic">{masterLabel}</span>
          </>
        ) : (
          <>
            no sessions for{" "}
            <span className="text-fg italic">{masterLabel}</span>
          </>
        )}
      </div>
      {liveOnly && (
        <div className="text-[11px] text-fg-dim">
          toggle{" "}
          <code className="text-accent px-1.5 py-0.5 border border-rule-bright bg-panel font-mono">
            live only
          </code>{" "}
          off to see history
        </div>
      )}
    </div>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="flex-1 flex flex-col items-center justify-center select-none p-8 bg-canvas relative">
      {/* Editorial empty-state — large display type instead of spinning rings */}
      <div className="relative border border-rule-bright bg-panel px-12 py-10 corners">
        <div className="text-[10px] uppercase tracking-ultra-wide text-accent mb-3 flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 bg-accent animate-blip" />
          <span>awaiting slaves</span>
        </div>
        <div className="font-display-tight text-5xl text-fg leading-[0.95]">
          no <span className="font-display-quote text-fg-mid">subprocesses</span>
        </div>
        <div className="font-display-tight text-5xl text-fg leading-[0.95]">
          on this <span className="text-accent">desk</span>.
        </div>
        <div className="mt-6 pt-4 border-t border-rule text-[11px] text-fg-dim leading-relaxed max-w-md">
          a master Claude can spawn one with{" "}
          <code className="text-fg-mid font-mono">open_session()</code> via the{" "}
          <span className="text-fg-mid">claude-puppet</span> MCP. once it lives,
          its screen will appear here.
        </div>
        <div className="mt-3 flex items-center gap-2 text-[10px] text-fg-dim font-mono">
          <span className="inline-block h-1 w-1 bg-fg-dim animate-blip" />
          <span>watching ~/.cache/claude-puppet/sessions</span>
        </div>
      </div>
    </div>
  );
}
