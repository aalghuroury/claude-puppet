// xterm.js Terminal lifecycle hook — read-only display.
//
// Two sizing strategies:
//
//   1. fitMode: "fit"    — let FitAddon size the terminal to the container.
//                          Works well when the slave's PTY size is unknown
//                          OR when we're willing to re-render at the
//                          container's natural cell-grid.
//   2. fitMode: "scale"  — keep the terminal at a fixed cols/rows (matching
//                          the slave's PTY) and visually scale the wrapper
//                          via CSS `transform: scale(...)`. This guarantees
//                          line-wrap fidelity — what the slave sees == what
//                          we show, just zoomed.
//
// Most cells should use "scale" so a 200×50 slave looks identical in a 360px
// thumbnail and a full-screen focused view.

import { useEffect, useRef } from "react";
import { Terminal, type ITerminalOptions } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

type TerminalTheme = NonNullable<ITerminalOptions["theme"]>;

const THEME: TerminalTheme = {
  background: "#09090b", // zinc-950
  foreground: "#f4f4f5",
  cursor: "#22d3ee", // cyan-400
  cursorAccent: "#09090b",
  selectionBackground: "rgba(34, 211, 238, 0.3)",
  black: "#18181b",
  red: "#f43f5e",
  green: "#10b981",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#a78bfa",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#3f3f46",
  brightRed: "#fb7185",
  brightGreen: "#34d399",
  brightYellow: "#fcd34d",
  brightBlue: "#93c5fd",
  brightMagenta: "#c4b5fd",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};

export type FitMode = "fit" | "scale" | "none";

export type UseTerminalOpts = {
  cols?: number;
  rows?: number;
  fontSize?: number;
  /** "fit" = FitAddon, "scale" = fixed cols/rows + CSS scale, "none" = static. */
  fitMode?: FitMode;
  webgl?: boolean;
  cursorBlink?: boolean;
  scrollback?: number;
};

export type TerminalHandle = {
  write: (data: string) => void;
  clear: () => void;
  fit: () => void;
  /** Current cols/rows of the underlying Terminal (post-fit). */
  dims: () => { cols: number; rows: number };
};

export function useTerminal(opts: UseTerminalOpts = {}): {
  /** Outer wrapper element — measures the available space. */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Inner element that hosts xterm. In "scale" mode this gets transform:scale(). */
  innerRef: React.RefObject<HTMLDivElement>;
  handleRef: React.MutableRefObject<TerminalHandle | null>;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<TerminalHandle | null>(null);

  const fitMode: FitMode = opts.fitMode ?? "fit";
  const cols = opts.cols ?? 200;
  const rows = opts.rows ?? 50;
  const fontSize = opts.fontSize ?? 11;

  useEffect(() => {
    const outer = containerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const term = new Terminal({
      cols,
      rows,
      fontSize,
      cursorBlink: opts.cursorBlink ?? false,
      disableStdin: true,
      convertEol: false,
      scrollback: opts.scrollback ?? 5000,
      allowProposedApi: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      theme: THEME,
    });

    const fitAddon = fitMode === "fit" ? new FitAddon() : null;
    if (fitAddon) term.loadAddon(fitAddon);

    term.open(inner);

    let webgl: WebglAddon | null = null;
    if (opts.webgl) {
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          try {
            webgl?.dispose();
          } catch {
            /* ignore */
          }
        });
        term.loadAddon(webgl);
      } catch {
        // graceful fallback to canvas/dom renderer
        webgl = null;
      }
    }

    const safeFit = (): void => {
      if (fitMode === "fit" && fitAddon) {
        try {
          fitAddon.fit();
        } catch {
          /* dimensions not ready */
        }
        return;
      }
      if (fitMode === "scale") {
        // Compute scale based on terminal's natural pixel size vs outer.
        const oW = outer.clientWidth;
        const oH = outer.clientHeight;
        // The xterm DOM is now sized to its cols×rows grid.
        const nW = inner.scrollWidth || inner.offsetWidth;
        const nH = inner.scrollHeight || inner.offsetHeight;
        if (oW > 0 && oH > 0 && nW > 0 && nH > 0) {
          const sx = oW / nW;
          const sy = oH / nH;
          const s = Math.min(sx, sy);
          inner.style.transformOrigin = "top left";
          inner.style.transform = `scale(${s.toFixed(4)})`;
        }
      }
    };

    safeFit();

    const ro = new ResizeObserver(() => {
      safeFit();
    });
    ro.observe(outer);
    if (fitMode === "scale") ro.observe(inner);

    handleRef.current = {
      write: (data: string) => term.write(data),
      clear: () => term.clear(),
      fit: safeFit,
      dims: () => ({ cols: term.cols, rows: term.rows }),
    };

    return () => {
      handleRef.current = null;
      ro.disconnect();
      try {
        webgl?.dispose();
      } catch {
        /* ignore */
      }
      try {
        fitAddon?.dispose();
      } catch {
        /* ignore */
      }
      term.dispose();
    };
    // We deliberately depend only on stable opts; consumers should pass stable values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { containerRef, innerRef, handleRef };
}
