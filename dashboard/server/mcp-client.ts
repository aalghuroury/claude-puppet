// Minimal MCP streamable-HTTP client for the dashboard backend.
//
// The puppet's MCP daemon runs at http://localhost:5056/mcp and speaks the
// "Streamable HTTP" transport: every POST may either return JSON or open an
// SSE stream. We need to:
//
//   1. POST initialize → server returns 200 + `mcp-session-id` header. The
//      response body is an SSE stream containing exactly one
//      `event: message` frame with the JSON-RPC reply.
//   2. POST notifications/initialized (no id) → server replies 202 Accepted.
//   3. For each tools/call: POST with the session-id header and `id`. Server
//      again replies SSE; we read until we see the matching `id` frame.
//
// We do not need long-lived bidirectional streams here — every dashboard
// HTTP route maps to exactly one tool call and we throw away the connection
// after the response arrives.

const DEFAULT_MCP_URL = process.env.CLAUDE_PUPPET_MCP_URL ?? "http://localhost:5056/mcp";

type JsonRpcReply<T = unknown> = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

type ToolCallResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

export class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly url: string = DEFAULT_MCP_URL) {}

  /** Lazily initialize the MCP session. Idempotent. */
  private async ensureInitialized(): Promise<void> {
    if (this.sessionId) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.doInitialize().finally(() => {
      this.initPromise = null;
    });
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const id = this.nextId++;
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "claude-puppet-dashboard", version: "0.1" },
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`MCP initialize failed: HTTP ${res.status}`);
    }
    const sid = res.headers.get("mcp-session-id");
    if (!sid) {
      throw new Error("MCP initialize: missing mcp-session-id header");
    }
    this.sessionId = sid;

    // Drain the SSE response (we don't strictly need the result, but read so
    // the connection closes cleanly).
    await readSseToReply(res, id).catch(() => {
      /* ignore — initialize body is best-effort */
    });

    // Notify initialized so the daemon will accept tool calls.
    await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    });
  }

  /** Reset session state — call this if a request fails with "Missing session ID". */
  resetSession(): void {
    this.sessionId = null;
  }

  /** Call a single MCP tool by name and return the structured result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    return await this.callToolOnce(name, args).catch(async (err) => {
      // If session was lost on the daemon side, try once more with a fresh one.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Missing session ID") || msg.includes("404")) {
        this.resetSession();
        await this.ensureInitialized();
        return this.callToolOnce(name, args);
      }
      throw err;
    });
  }

  private async callToolOnce(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.sessionId) throw new Error("MCP session not initialized");
    const id = this.nextId++;
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": this.sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`MCP tools/call HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const reply = await readSseToReply<ToolCallResult>(res, id);
    if (reply.error) {
      throw new Error(`MCP error ${reply.error.code}: ${reply.error.message}`);
    }
    // Prefer structuredContent (already JSON), fall back to first text block.
    if (reply.result?.structuredContent !== undefined) {
      return reply.result.structuredContent;
    }
    const firstText = reply.result?.content?.find((c) => c.type === "text")?.text;
    if (firstText) {
      try {
        return JSON.parse(firstText);
      } catch {
        return firstText;
      }
    }
    return reply.result ?? null;
  }
}

/** Read an SSE stream until we get a JSON-RPC reply with the matching id. */
async function readSseToReply<T>(
  res: Response,
  expectedId: number | string,
): Promise<JsonRpcReply<T>> {
  const ct = res.headers.get("content-type") ?? "";
  // Some replies (notifications) are just JSON.
  if (ct.includes("application/json")) {
    const j = (await res.json()) as JsonRpcReply<T>;
    return j;
  }
  if (!res.body) {
    throw new Error("MCP: no response body");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const tryParseFrame = (frame: string): JsonRpcReply<T> | null => {
    if (!frame.trim()) return null;
    const dataLines: string[] = [];
    // Normalize CRLF and split.
    for (const rawLine of frame.replace(/\r/g, "").split("\n")) {
      if (rawLine.startsWith("data:")) {
        dataLines.push(rawLine.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return null;
    try {
      return JSON.parse(dataLines.join("\n")) as JsonRpcReply<T>;
    } catch {
      return null;
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // Flush whatever's left in the buffer as a final frame.
        const parsed = tryParseFrame(buffer);
        buffer = "";
        if (parsed && parsed.id === expectedId) {
          return parsed;
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank lines (\n\n or \r\n\r\n).
      while (true) {
        const m = buffer.match(/\r?\n\r?\n/);
        if (!m || m.index === undefined) break;
        const sepIdx = m.index;
        const sepLen = m[0].length;
        const frame = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + sepLen);
        const parsed = tryParseFrame(frame);
        if (parsed && parsed.id === expectedId) {
          return parsed;
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  throw new Error("MCP: stream ended without matching reply");
}

// Singleton — one client per dashboard process.
let _client: McpClient | null = null;
export function getMcpClient(): McpClient {
  if (!_client) _client = new McpClient();
  return _client;
}
