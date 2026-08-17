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
function mockPassword() {
  return env().MOCK_PASSWORD ?? "admin";
}

export async function login(password: string): Promise<{ cookie: string } | { error: string }> {
  if (password !== mockPassword()) return { error: "Invalid password" };
  const session = await createSession(mockUserId());
  return { cookie: sessionCookieHeader(session) };
}

export async function getSession(cookieHeader: string | null) {
  return readSession(cookieHeader);
}

export function logout() {
  return clearCookieHeader();
}
