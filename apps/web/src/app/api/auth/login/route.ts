import { type NextRequest, NextResponse } from "next/server";
import { login } from "@/lib/auth";
import { createRateLimiter } from "@/lib/rate-limit";

/** F3: per-IP in-memory throttle — 5 failures lock the address for 60s. */
const limiter = createRateLimiter({ maxFailures: 5, lockMs: 60_000 });

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "local";
}

export async function POST(req: NextRequest): Promise<Response> {
  // Accept both JSON (fetch) and form-urlencoded (native form)
  const contentType = req.headers.get("content-type") ?? "";
  const password = contentType.includes("application/json")
    ? (((await req.json().catch(() => ({}))) as { password?: string })?.password ?? "")
    : ((await req.formData().catch(() => new FormData())).get("password")?.toString() ?? "");

  const ip = clientIp(req);
  if (limiter.locked(ip)) {
    return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
  }

  const result = await login(password);
  if ("error" in result) {
    limiter.fail(ip);
    // For JSON requests, return 401 JSON. For form, redirect back to login.
    if (contentType.includes("application/json")) {
      return NextResponse.json({ error: result.error }, { status: 401 });
    }
    return new Response(null, {
      status: 302,
      headers: { Location: "/login?error=invalid_password" },
    });
  }
  limiter.reset(ip);

  // 302 with a RELATIVE Location: the browser resolves it against the
  // request origin. An absolute URL derived from req.url/nextUrl flips to
  // the server's internal host (localhost) and strands the cookie on
  // 127.0.0.1 clients.
  return new Response(null, {
    status: 302,
    headers: { Location: "/today", "Set-Cookie": result.cookie },
  });
}
