// Mirror of server/types.ts for the web client. Keep these in sync.

export type SessionInfo = {
  id: string;
  pid?: number;
  cwd?: string;
  permissionMode?: string;
  openedAt: number;
  exited?: boolean;
  exitCode?: number | null;
  exitSignal?: string | null;
  /** PTY columns. Defaults to 200 if unknown. */
  cols?: number;
  /** PTY rows. Defaults to 50 if unknown. */
  rows?: number;
  /** "running" | "exited" | "crashed" | etc. */
  status?: string;
  /** Self-reported owner string from open_session. May be "anonymous". */
  owner?: string;
  /** Bytes ever written to this session's transcript. 0 = empty session; hidden by default in the dashboard. */
  bytesSeen?: number;
};

export type PtyDir = "out" | "in";

export type PtyDataEvent = {
  type: "pty_data";
  id: string;
  ts: number;
  dir: PtyDir;
  text: string;
};

export type ToolCallEvent = {
  type: "tool_call";
  id: string | null;
  ts: number;
  op: string;
  args: unknown;
  result: unknown;
  error: string | null;
  duration_ms: number;
  /** "dashboard" when the action came from the dashboard's HTTP control surface. */
  source?: string;
};

export type SessionOpenEvent = { type: "session_open"; session: SessionInfo };
export type SessionCloseEvent = { type: "session_close"; id: string; ts: number };
export type SnapshotEvent = { type: "snapshot"; sessions: SessionInfo[] };

export type MasterSummary = {
  id: string;
  liveCount: number;
  totalCount: number;
  lastActivityMs: number;
};

export type MasterSummaryEvent = {
  type: "master_summary";
  masters: MasterSummary[];
};

export type MasterViewRow = { class: string; text: string };

export type MasterViewEvent = {
  type: "master_view";
  id: string;
  ts: number;
  rows: MasterViewRow[];
  render_hash: string;
  content_hash: string;
};

export type StatusChangeEvent = {
  type: "status_change";
  id: string;
  status: "alive" | "closed" | "crashed" | string;
  ts: number;
};

export type ServerEvent =
  | SnapshotEvent
  | SessionOpenEvent
  | SessionCloseEvent
  | PtyDataEvent
  | ToolCallEvent
  | MasterSummaryEvent
  | MasterViewEvent
  | StatusChangeEvent;

export type ClientMessage = { type: "visible_set"; ids: string[] };

export type WsStatus = "connecting" | "open" | "closed";

export type Bucket = { ts: number; v: number };

export type Metrics = {
  bytesPerSec: Bucket[];
  totalBytes: number;
  lastDataTs: number;
};
