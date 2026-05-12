// Incremental jsonl tailer.
//
// Tracks a byte offset per file. On each "tick" we read the new bytes since
// the last offset, split on \n, and parse each complete line. The trailing
// partial line (if any) is left in the file; we'll pick it up on the next
// tick once the writer adds \n.

import { promises as fs } from "node:fs";
import chokidar from "chokidar";

export type LineHandler = (line: string) => void;

export class JsonlTail {
  private offset = 0;
  private partial = "";
  private watcher: chokidar.FSWatcher | null = null;
  private pending = false;
  private busy = false;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly onLine: LineHandler,
  ) {}

  async start(): Promise<void> {
    // If file already exists, start at end (don't dump entire history at boot;
    // tail() already gives recent context via in-memory ring buffers).
    try {
      const s = await fs.stat(this.path);
      this.offset = s.size;
    } catch {
      this.offset = 0;
    }
    this.watcher = chokidar.watch(this.path, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: false,
      atomic: false,
    });
    const trigger = () => {
      this.scheduleRead();
    };
    this.watcher.on("add", trigger);
    this.watcher.on("change", trigger);
  }

  /** Read entire file from offset 0 (used for catch-up on connect). */
  async readAll(): Promise<string[]> {
    const lines: string[] = [];
    try {
      const data = await fs.readFile(this.path, "utf8");
      const parts = data.split("\n");
      for (const p of parts) {
        if (p) lines.push(p);
      }
    } catch {
      // file may not exist yet
    }
    return lines;
  }

  private scheduleRead(): void {
    if (this.closed) return;
    this.pending = true;
    if (this.busy) return;
    void this.drain();
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (this.pending && !this.closed) {
        this.pending = false;
        await this.readDelta();
      }
    } finally {
      this.busy = false;
    }
  }

  private async readDelta(): Promise<void> {
    let size: number;
    try {
      const s = await fs.stat(this.path);
      size = s.size;
    } catch {
      return;
    }
    if (size < this.offset) {
      // truncation / replacement — restart
      this.offset = 0;
      this.partial = "";
    }
    if (size === this.offset) return;

    const fh = await fs.open(this.path, "r");
    try {
      const length = size - this.offset;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, this.offset);
      this.offset = size;
      const text = this.partial + buf.toString("utf8");
      const parts = text.split("\n");
      this.partial = parts.pop() ?? "";
      for (const line of parts) {
        if (line) this.onLine(line);
      }
    } finally {
      await fh.close();
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
