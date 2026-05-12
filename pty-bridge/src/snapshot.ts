import type xtermHeadlessNs from "@xterm/headless";
import addonSerializePkg from "@xterm/addon-serialize";
import { createHash } from "node:crypto";
import type { SnapshotResult } from "./protocol.js";

type Terminal = xtermHeadlessNs.Terminal;
const { SerializeAddon } = addonSerializePkg;
type SerializeAddon = InstanceType<typeof SerializeAddon>;

// xterm-headless owns the screen state; this module converts it to a SnapshotResult
// (text + cursor + serialized full-state + content hash).

export type PromptMarkerState = {
  lastPromptAtMs: number | null;
  lastDataMs: number;
};

export function attachSerialize(term: Terminal): SerializeAddon {
  const addon = new SerializeAddon();
  // SerializeAddon's published types target @xterm/xterm (the DOM build) but the
  // runtime API it touches exists on @xterm/headless. Cast through unknown to
  // bypass the structural mismatch.
  term.loadAddon(addon as unknown as Parameters<Terminal["loadAddon"]>[0]);
  return addon;
}

/**
 * OSC 133 "shell integration" markers — most modern shells/Ink TUIs emit these to mark
 * prompt-start/prompt-end. xterm.js parses them as marker events. We listen via the
 * raw data parser hook on `term.parser.registerOscHandler(133, ...)`.
 *
 * Returns a state object whose `lastPromptAtMs` updates whenever a prompt-end (133;B) is seen.
 *
 * If Claude Code doesn't emit OSC 133 we still get a valid `lastDataMs`; the parent's
 * idle heuristic falls back to snapshot-hash + cursor-position (see screen.py).
 */
export function attachPromptMarkers(term: Terminal): PromptMarkerState {
  const state: PromptMarkerState = { lastPromptAtMs: null, lastDataMs: Date.now() };
  // OSC 133 sub-types: A (prompt-start), B (prompt-end / command-start),
  //                   C (command-output-start), D (command-end with status).
  // We treat A and B as "input prompt visible".
  // xterm types declare parser as optional; cast through unknown.
  const parser = (term as unknown as { parser?: { registerOscHandler: (id: number, cb: (data: string) => boolean) => void } }).parser;
  if (parser && typeof parser.registerOscHandler === "function") {
    parser.registerOscHandler(133, (data: string) => {
      // data is the OSC payload after "133;"; e.g. "A" or "B" or "C;..."
      const sub = data.charAt(0);
      if (sub === "A" || sub === "B") {
        state.lastPromptAtMs = Date.now();
      }
      // Return false so xterm.js keeps default handling.
      return false;
    });
  }
  return state;
}

export function snapshot(
  term: Terminal,
  serialize: SerializeAddon,
  state: PromptMarkerState,
  opts: { mode: "visible" | "serialized"; includeCursor?: boolean }
): SnapshotResult {
  const buf = term.buffer.active;
  const rows = term.rows;
  const cols = term.cols;
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    lines.push(line ? line.translateToString(true) : "");
  }
  const text = lines.join("\n");
  const hash = createHash("sha1").update(text).digest("hex");
  const result: SnapshotResult = {
    text,
    cursor: { row: buf.cursorY, col: buf.cursorX },
    alt: buf.type === "alternate",
    cols,
    rows,
    hash,
    idleSinceMs: Math.max(0, Date.now() - state.lastDataMs),
    lastPromptAtMs: state.lastPromptAtMs,
  };
  if (opts.mode === "serialized") {
    result.serialized = serialize.serialize();
  }
  return result;
}
