import { after } from "next/server";
import { assertSessionId, touchSession } from "@/lib/server/session";
import { errorResponse, guardSessionRequest, readJson } from "@/lib/server/session-http";
import { getSessionDeps, processDueOpportunistically } from "@/lib/server/session-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sent every few minutes while the page is open, so an idle-but-open session is kept. */
export async function POST(request: Request) {
  const rejected = await guardSessionRequest(request);
  if (rejected) return rejected;
  try {
    const deps = getSessionDeps();
    const body = await readJson(request);
    await touchSession(deps, assertSessionId(body.sessionId));
    after(() => processDueOpportunistically(deps));
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
