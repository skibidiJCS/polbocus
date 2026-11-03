import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, isSessionMode, verifySessionToken } from "@/lib/auth";
import { HOSTED_ONLY_PREFIXES, isLocalHost, LOCAL_ONLY_PREFIXES, matchesPrefix } from "@/lib/hosts";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login"]);
// Vercel Cron calls this without a cookie; the route itself requires CRON_SECRET.
const SECRET_PATHS = new Set(["/api/cron/cleanup"]);

const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404 });

/**
 * Runs before every page, RSC request and API route.
 * - Local library mode: only requests addressed to localhost, and no hosted-only routes.
 * - Hosted mode: no local-library routes, and the owner's session cookie everywhere else.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!isSessionMode()) {
    if (!isLocalHost(request.headers.get("host"))) {
      return new NextResponse("This app only answers requests to localhost.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return matchesPrefix(pathname, HOSTED_ONLY_PREFIXES) ? notFound() : NextResponse.next();
  }

  if (matchesPrefix(pathname, LOCAL_ONLY_PREFIXES)) return notFound();
  if (PUBLIC_PATHS.has(pathname) || SECRET_PATHS.has(pathname)) return NextResponse.next();
  if (await verifySessionToken(request.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
