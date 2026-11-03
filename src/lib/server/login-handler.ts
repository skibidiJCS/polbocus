import "server-only";
import {
  AUTH_COOKIE, createDeviceToken, createSessionToken, DEVICE_COOKIE, DEVICE_DAYS, isSameOrigin, isSessionMode, MAX_PASSWORD_LENGTH,
  missingAuthSettings, passwordMatches, readCookie, SESSION_HOURS, verifyDeviceToken,
} from "@/lib/auth";
import { checkLoginAttempt, clearLoginAttempts, clientAddress } from "@/lib/server/login-throttle";
import { BodyTooLargeError, readLimitedJson } from "@/lib/server/request-body";
import { getSharedStore, type SharedStore } from "@/lib/server/shared-store";

const MAX_BODY_BYTES = 2048;
const noStore = { "cache-control": "no-store" };

export function createLoginHandler(getStore: () => SharedStore | null = getSharedStore, options: { failureDelayMs?: number } = {}) {
  const failureDelayMs = options.failureDelayMs ?? 600;
  return async function POST(request: Request) {
    if (!isSessionMode()) return Response.json({ error: "Sign-in is only used by the hosted version." }, { status: 404 });
    if (!isSameOrigin(request)) return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
    const store = getStore();
    if (missingAuthSettings().length || !store) return Response.json({ error: "Sign-in is not set up yet." }, { status: 503, headers: noStore });

    let body: Record<string, unknown>;
    try {
      body = await readLimitedJson(request, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return Response.json({ error: "That request is too large." }, { status: 413, headers: noStore });
      throw error;
    }

    const who = { deviceId: await verifyDeviceToken(readCookie(request, DEVICE_COOKIE)), address: clientAddress(request) };
    let decision;
    try {
      decision = await checkLoginAttempt(store, who);
    } catch {
      // Fail closed: without the shared counters there is no attempt limit.
      return Response.json({ error: "Sign-in is temporarily unavailable. Try again shortly." }, { status: 503, headers: { ...noStore, "retry-after": "30" } });
    }
    if (!decision.allowed) {
      const minutes = Math.ceil(decision.retryAfterSeconds / 60);
      return Response.json(
        { error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, retryAfterSeconds: decision.retryAfterSeconds },
        { status: 429, headers: { ...noStore, "retry-after": String(decision.retryAfterSeconds) } },
      );
    }

    const password = typeof body.password === "string" && body.password.length <= MAX_PASSWORD_LENGTH ? body.password : null;
    if (password === null || !(await passwordMatches(password))) {
      // A short pause on top of the shared budget.
      await new Promise((resolve) => setTimeout(resolve, failureDelayMs));
      return Response.json({ error: "That password isn’t right." }, { status: 401, headers: noStore });
    }

    await clearLoginAttempts(store, who).catch(() => {});
    const secure = new URL(request.url).protocol === "https:";
    const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", secure ? "Secure" : ""].filter(Boolean);
    const headers = new Headers({ "content-type": "application/json", ...noStore });
    headers.append("set-cookie", [`${AUTH_COOKIE}=${await createSessionToken()}`, ...attributes, `Max-Age=${SESSION_HOURS * 3600}`].join("; "));
    headers.append("set-cookie", [`${DEVICE_COOKIE}=${await createDeviceToken()}`, ...attributes, `Max-Age=${DEVICE_DAYS * 86_400}`].join("; "));
    return new Response(JSON.stringify({ ok: true }), { headers });
  };
}

