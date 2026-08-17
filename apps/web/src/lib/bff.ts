import { parseEnv } from "@chengchenccc/config";

let _env: ReturnType<typeof parseEnv> | undefined;

function env() {
  if (!_env) _env = parseEnv(process.env);
  return _env;
}

function getBackendUrl(): string {
  return env().BACKEND_URL;
}

function getBackendToken(): string {
  return env().BACKEND_AUTH_TOKEN;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const PASSTHROUGH_RESPONSE = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "cache-control",
  "etag",
  "last-modified",
  "location",
]);

function hasBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export function stripHopByHop(headers: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

export function passthroughHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of headers) {
    if (PASSTHROUGH_RESPONSE.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

function isAbortLike(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  return name === "AbortError" || name === "ResponseAborted" || /aborted/i.test(message);
}

function isSsePath(pathSegments: string[]): boolean {
  const last = pathSegments.at(-1);
  return last === "stream" || last === "events";
}

export async function proxyRequest(
  req: Request,
  pathSegments: string[],
  userId: string,
): Promise<Response> {
  const BACKEND_URL = getBackendUrl();
  const BACKEND_TOKEN = getBackendToken();

  const url = new URL(req.url);
  // Normalize: backend routes are under /api/; Treaty generates /api/bff/api/...
  // while manual fetch may use /api/bff/conversations/... — accept both.
  const segments = pathSegments[0] === "api" ? pathSegments.slice(1) : pathSegments;
  const upstreamUrl = `${BACKEND_URL}/api/${segments.join("/")}${url.search}`;

  const upstreamHeaders = stripHopByHop(req.headers);
  upstreamHeaders.set("x-auth-token", BACKEND_TOKEN);
  upstreamHeaders.set("x-user-id", userId);
  upstreamHeaders.delete("host");

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: hasBody(req.method) ? await req.arrayBuffer() : undefined,
      // SSE connections must stay open independently of the incoming request
      // lifecycle — passing req.signal causes Next.js dev-mode abort to kill
      // the upstream SSE, triggering EventSource reconnect storms.
      signal: isSsePath(pathSegments) ? undefined : req.signal,
    });

    const responseHeaders = passthroughHeaders(upstream.headers);
    responseHeaders.set("Cache-Control", "no-transform");
    responseHeaders.set("X-Accel-Buffering", "no");

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err) {
    // SSE streams naturally close via AbortController — not a real error.
    // Only suppress abort-like errors for SSE paths; let other API calls
    // still throw so they don't mask real issues.
    if (isSsePath(pathSegments) && isAbortLike(err)) {
      return new Response(null, { status: 204 });
    }
    throw err;
  }
}
