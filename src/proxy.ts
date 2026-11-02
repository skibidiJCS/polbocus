import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, isSessionMode, verifySessionToken } from "@/lib/auth";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login"]);

/** In hosted mode every page and API route requires the owner's session cookie. */
export async function proxy(request: NextRequest) {
  if (!isSessionMode() || PUBLIC_PATHS.has(request.nextUrl.pathname)) return NextResponse.next();
  if (await verifySessionToken(request.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
