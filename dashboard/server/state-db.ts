// Read-only access to the puppet's state.db sessions table.
// Used to enrich SessionInfo with cols/rows/status/exit-code (so the dashboard
// can size terminals correctly and distinguish crashed from cleanly-exited).
//
// The DB is not always present (e.g. on a fresh install). We fail soft.

import { join } from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

// node:sqlite is a Node 22+ built-in. The @types/node we ship doesn't
// declare it; we type the bare minimum we use locally.
type SqliteRow = Record<string, unknown>;
type SqliteStmt = {
  get: (...params: unknown[]) => SqliteRow | undefined;
  all: (...params: unknown[]) => SqliteRow[];
};
type SqliteDb = {
  prepare: (sql: string) => SqliteStmt;
  close: () => void;
};
type SqliteModule = {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => SqliteDb;
};

export type SessionDbRow = {
  id: string;
  cols: number;
  rows: number;
  pid: number | null;
  permission_mode: string;
  cwd: string;
  status: string; // "running" | "exited" | "crashed" | etc.
  exit_code: number | null;
  exit_signal: string | null;
  created_at_ms: number;
  closed_at_ms: number | null;
  owner?: string | null;
};

function defaultDbPath(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(os.homedir(), ".cache");
  return join(base, "claude-puppet", "state.db");
}

let mod: SqliteModule | null = null;
let modLoaded = false;

async function loadMod(): Promise<SqliteModule | null> {
  if (modLoaded) return mod;
  modLoaded = true;
  try {
    // Dynamic import — guarded because the type isn't in @types/node yet.
    // Indirect through createRequire to avoid TS module resolution checks
    // (node:sqlite is not in @types/node yet but exists at runtime).
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    mod = req("node:sqlite") as SqliteModule;
  } catch {
    mod = null;
  }
  return mod;
}

export class StateDb {
  private path: string;
  private db: SqliteDb | null = null;
  private failed = false;

  constructor(path?: string) {
    this.path = path ?? defaultDbPath();
  }

  private async ensureOpen(): Promise<boolean> {
    if (this.db) return true;
    if (this.failed) return false;
    const m = await loadMod();
    if (!m) {
      this.failed = true;
      return false;
    }
    try {
      await fs.access(this.path);
    } catch {
      // DB not present — soft fail without poisoning future attempts so we
      // pick it up the moment it's created.
      return false;
    }
    try {
      this.db = new m.DatabaseSync(this.path, { readOnly: true });
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  async getRow(id: string): Promise<SessionDbRow | null> {
    if (!(await this.ensureOpen()) || !this.db) return null;
    try {
      const stmt = this.db.prepare(
        "SELECT id, cols, rows, pid, permission_mode, cwd, status, exit_code, exit_signal, created_at_ms, closed_at_ms, owner FROM sessions WHERE id = ?",
      );
      const row = stmt.get(id) as SessionDbRow | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  async getAll(): Promise<SessionDbRow[]> {
    if (!(await this.ensureOpen()) || !this.db) return [];
    try {
      const stmt = this.db.prepare(
        "SELECT id, cols, rows, pid, permission_mode, cwd, status, exit_code, exit_signal, created_at_ms, closed_at_ms, owner FROM sessions",
      );
      return stmt.all() as SessionDbRow[];
    } catch {
      return [];
    }
  }

  /**
   * Bulk-status lookup. Returns a Map of id → status for rows that exist
   * in the sessions table. Missing ids are simply omitted.
   *
   * Single prepared statement, IN-clause built from `ids.length` placeholders.
   */
  async getStatusForIds(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    if (!(await this.ensureOpen()) || !this.db) return out;
    try {
      const placeholders = ids.map(() => "?").join(",");
      const stmt = this.db.prepare(
        `SELECT id, status FROM sessions WHERE id IN (${placeholders})`,
      );
      const rows = stmt.all(...ids) as Array<{ id: string; status: string }>;
      for (const r of rows) {
        if (typeof r?.id === "string" && typeof r?.status === "string") {
          out.set(r.id, r.status);
        }
      }
    } catch {
      // ignore — best-effort
    }
    return out;
  }

  /** Read just the owner column for a single session. Returns null if missing. */
  async getOwner(id: string): Promise<string | null> {
    if (!(await this.ensureOpen()) || !this.db) return null;
    try {
      const stmt = this.db.prepare(
        "SELECT owner FROM sessions WHERE id = ?",
      );
      const row = stmt.get(id) as { owner?: string | null } | undefined;
      const o = row?.owner;
      if (typeof o === "string" && o.length > 0) return o;
      return null;
    } catch {
      return null;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = null;
  }
}
