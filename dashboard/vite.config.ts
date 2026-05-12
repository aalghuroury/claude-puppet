import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "web",
  server: {
    port: 5055,
    proxy: {
      "/api": "http://localhost:7780",
      "/ws": { target: "ws://localhost:7780", ws: true },
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split heavyweight third-party deps so the initial JS bundle is
        // under our 620 KB target. xterm + addons get one chunk; React
        // gets its own. The lazy `FocusedSessionImpl` / `TranscriptReplay`
        // dynamic imports already produce separate chunks automatically.
        manualChunks(id: string): string | undefined {
          if (id.includes("node_modules/xterm/") || id.includes("node_modules/@xterm/")) {
            return "xterm";
          }
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler/")
          ) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
});
