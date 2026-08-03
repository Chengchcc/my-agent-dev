import { timingSafeEqual } from "node:crypto";

/** Constant-time service token verification. Missing, short, long, and
 *  incorrect tokens all produce an indistinguishable 401. */
export function verifyToken(configuredToken: string, candidate: string | null): boolean {
  if (!candidate) return false;
  if (candidate.length !== configuredToken.length) return false;
  const a = Buffer.from(configuredToken);
  const b = Buffer.from(candidate);
  return timingSafeEqual(a, b);
}

export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match?.[1] ?? null;
}
