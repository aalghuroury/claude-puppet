import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./web/index.html", "./web/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Telemetry-desk palette: warm near-black canvas, parchment fg,
        // a single sodium-orange accent. Status hues used surgically.
        canvas: "#0c0b09",
        panel: "#15130f",
        recess: "#080703",
        rule: "#2a261c",
        "rule-bright": "#3d3527",
        fg: "#ede5d2",
        "fg-mid": "#9c9485",
        "fg-dim": "#5e574a",
        "fg-faint": "#3c372d",
        accent: "#ff7a1a",
        "accent-soft": "#c4621a",
        "accent-quiet": "#8a4612",
        ok: "#a3c47c",
        warn: "#e6b04f",
        err: "#cc6666",
        info: "#7ba8c4",
      },
      fontFamily: {
        // Display: characterful editorial serif with optical sizing axis.
        display: [
          '"Fraunces"',
          "ui-serif",
          "Georgia",
          "serif",
        ],
        // UI body: variable sans with subtle quirk (FLAR + VOLM axes).
        ui: [
          '"Commissioner"',
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        // Mono for hashes, IDs, telemetry numerals.
        mono: [
          '"JetBrains Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      letterSpacing: {
        "ultra-wide": "0.32em",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-top": {
          "0%": { opacity: "0", transform: "translateY(-6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-accent": {
          "0%, 100%": { borderColor: "#2a261c" },
          "50%": { borderColor: "#ff7a1a" },
        },
        "blip": {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
      },
      animation: {
        "fade-up": "fade-up 220ms cubic-bezier(0.2, 0.7, 0.2, 1)",
        "slide-in-top": "slide-in-top 180ms cubic-bezier(0.2, 0.7, 0.2, 1)",
        "pulse-accent": "pulse-accent 220ms ease-out",
        "blip": "blip 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};

export default config;
