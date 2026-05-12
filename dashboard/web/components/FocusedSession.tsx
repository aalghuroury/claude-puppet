// Lazy wrapper for the heavy focused-session implementation. Splitting this
// into its own chunk keeps the initial bundle slim — the Impl module only
// loads once a slave is actually focused.

import { Suspense, lazy } from "react";

const FocusedSessionImpl = lazy(() =>
  import("./FocusedSessionImpl").then((m) => ({ default: m.FocusedSessionImpl })),
);

type Props = { id: string };

export function FocusedSession(props: Props): JSX.Element {
  return (
    <Suspense fallback={<FocusedFallback />}>
      <FocusedSessionImpl {...props} />
    </Suspense>
  );
}

function FocusedFallback(): JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center bg-canvas">
      <div className="flex items-center gap-3 text-fg-dim">
        <span className="inline-block h-1.5 w-1.5 bg-accent animate-blip" />
        <span className="text-[10px] uppercase tracking-ultra-wide">loading focus pane</span>
      </div>
    </div>
  );
}
