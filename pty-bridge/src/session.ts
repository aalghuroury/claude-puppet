import * as nodePty from "node-pty";
import xtermHeadless from "@xterm/headless";
import type xtermHeadlessNs from "@xterm/headless";
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";

const { Terminal } = xtermHeadless;
type TerminalT = xtermHeadlessNs.Terminal;
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  attachPromptMarkers,
  attachSerialize,
  type PromptMarkerState,
  snapshot,
} from "./snapshot.js";
import type { SnapshotResult, SignalArgs } from "./protocol.js";

type Pty = nodePty.IPty;

export type SessionEventSink = {
  data: (id: string, len: number, cumHash: string) => void;
  promptVisible: (id: string) => void;
  exit: (id: string, code: number | null, signal: string | null) => void;
};

export class Session {
  readonly id: string;
  readonly pty: Pty;
  readonly term: TerminalT;
  private readonly serialize: ReturnType<typeof attachSerialize>;
  private readonly promptState: PromptMarkerState;
  private readonly transcriptBin: WriteStream;
  private readonly transcriptJsonl: WriteStream;
  private cumHash = createHash("sha1");
  private cumBytes = 0;
  private exited = false;

  // Pending data buffer + drain signal — guarantees snapshot ordering.
  // Whenever pty.onData fires we synchronously feed the Terminal; this property
  // tracks "data has arrived since last snapshot" for telemetry.

  constructor(args: {
    id: string;
    cmd: string;
    cmdArgs: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
    transcriptDir: string;
    sink: SessionEventSink;
  }) {
    this.id = args.id;
    mkdirSync(args.transcriptDir, { recursive: true });
    this.transcriptBin = createWriteStream(join(args.transcriptDir, "transcript.bin"));
    this.transcriptJsonl = createWriteStream(join(args.transcriptDir, "transcript.jsonl"));

    this.term = new Terminal({
      cols: args.cols,
      rows: args.rows,
      allowProposedApi: true,
      scrollback: 5000,
    });
    this.serialize = attachSerialize(this.term);
    this.promptState = attachPromptMarkers(this.term);

    this.pty = nodePty.spawn(args.cmd, args.cmdArgs, {
      name: "xterm-256color",
      cols: args.cols,
      rows: args.rows,
      cwd: args.cwd,
      env: args.env,
    });

    this.pty.onData((data) => {
      // Synchronous write to Terminal — guarantees snapshot consistency.
      this.term.write(data);
      this.promptState.lastDataMs = Date.now();
      const buf = Buffer.from(data, "utf8");
      this.transcriptBin.write(buf);
      this.cumHash.update(buf);
      this.cumBytes += buf.length;
      this.transcriptJsonl.write(
        JSON.stringify({ ts: Date.now(), dir: "out", len: buf.length, text: data }) + "\n",
      );
      args.sink.data(this.id, buf.length, this.cumHash.copy().digest("hex"));
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = true;
      args.sink.exit(this.id, exitCode ?? null, signal != null ? String(signal) : null);
      this.transcriptBin.end();
      this.transcriptJsonl.end();
    });
  }

  write(bytes: string): void {
    if (this.exited) return;
    this.pty.write(bytes);
    this.transcriptJsonl.write(
      JSON.stringify({ ts: Date.now(), dir: "in", len: Buffer.byteLength(bytes, "utf8"), text: bytes }) + "\n",
    );
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.pty.resize(cols, rows);
    this.term.resize(cols, rows);
  }

  snapshot(mode: "visible" | "serialized"): SnapshotResult {
    return snapshot(this.term, this.serialize, this.promptState, { mode });
  }

  /**
   * SIGINT ladder: \x03 → SIGINT (500ms) → SIGTERM (2s) → SIGKILL (5s).
   * Resolves after the process exits or the ladder finishes.
   */
  async signalLadder(): Promise<void> {
    if (this.exited) return;
    this.write("\x03");
    if (await this.waitExit(500)) return;
    try { this.pty.kill("SIGINT"); } catch { /* ignore */ }
    if (await this.waitExit(2000)) return;
    try { this.pty.kill("SIGTERM"); } catch { /* ignore */ }
    if (await this.waitExit(5000)) return;
    try { this.pty.kill("SIGKILL"); } catch { /* ignore */ }
  }

  signal(args: SignalArgs): void {
    if (this.exited) return;
    switch (args.kind) {
      case "ctrl-c":
        this.write("\x03");
        break;
      case "sigint":
        try { this.pty.kill("SIGINT"); } catch { /* ignore */ }
        break;
      case "sigterm":
        try { this.pty.kill("SIGTERM"); } catch { /* ignore */ }
        break;
      case "sigkill":
        try { this.pty.kill("SIGKILL"); } catch { /* ignore */ }
        break;
      case "ladder":
        // fire-and-forget; caller can poll via list_sessions / exit event
        void this.signalLadder();
        break;
    }
  }

  isExited(): boolean {
    return this.exited;
  }

  private waitExit(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(this.exited), ms);
      // No cleaner hook than polling; cheap.
      const i = setInterval(() => {
        if (this.exited) {
          clearTimeout(t);
          clearInterval(i);
          resolve(true);
        }
      }, 50);
    });
  }
}
