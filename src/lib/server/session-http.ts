import "server-only";
import { AUTH_COOKIE, isSameOrigin, isSessionMode, readCookie, verifySessionToken } from "@/lib/auth";
import { ServiceError } from "./errors";
import { errorResponse } from "./http";
import { BodyTooLargeError, readLimitedJson } from "./request-body";

export { errorResponse };

const MAX_BODY_BYTES = 16_384;

/** JSON body from fetch() or navigator.sendBeacon() (which sends text/plain), size-limited. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return await readLimitedJson(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new ServiceError("That request is too large.", 413);
    throw error;
  }
}

/**
 * Every hosted-session route runs this before touching Blob, TwelveLabs or the shared store:
 * the route exists only in hosted mode, the request is same-origin, and it carries the
 * owner's signed session cookie. The proxy checks the cookie too; this is defence in depth.
 */
export async function guardSessionRequest(request: Request): Promise<Response | null> {
  if (!isSessionMode()) return Response.json({ error: "Not found." }, { status: 404 });
  if (!isSameOrigin(request)) return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  if (!(await verifySessionToken(readCookie(request, AUTH_COOKIE)))) return Response.json({ error: "Sign in first." }, { status: 401 });
  return null;
}
