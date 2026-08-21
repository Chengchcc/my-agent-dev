import { createHash, timingSafeEqual } from "node:crypto";
import { parseEnv } from "@chengchenccc/config";
import { clearCookieHeader, createSession, readSession, sessionCookieHeader } from "./session";

let _env: ReturnType<typeof parseEnv> | undefined;
function env() {
  if (!_env) _env = parseEnv(process.env);
  return _env;
}

function mockUserId() {
  return env().MOCK_USER_ID ?? "user-001";
}

/** F3: no default password. Unconfigured MOCK_PASSWORD fails closed — login
 *  is locked, with a one-time random escape hatch printed for a local
 *  operator (the console is the only place it ever appears). */
let _ephemeralPassword: string | null = null;
function mockPassword(): string {
  const configured = env().MOCK_PASSWORD;
  if (configured) return configured;
  _ephemeralPassword ??= crypto.randomUUID();
  console.warn(
    `[auth] MOCK_PASSWORD is not configured; login is locked. One-time local ` +
      `escape password: ${_ephemeralPassword}`,
  );
  return _ephemeralPassword;
}

/** Constant-time comparison: hash both sides to fixed length first, then
 *  timingSafeEqual. Prevents length/prefix timing side channels. */
export function timingSafeEqualPassword(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function login(password: string): Promise<{ cookie: string } | { error: string }> {
  if (!timingSafeEqualPassword(password, mockPassword())) return { error: "Invalid password" };
  const session = await createSession(mockUserId());
  return { cookie: sessionCookieHeader(session) };
}

export async function getSession(cookieHeader: string | null) {
  return readSession(cookieHeader);
}

export function logout() {
  return clearCookieHeader();
}
