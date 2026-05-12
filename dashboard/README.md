# claude-puppet dashboard

Mission-control dashboard for `claude-puppet` slave sessions.

Live CCTV-style grid of every running slave terminal, a master tool-call
timeline, real-time metrics, and a permission-prompt detector — all built
on the append-only files claude-puppet writes under
`~/.cache/claude-puppet/sessions/`.

## Stack

- Backend: Express + ws + chokidar (TypeScript, `tsx` for dev)
- Frontend: Vite + React 18 + TypeScript (strict) + Tailwind v3 + Zustand
- Terminal rendering: xterm.js v5 with `@xterm/addon-fit` and
  `@xterm/addon-webgl` (graceful fallback to canvas when WebGL is unavailable)
- Charts: Recharts; icons: lucide-react

## Run

```sh
cd dashboard
npm install
npm run dev          # web on :5055; backend on :7780 (proxied via /api and /ws)
# or
npm run build && npm start   # single-port production server on :5055
```

Open <http://localhost:5055>. The dashboard is read-only — it does not
spawn or signal slaves. Override the port with `PORT=8080 npm start`.

## Keyboard

- `g` — grid view
- `1`–`9` — focus that session (in open-order)
- `Esc` — back to grid
- `f` — focus the timeline filter (when nothing else is focused)

## Wire protocol

WebSocket on `/ws`, messages are JSON:

```ts
type ServerEvent =
  | { type: "snapshot"; sessions: SessionInfo[] }
  | { type: "session_open"; session: SessionInfo }
  | { type: "session_close"; id: string; ts: number }
  | { type: "pty_data"; id: string; ts: number; dir: "out"|"in"; text: string }
  | { type: "tool_call"; id: string|null; ts: number; op: string;
       args: any; result: any; error: string|null; duration_ms: number };
```

On connect the server replays the last 200 pty events per session and the
last 200 master tool calls so the UI has context immediately.

## Layout

```
dashboard/
├── server/     # Express + ws + chokidar tailers
└── web/        # Vite + React + Tailwind + xterm.js
```
