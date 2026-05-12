// Tails one session's transcript.jsonl, parses each line as a TranscriptLine,
// and forwards pty_data events through a callback.

import { JsonlTail } from "./tail.js";
import type { PtyDataEvent, TranscriptLine } from "./types.js";

export type PtyDataHandler = (ev: PtyDataEvent) => void;

export class TranscriptStream {
  private readonly tail: JsonlTail;

  constructor(
    private readonly sessionId: string,
    transcriptPath: string,
    private readonly handler: PtyDataHandler,
  ) {
    this.tail = new JsonlTail(transcriptPath, (line) => this.onLine(line));
  }

  async start(): Promise<void> {
    await this.tail.start();
  }

  async stop(): Promise<void> {
    await this.tail.stop();
  }

  private onLine(line: string): void {
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      return;
    }
    if (
      typeof parsed?.ts !== "number" ||
      (parsed.dir !== "out" && parsed.dir !== "in") ||
      typeof parsed.text !== "string"
    ) {
      return;
    }
    this.handler({
      type: "pty_data",
      id: this.sessionId,
      ts: parsed.ts,
      dir: parsed.dir,
      text: parsed.text,
    });
  }
}
