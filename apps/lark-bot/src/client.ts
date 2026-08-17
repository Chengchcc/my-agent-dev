import type { App } from "@chengchenccc/backend/app";
import type { Treaty } from "@elysiajs/eden";
import { treaty } from "@elysiajs/eden";

type AppClient = Treaty.Create<App>;

export function createClient(backendUrl: string, token: string | null): AppClient {
  const headers: Record<string, string> = {};
  if (token) headers["x-auth-token"] = token;
  return treaty<App>(backendUrl, { headers });
}
