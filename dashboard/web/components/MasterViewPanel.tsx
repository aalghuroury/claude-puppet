// "What the master sees" panel — paired beside the raw PTY in FocusedSession.

import { useStore } from "../store";

const CLASS_COLORS: Record<string, string> = {
  chat: "text-fg",
  menu: "text-accent",
  prompt: "text-warn",
};

type Props = { id: string };

export function MasterViewPanel({ id }: Props): JSX.Element {
  const view = useStore((s) => s.masterViews.get(id));

  if (!view) {
    return (
      <div className="flex flex-col h-full bg-canvas border-l border-rule overflow-hidden">
        <Header diverged={false} />
        <div className="flex-1 flex flex-col items-center justify-center text-fg-dim gap-3 font-display-quote">
          <span className="inline-block h-1 w-1 bg-accent animate-blip" />
          <div className="text-[11px]">awaiting first poll</div>
        </div>
      </div>
    );
  }

  const diverged =
    view.render_hash.length > 0 &&
    view.content_hash.length > 0 &&
    view.render_hash !== view.content_hash;

  return (
    <div className="flex flex-col h-full bg-canvas border-l border-rule overflow-hidden">
      <Header diverged={diverged} />
      <pre className="flex-1 overflow-auto m-0 px-3 py-2 text-[11px] leading-snug font-mono whitespace-pre panel-scroll">
        {view.rows.length === 0 ? (
          <span className="text-fg-dim italic">empty · filter consumed all rows</span>
        ) : (
          view.rows.map((r, i) => {
            const color = CLASS_COLORS[r.class] ?? "text-fg-dim";
            return (
              <div key={i} className={color}>
                {r.text || " "}
              </div>
            );
          })
        )}
      </pre>
    </div>
  );
}

function Header({ diverged }: { diverged: boolean }): JSX.Element {
  return (
    <div className="px-3 py-2 rule-h flex items-center gap-2">
      <span className="text-[9px] uppercase tracking-ultra-wide text-fg-dim">
        master view
      </span>
      <span className="text-[9px] text-fg-faint tracking-ultra-wide uppercase">· filtered · 1Hz</span>
      {diverged && (
        <span
          title="render_hash ≠ content_hash — dedup is doing work"
          className="ml-auto text-[10px] text-accent tabular-nums font-mono"
        >
          render ↛ content
        </span>
      )}
    </div>
  );
}
