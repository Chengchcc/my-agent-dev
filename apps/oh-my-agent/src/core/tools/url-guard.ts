import { lookup } from "node:dns/promises";

const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "169.254.169.254"]);

/** True when an IPv4 dotted string falls in a non-routable/sensitive range:
 *  loopback, private (RFC1918), this-network, link-local, CGNAT (100.64/10),
 *  benchmarking (198.18/15), and 0.0.0.0/8. */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = [parts[0]!, parts[1]!];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivateIP(hostname: string): boolean {
  // Trailing-dot and case forms ("localhost.", "LOCALHOST") dodge set lookup.
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (BLOCKED_HOSTS.has(host) || host === "localhost") return true;
  // IPv6 (WHATWG URL brackets it): loopback, ULA fc00::/7, link-local
  // fe80::/10, and IPv4-mapped ::ffff:a.b.c.d whose v4 part may be blocked.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.includes(":")) {
    if (bare.includes("ffff:")) {
      // WHATWG normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1 — handle both
      // dotted and hex hextet spellings of the embedded IPv4.
      const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
      if (dotted) return isBlockedIPv4(dotted[1]!);
      const hex = /^::ffff:([0-9a-f]{0,4}):([0-9a-f]{1,4})$/i.exec(bare);
      if (hex) {
        const hi = parseInt(hex[1] || "0", 16);
        const lo = parseInt(hex[2]!, 16);
        return isBlockedIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
      }
    }
    return bare === "::1" || /^f[cd]/.test(bare) || /^fe[89ab]/.test(bare);
  }
  return isBlockedIPv4(host);
}

export class UrlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlGuardError";
  }
}

/** Validate URL is safe to fetch. Throws UrlGuardError if not. */
export function assertSafeUrl(rawUrl: string): URL {
  return assertSafeUrlSync(rawUrl);
}

function assertSafeUrlSync(rawUrl: string): URL {
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

/** Best-effort DNS containment: resolves the hostname and rejects when any
 *  answer lands in a blocked range (nip.io / rebinding-style pivots). Not
 *  TOCTOU-proof — the fetch re-resolves independently — but it closes the
 *  trivial "hostname is 127.0.0.1 via DNS" bypass. */
export async function assertSafeUrlDeep(rawUrl: string): Promise<URL> {
  const parsed = assertSafeUrlSync(rawUrl);
  if (parsed.hostname.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname)) {
    return parsed; // literal IP or IPv6 — already vetted by isPrivateIP
  }
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await lookup(parsed.hostname, { all: true, verbatim: true });
  } catch {
    return parsed; // unresolved — let fetch surface the real error
  }
  for (const a of answers) {
    if (isPrivateIP(a.address)) {
      throw new UrlGuardError(`Blocked host (resolves to private address): ${parsed.hostname}`);
    }
  }
  return parsed;
}

/** Max redirect count for fetch safety */
export const MAX_REDIRECTS = 5;
/** Max response bytes before cancellation */
export const MAX_RESPONSE_BYTES = 20_000;
/** Fetch timeout in ms */
export const FETCH_TIMEOUT_MS = 10_000;
