// Single global poller for "what the master sees" of the focused slaves.
//
// Maintains a `Set<sessionId>` of currently-focused ids (aggregated across
// all WS clients via `setFocusedIds`). Once per `intervalMs` (default 1000ms)
// it polls the puppet's MCP `read_screen` tool — with `view_only=true` so
// the master's dedup baseline is NOT mutated — and broadcasts a
// `master_view` ServerEvent for each id with a fresh classified payload.
//
// On MCP error containing "unknown session id" the id is silently dropped
// (the slave was closed). Other errors are logged to stderr and the tick
// continues — we do not surface poll failures to clients.

import { getMcpClient } from "./mcp-client.js";
import type { MasterViewEvent, MasterViewRow, ServerEvent } from "./types.js";

type ReadScreenResult = {
  text?: string;
  rows_classified?: Array<{ row?: number; class?: string; text?: string }>;
  render_hash?: string;
  content_hash?: string;
  unchanged?: boolean;
  error?: string;
};

const MASTER_VIEW_CLASSES = ["chat", "menu", "prompt"];

export class ScreenPoller {
  private focusedIds: Set<string> = new Set();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly broadcast: (ev: ServerEvent) => void,
    private readonly intervalMs: number = 1000,
  ) {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Don't keep the event loop alive just for polling.
    this.timer.unref?.();
  }

  setFocusedIds(ids: Set<string>): void {
    this.focusedIds = new Set(ids);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.focusedIds.clear();
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    if (this.focusedIds.size === 0) return;
    this.busy = true;
    const snapshot = [...this.focusedIds];
    try {
      // Poll sequentially. The MCP HTTP client multiplexes a single session,
      // and we'd rather be polite than hammer the daemon with parallel calls.
      for (const id of snapshot) {
        if (!this.focusedIds.has(id)) continue;
        await this.pollOne(id);
      }
    } finally {
      this.busy = false;
    }
  }

  private async pollOne(id: string): Promise<void> {
    let result: ReadScreenResult;
    try {
      result = (await getMcpClient().callTool("read_screen", {
        id,
        force_full: true,
        view_only: true,
        include_classes: MASTER_VIEW_CLASSES,
      })) as ReadScreenResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unknown session id/i.test(msg)) {
        this.focusedIds.delete(id);
        return;
      }
      // eslint-disable-next-line no-console
      console.error(`[screen-poller] ${id}: ${msg}`);
      return;
    }

    const rows: MasterViewRow[] = Array.isArray(result?.rows_classified)
      ? result.rows_classified
          .filter(
            (r): r is { class: string; text: string } =>
              typeof r?.class === "string" && typeof r?.text === "string",
          )
          .map((r) => ({ class: r.class, text: r.text }))
      : [];

    const ev: MasterViewEvent = {
      type: "master_view",
      id,
      ts: Date.now(),
      rows,
      render_hash: typeof result?.render_hash === "string" ? result.render_hash : "",
      content_hash:
        typeof result?.content_hash === "string" ? result.content_hash : "",
    };
    this.broadcast(ev);
  }
}
