// Mounts the WS client at app root.

import { useEffect } from "react";
import { startWs } from "../ws";

export function useWS(): void {
  useEffect(() => {
    const stop = startWs();
    return () => {
      stop();
    };
  }, []);
}
