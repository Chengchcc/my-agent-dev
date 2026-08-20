import { parseEnv } from "@chengchenccc/config";

let _env: ReturnType<typeof parseEnv> | undefined;
function env() {
  if (!_env) _env = parseEnv(process.env);
  return _env;
}

function getSessionSecret(): string {
  const secret = env().SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET env is required");
  return secret;
}

const COOKIE_NAME = "maw_session";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface SessionPayload {
  userId: string;
  exp: number;
}

async function encodeBase64Url(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function decodeBase64Url(str: string): Promise<ArrayBuffer> {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function sign(payload: string): Promise<string> {
  const enc = new TextEncoder();
  const keyData = enc.encode(getSessionSecret());
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return encodeBase64Url(sig);
}

async function verify(payload: string, sig: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyData = enc.encode(getSessionSecret());
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sigBuf = await decodeBase64Url(sig);
  return crypto.subtle.verify("HMAC", key, sigBuf, enc.encode(payload));
}

export async function createSession(userId: string): Promise<string> {
  const payload: SessionPayload = { userId, exp: Date.now() + MAX_AGE_MS };
  const json = JSON.stringify(payload);
  const sig = await sign(json);
  return `${await encodeBase64Url(new TextEncoder().encode(json).buffer)}.${sig}`;
}

export async function readSession(cookieHeader: string | null): Promise<SessionPayload | null> {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const sessionCookie = cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!sessionCookie) return null;
  const value = sessionCookie.slice(COOKIE_NAME.length + 1);
  const dotIdx = value.lastIndexOf(".");
  if (dotIdx < 0) return null;
  const encodedPayload = value.slice(0, dotIdx);
  const sig = value.slice(dotIdx + 1);
  let json: string;
  try {
    const jsonBuf = await decodeBase64Url(encodedPayload);
    json = new TextDecoder().decode(jsonBuf);
  } catch {
    return null; // malformed cookie → 401, not 500
  }
  if (!(await verify(json, sig))) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(json) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
  return payload;
}

function isSecureEnv(): boolean {
  // Opt-in: Secure cookies are rejected by browsers on http:// (the local
  // dev/self-host surface). HTTPS deployments set SESSION_COOKIE_SECURE=1.
  return env().SESSION_COOKIE_SECURE === "1";
}

export function sessionCookieHeader(value: string, maxAge: number = MAX_AGE_MS / 1000): string {
  const secure = isSecureEnv() ? "; Secure" : "";
  return `${COOKIE_NAME}=${value}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookieHeader(): string {
  const secure = isSecureEnv() ? "; Secure" : "";
  return `${COOKIE_NAME}=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0`;
}
