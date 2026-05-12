// Tiny toast queue. Subscribe via `pushToast` from anywhere.

import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, X } from "lucide-react";

export type Toast = {
  id: number;
  kind: "ok" | "err";
  message: string;
};

type Listener = (t: Toast[]) => void;

let _toasts: Toast[] = [];
let _id = 1;
const listeners = new Set<Listener>();

function publish(): void {
  for (const l of listeners) l(_toasts.slice());
}

export function pushToast(kind: Toast["kind"], message: string): void {
  const t: Toast = { id: _id++, kind, message };
  _toasts = [..._toasts, t];
  publish();
  window.setTimeout(() => {
    _toasts = _toasts.filter((x) => x.id !== t.id);
    publish();
  }, 4500);
}

export function Toasts(): JSX.Element {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const l: Listener = (t) => setItems(t);
    listeners.add(l);
    setItems(_toasts.slice());
    return () => {
      listeners.delete(l);
    };
  }, []);
  return (
    <div className="fixed top-3 right-3 z-[70] flex flex-col gap-2 pointer-events-none">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto flex items-start gap-2 px-3 py-2 border text-[11px] min-w-[220px] max-w-sm animate-fade-up bg-panel ${
            t.kind === "ok"
              ? "border-ok/50 text-ok"
              : "border-err/50 text-err"
          }`}
          style={{ borderRadius: 0 }}
        >
          {t.kind === "ok" ? (
            <CheckCircle2 size={13} className="text-ok mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle size={13} className="text-err mt-0.5 shrink-0" />
          )}
          <span className="flex-1 leading-snug break-words text-fg font-mono text-[10.5px]">
            {t.message}
          </span>
          <button
            type="button"
            aria-label="dismiss"
            className="text-fg-dim hover:text-fg"
            onClick={() => {
              _toasts = _toasts.filter((x) => x.id !== t.id);
              publish();
            }}
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
