// Browser-side wrappers around the dashboard backend's MCP control routes.
// All errors bubble as Error so callers can render a toast.

type ControlResult = { ok: boolean; result?: unknown; error?: string };

async function postJson(path: string, body: unknown): Promise<ControlResult> {
  const res = await fetch(path, {
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
