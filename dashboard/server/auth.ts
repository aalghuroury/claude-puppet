// Bearer-token authentication for the dashboard's HTTP control surface.
//
// The dashboard binds to 127.0.0.1, but we still require a bearer token on
// every `/api/*` route (both GET and POST) to prevent local cross-user /
// browser-CSRF abuse. The only auth-less route is `GET /healthz` plus the
// SPA's static HTML/asset files at `/`, `/index.html`, and `/assets/*`.
//
// Token resolution order:
//   1. `CLAUDE_PUPPET_DASHBOARD_TOKEN` env var, if set and non-empty.
//   2. Existing token file at `~/.cache/claude-puppet/dashboard-token`,
//      if present.
//   3. Otherwise, generate a fresh 32-byte hex token via `crypto.randomBytes`
//      and write it to the token file with mode 0o600.
//
// The active token is logged once to stderr at startup so the user can copy
// it into client tooling.
//
// All header comparisons use `crypto.timingSafeEqual` (after an explicit
// equal-length check) to avoid timing leaks.
//
// No npm deps — `node:crypto`, `node:fs`, `node:os`, `node:path` only.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

function tokenFilePath(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base =
    xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "claude-puppet", "dashboard-token");
}

/**
 * Resolve the dashboard auth token, in priority order:
 *   env var → existing token file → freshly generated token (persisted).
 *
 * Synchronous so it can run before `server.listen` without leaving a window
 * during which POST routes are reachable but unauthenticated.
 */
export function loadOrCreateToken(): { token: string; source: "env" | "file" | "generated"; path: string } {
  const envTok = process.env.CLAUDE_PUPPET_DASHBOARD_TOKEN;
  if (typeof envTok === "string" && envTok.length > 0) {
    return { token: envTok, source: "env", path: tokenFilePath() };
  }

  const file = tokenFilePath();
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    if (raw.length > 0) {
      return { token: raw, source: "file", path: file };
    }
  }

  const tok = randomBytes(32).toString("hex");
  mkdirSync(path.dirname(file), { recursive: true });
  // 0o600 — owner read/write only.
  writeFileSync(file, tok + "\n", { mode: 0o600 });
  // If the file already existed with looser perms, tighten now (writeFileSync
  // does NOT chmod an existing file).
  try {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fs.chmod(file, 0o600);
  } catch {
    /* best-effort */
  }
  return { token: tok, source: "generated", path: file };
}

/**
 * Constant-time bearer-token check. Returns true iff `header` is exactly
 * `Bearer <token>` and the trailing portion equals `expected`.
 *
 * Length mismatch is rejected up front (timingSafeEqual throws on
 * unequal-length buffers).
 */
export function checkBearer(header: string | undefined, expected: string): boolean {
  if (typeof header !== "string") return false;
  // RFC 7235: auth-scheme is case-insensitive ("Basic", "Bearer", "Digest").
  const m = /^bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) return false;
  const got = m[1];
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Express middleware. Enforces bearer auth on EVERY request through this
 * middleware (regardless of method). Designed to be mounted on the `/api`
 * sub-router so all data-bearing endpoints require auth; routes that should
 * remain auth-less (e.g. `GET /healthz`, `GET /index.html`) must be
 * registered at the app level outside this middleware.
 *
 * Auth method: `Authorization: Bearer <token>` header. The frontend reads
 * the token from a `<meta name="x-dashboard-token">` tag injected into the
 * served HTML (see `serveIndexWithToken` in index.ts).
 */
export function makeAuthMiddleware(expected: string) {
  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers["authorization"];
    const headerStr = Array.isArray(header) ? header[0] : header;
    if (!checkBearer(headerStr, expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
