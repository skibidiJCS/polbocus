import { endSession } from "@/lib/server/session";
import { errorResponse, guardSessionRequest, readJson } from "@/lib/server/session-http";
import { getSessionDeps } from "@/lib/server/session-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Called with navigator.sendBeacon when the page is left, and by "New video". Deletion is
 * attempted right away; if it fails the session stays queued for retry and the response
 * says so ("retrying" or "failed").
 */
export async function POST(request: Request) {
  const rejected = await guardSessionRequest(request);
  if (rejected) return rejected;
  try {
    const body = await readJson(request);
    const result = await endSession(getSessionDeps(), { sessionId: body.sessionId });
    return Response.json(result, { status: result.outcome === "deleted" ? 200 : 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
