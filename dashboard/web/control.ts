// Browser-side wrappers around the dashboard backend's MCP control routes.
// All errors bubble as Error so callers can render a toast.

import { pushToast } from "./components/Toasts";

type ControlResult = { ok: boolean; result?: unknown; error?: string };

// Read the dashboard bearer token once at module load. The server str-replaces
// the placeholder `<meta name="x-dashboard-token" content="">` in index.html
// with the live token before responding. In `vite dev` the meta tag is empty,
// so POSTs will 401 — but GETs and the read-only UI keep working.
const DASHBOARD_TOKEN: string =
  (typeof document !== "undefined" &&
    document
      .querySelector('meta[name="x-dashboard-token"]')
      ?.getAttribute("content")) ||
  "";

let _missingTokenToastShown = false;

/**
 * Wrapper around `fetch` that attaches `Authorization: Bearer <token>` when a
 * dashboard token was injected into the page. Falls through to a plain
 * `fetch()` when the token is empty so the dev server keeps working for
 * read-only routes.
 *
 * On a 401 with an empty token, emits a one-shot toast so the user sees
 * "token not configured" rather than a silent failure.
 */
export async function authedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  let finalInit: RequestInit = init;
  if (DASHBOARD_TOKEN.length > 0) {
    const headers = new Headers(init.headers ?? undefined);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${DASHBOARD_TOKEN}`);
    }
    finalInit = { ...init, headers };
  }
  const res = await fetch(input, finalInit);
  if (res.status === 401 && DASHBOARD_TOKEN.length === 0 && !_missingTokenToastShown) {
    _missingTokenToastShown = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[control] dashboard bearer token not configured (meta x-dashboard-token is empty); POST routes will 401",
    );
    pushToast(
      "err",
      "dashboard token not configured — interactive controls disabled",
    );
  }
  return res;
}

async function postJson(path: string, body: unknown): Promise<ControlResult> {
  const res = await authedFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let data: ControlResult;
  try {
    data = (await res.json()) as ControlResult;
  } catch {
    throw new Error(`HTTP ${res.status}: invalid JSON response`);
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data;
}

export const control = {
  sendKeys: (id: string, keys: string[]) =>
    postJson(`/api/sessions/${encodeURIComponent(id)}/keys`, { keys }),
  sendText: (id: string, text: string) =>
    postJson(`/api/sessions/${encodeURIComponent(id)}/text`, { text }),
  interrupt: (id: string, force = false) =>
    postJson(`/api/sessions/${encodeURIComponent(id)}/interrupt`, { force }),
  closeSession: (id: string) =>
    postJson(`/api/sessions/${encodeURIComponent(id)}/close`, {}),
  resize: (id: string, cols: number, rows: number) =>
    postJson(`/api/sessions/${encodeURIComponent(id)}/resize`, { cols, rows }),
};
