const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "169.254.169.254"]);

const BLOCKED_PREFIXES = [
  "127.",
  "10.",
  "192.168.",
  "172.16.",
  "172.17.",
  "172.18.",
  "172.19.",
  "172.20.",
  "172.21.",
  "172.22.",
  "172.23.",
  "172.24.",
  "172.25.",
  "172.26.",
  "172.27.",
  "172.28.",
  "172.29.",
  "172.30.",
  "172.31.",
];

function isPrivateIP(hostname: string): boolean {
  if (BLOCKED_HOSTS.has(hostname)) return true;
  if (hostname.startsWith("["))
    return hostname === "[::1]" || hostname.startsWith("[fc") || hostname.startsWith("[fd");
  return BLOCKED_PREFIXES.some((p) => hostname.startsWith(p));
}

export class UrlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlGuardError";
  }
}

/** Validate URL is safe to fetch. Throws UrlGuardError if not. */
export function assertSafeUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UrlGuardError(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlGuardError(`Blocked protocol: ${parsed.protocol}`);
  }

  if (isPrivateIP(parsed.hostname)) {
    throw new UrlGuardError(`Blocked host: ${parsed.hostname}`);
  }

  return parsed;
}

/** Max redirect count for fetch safety */
export const MAX_REDIRECTS = 5;
/** Max response bytes before cancellation */
export const MAX_RESPONSE_BYTES = 20_000;
/** Fetch timeout in ms */
export const FETCH_TIMEOUT_MS = 10_000;
