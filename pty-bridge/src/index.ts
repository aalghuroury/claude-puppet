// Main loop for the pty-bridge worker. Reads length-prefixed JSON frames from stdin,
// dispatches ops to per-session handlers, writes replies and async events to stdout.
//
// Stderr is the diagnostic channel — never write protocol bytes there.

import { stdin, stdout, stderr } from "node:process";
import {
  encodeFrame,
  FrameDecoder,
  type Frame,
  type Op,
  type Reply,
  type Event,
} from "./protocol.js";
import { Session, type SessionEventSink } from "./session.js";
import { bracketed, resolveTokens } from "./keys.js";

// CLI smoke check: `node dist/index.js --smoke` prints OK and exits.
// Lets the Python side validate the worker binary without entering the protocol.
if (process.argv.includes("--smoke")) {
  process.stdout.write("pty-bridge: smoke ok\n");
  process.exit(0);
}

const sessions = new Map<string, Session>();

function send(frame: Frame): void {
  stdout.write(encodeFrame(frame));
}

const sink: SessionEventSink = {
  data: (id, len, cumHash) => send({ event: "data", id, len, cumHash, ts: Date.now() } as Event),
  promptVisible: (id) => send({ event: "prompt_visible", id, ts: Date.now() } as Event),
  exit: (id, code, signal) => send({ event: "exit", id, code, signal, ts: Date.now() } as Event),
};

function ok(id: number, result?: unknown): Reply {
  return { id, ok: true, result };
}
function err(id: number, message: string): Reply {
  return { id, ok: false, error: message };
}

async function dispatch(op: Op): Promise<Reply> {
  try {
    switch (op.op) {
      case "open": {
        const a = op.args;
        if (sessions.has(a.id)) return err(op.id, `session ${a.id} already open`);
        const s = new Session({
          id: a.id,
          cmd: a.cmd,
          cmdArgs: a.cmdArgs,
          cwd: a.cwd,
          env: a.env,
          cols: a.cols,
          rows: a.rows,
          transcriptDir: a.transcriptDir,
          sink,
        });
        sessions.set(a.id, s);
        return ok(op.id, { id: a.id, pid: s.pty.pid });
      }
      case "write": {
        const a = op.args;
        const s = sessions.get(a.id);
        if (!s) return err(op.id, `no session ${a.id}`);
        const { bytes, unresolved } = resolveTokens(a.items);
        if (unresolved.length > 0) {
          return err(op.id, `unresolved key names: ${unresolved.join(", ")}`);
        }
        s.write(a.bracketedPaste ? bracketed(bytes) : bytes);
        return ok(op.id, { wrote: Buffer.byteLength(bytes, "utf8") });
      }
      case "resize": {
        const a = op.args;
        const s = sessions.get(a.id);
        if (!s) return err(op.id, `no session ${a.id}`);
        s.resize(a.cols, a.rows);
        return ok(op.id);
      }
      case "snapshot": {
        const a = op.args;
        const s = sessions.get(a.id);
        if (!s) return err(op.id, `no session ${a.id}`);
        return ok(op.id, s.snapshot(a.mode));
      }
      case "signal": {
        const a = op.args;
        const s = sessions.get(a.id);
        if (!s) return err(op.id, `no session ${a.id}`);
        s.signal(a);
        return ok(op.id);
      }
      case "close": {
        const a = op.args;
        const s = sessions.get(a.id);
        if (!s) return err(op.id, `no session ${a.id}`);
        await s.signalLadder();
        sessions.delete(a.id);
        return ok(op.id);
      }
      case "list_sessions": {
        const list = Array.from(sessions.entries()).map(([id, s]) => ({
          id,
          pid: s.pty.pid,
          exited: s.isExited(),
        }));
        return ok(op.id, { sessions: list });
      }
      case "ping":
        return ok(op.id, { ts: Date.now() });
    }
  } catch (e) {
    return err(op.id, (e as Error).stack ?? String(e));
  }
}

const dec = new FrameDecoder();

stdin.on("data", (chunk: Buffer) => {
  const frames = dec.push(chunk);
  for (const frame of frames) {
    if ("op" in frame && typeof frame.id === "number") {
      void dispatch(frame as Op).then((reply) => send(reply));
    } else {
      stderr.write(`[pty-bridge] dropping unexpected frame: ${JSON.stringify(frame)}\n`);
    }
  }
});

stdin.on("end", () => {
  // Parent closed our stdin → graceful shutdown of all sessions.
  void shutdownAll().then(() => process.exit(0));
});

async function shutdownAll(): Promise<void> {
  const entries = Array.from(sessions.values());
  await Promise.all(entries.map((s) => s.signalLadder()));
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    void shutdownAll().then(() => process.exit(0));
  });
}

stderr.write(`[pty-bridge] ready pid=${process.pid}\n`);
