import { AUTH_COOKIE, createSessionToken, isSameOrigin, isSessionMode, missingAuthSettings, passwordMatches, SESSION_HOURS } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSessionMode()) return Response.json({ error: "Sign-in is only used by the hosted version." }, { status: 404 });
  if (!isSameOrigin(request)) return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  if (missingAuthSettings().length) return Response.json({ error: "Sign-in is not set up yet." }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password : "";
  if (!(await passwordMatches(password))) {
    // Slows down guessing; there is no account store to lock.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return Response.json({ error: "That password isn’t right." }, { status: 401 });
  }
  const secure = new URL(request.url).protocol === "https:";
  const cookie = [
    `${AUTH_COOKIE}=${await createSessionToken()}`,
    "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_HOURS * 3600}`, secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": cookie, "cache-control": "no-store" } });
}
