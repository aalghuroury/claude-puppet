// Length-prefixed JSON framing between the Python MCP parent and this Node worker.
// Newline framing is unsafe — raw PTY bytes contain \n. Each frame is u32-LE length
// followed by UTF-8 JSON of that length.
//
// Mirror of server/protocol.py — keep in lockstep.

export type OpenArgs = {
  id: string;
  cmd: string;
  cmdArgs: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  transcriptDir: string;
};

export type WriteArgs = {
  id: string;
  // Each item is either a key-name like "<Enter>", "<C-c>", or a literal text fragment.
  // Node resolves names; literals pass through.
  items: string[];
  // Wrap items in bracketed-paste markers (for long text). Default false.
  bracketedPaste?: boolean;
};

export type ResizeArgs = { id: string; cols: number; rows: number };

export type SnapshotArgs = {
  id: string;
  mode: "visible" | "serialized";
  includeCursor?: boolean;
};

export type SignalArgs = {
  id: string;
  // \x03 → SIGINT via PTY input; sigint → process.kill('SIGINT'); sigterm; sigkill;
  // ladder runs the full graceful chain.
  kind: "ctrl-c" | "sigint" | "sigterm" | "sigkill" | "ladder";
  // for kill-process-group fallback
  killpg?: boolean;
};

export type CloseArgs = { id: string };

export type Op =
  | { id: number; op: "open"; args: OpenArgs }
  | { id: number; op: "write"; args: WriteArgs }
  | { id: number; op: "resize"; args: ResizeArgs }
  | { id: number; op: "snapshot"; args: SnapshotArgs }
  | { id: number; op: "signal"; args: SignalArgs }
  | { id: number; op: "close"; args: CloseArgs }
  | { id: number; op: "list_sessions"; args: {} }
  | { id: number; op: "ping"; args: {} };

export type SnapshotResult = {
  text: string;
  cursor: { row: number; col: number };
  alt: boolean;
  cols: number;
  rows: number;
  hash: string;
  idleSinceMs: number;
  lastPromptAtMs: number | null;
  serialized?: string;
};

export type Reply =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string };

export type Event =
  // Carries no bytes — bytes go to transcript. Hash + length lets parent detect activity.
  | { event: "data"; id: string; len: number; cumHash: string; ts: number }
  | { event: "prompt_visible"; id: string; ts: number }
  | { event: "exit"; id: string; code: number | null; signal: string | null; ts: number };

export type Frame = Op | Reply | Event;

export function encodeFrame(obj: Frame): Buffer {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  return Buffer.concat([len, json]);
}

// Streaming decoder for length-prefixed JSON.
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: Frame[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) break;
      const json = this.buf.subarray(4, 4 + len).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      try {
        out.push(JSON.parse(json) as Frame);
      } catch (e) {
        // Drop the malformed frame but keep going. Caller logs.
        process.stderr.write(`[pty-bridge] dropped malformed frame: ${(e as Error).message}\n`);
      }
    }
    return out;
  }
}
