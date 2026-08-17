import type { App } from "@chengchenccc/backend/app";
import { treaty } from "@elysiajs/eden";

/** Client-side treaty — through BFF (cookie → x-auth-token translation). */
export const client = treaty<App>("/api/bff", {
  keepDomain: true,
  fetch: { credentials: "include" },
});

/** Server-side treaty — direct to backend with x-auth-token (SSR bootstrap). */
export function createServerClient(backendUrl: string, authToken: string) {
  return treaty<App>(backendUrl, {
    headers: { "x-auth-token": authToken },
  });
}

/**
 * Unwrap treaty response into typed JSON body.
 *
 * Treaty infers `data` type from backend App. At runtime, the BFF proxy wraps
 * responses in `Response` — we detect that and extract JSON. When talking directly
 * to backend (e.g. SSR createServerClient), `data` is the plain object.
 *
 * `Strip` removes `Response` and `null` from the inferred union — they're handled
 * at runtime (Response → .json(), null → throw) but mustn't leak to callers.
 */
type Strip<T> = T extends Response ? never : T extends null ? never : T;

export async function unwrap<T>(
  p: Promise<{ data: T; error: unknown; status: number }>,
): Promise<Strip<T>> {
  const { data, error, status } = await p;
  if (status === 401 && typeof window !== "undefined") {
    window.location.href = "/login";
    throw new ApiError(401, "Session expired");
  }
  if (error) {
    throw new ApiError(status, typeof error === "string" ? error : JSON.stringify(error));
  }
  if (data == null) throw new ApiError(status, "Empty response");
  if (status === 204) return undefined as unknown as Strip<T>;
  // BFF proxy wraps backend responses in Response — extract JSON body
  if (data instanceof Response) return data.json();
  // Direct backend access (e.g. SSR createServerClient) — data is already the typed object
  return data as unknown as Strip<T>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
