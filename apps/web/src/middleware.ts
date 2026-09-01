import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Paths accessible without session
const PUBLIC_PREFIXES = ["/login", "/api/auth"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  // Check for session cookie (BFF will verify HMAC server-side;
  // middleware only checks existence for UX redirect)
  const session = req.cookies.get("maw_session");
  if (!session?.value) {
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
