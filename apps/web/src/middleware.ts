import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readSession } from "@/lib/session";

// Paths accessible without session
const PUBLIC_PREFIXES = ["/login", "/api/auth"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  // REAL session verification (HMAC + exp), not just cookie existence:
  // SSR pages fetch data with the server-side backend token and never pass
  // through the BFF's session check, so a forged maw_session cookie used to
  // read every workflow/conversation page (proven bypass, 2026-09-07).
  // readSession is edge-safe (WebCrypto + zod-only config import).
  const session = await readSession(req.headers.get("cookie"));
  if (!session) {
    const next = encodeURIComponent(`${req.nextUrl.pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(new URL(`/login?next=${next}`, req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - /login, /api/auth/* (public, handled in-code)
     * - /_next/* (Next.js internals)
     * - Static files (fonts, images, etc.)
     */
    "/((?!_next|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js|map|woff2?|ttf|eot)$).*)",
  ],
};
