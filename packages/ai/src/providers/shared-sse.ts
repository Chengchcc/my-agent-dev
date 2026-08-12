/** DIP: StreamTransport. Only HTTP + SSE line splitting. Never inspects
 *  event content — that's ApiImplementation's job. */

export interface SSEFetchOpts {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export async function* fetchSSE(opts: SSEFetchOpts): AsyncIterable<Record<string, unknown>> {
  const res = await fetch(opts.url, {
    method: "POST",
    headers: opts.headers,
    body: opts.body,
    signal: opts.signal,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    const err = new Error(`status=${res.status} ${errBody}`);
    const retryAfterMs = res.headers.get("retry-after-ms");
    if (retryAfterMs) {
      const ms = Number.parseFloat(retryAfterMs);
      if (Number.isFinite(ms) && ms >= 0)
        (err as Error & { retryAfterMs?: number }).retryAfterMs = ms;
    }
    throw err;
  }
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data: ")) continue;
      const data = t.slice(6);
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data);
      } catch {
        /* skip malformed */
      }
    }
  }
}
