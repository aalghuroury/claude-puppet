// WebSocket client with exponential-backoff reconnect.

import { useStore } from "./store";
import type { ClientMessage, ServerEvent } from "./types";

const MIN_BACKOFF = 500;
const MAX_BACKOFF = 10_000;

let activeWs: WebSocket | null = null;

export function startWs(): () => void {
  let ws: WebSocket | null = null;
  let backoff = MIN_BACKOFF;
  let timer: number | null = null;
  let stopped = false;

  function url(): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    // Dev: Vite (:5055) proxies /ws to backend (:7780). Prod: single Express server on :5055 serves both.
    return `${proto}//${window.location.host}/ws`;
  }

  function connect(): void {
    if (stopped) return;
    useStore.getState().setWsStatus("connecting");
    try {
      ws = new WebSocket(url());
    } catch {
      schedule();
      return;
    }
    activeWs = ws;
    ws.onopen = () => {
      backoff = MIN_BACKOFF;
      useStore.getState().setWsStatus("open");
      // Trigger an immediate visible_set flush so the backend learns what
      // the user is currently looking at.
      const flush = useStore.getState().flushVisibleSetNow;
      if (typeof flush === "function") flush();
    };
    ws.onmessage = (msg) => {
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(msg.data) as ServerEvent;
      } catch {
        return;
      }
      useStore.getState().applyEvent(parsed);
    };
    ws.onclose = () => {
      if (activeWs === ws) activeWs = null;
      useStore.getState().setWsStatus("closed");
      schedule();
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }

  function schedule(): void {
    if (stopped) return;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      backoff = Math.min(MAX_BACKOFF, backoff * 2);
      connect();
    }, backoff);
  }

  connect();

  return () => {
    stopped = true;
    if (timer) window.clearTimeout(timer);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}

/** Send a typed client message over the active WS, if open. Drops silently otherwise. */
export function sendClientMessage(msg: ClientMessage): void {
  const w = activeWs;
  if (!w || w.readyState !== WebSocket.OPEN) return;
  try {
    w.send(JSON.stringify(msg));
  } catch {
    /* ignore */
  }
}
