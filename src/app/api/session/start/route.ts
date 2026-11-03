import { after } from "next/server";
import { startSession } from "@/lib/server/session";
import { errorResponse, guardSessionRequest, readJson } from "@/lib/server/session-http";
import { getSessionDeps, processDueOpportunistically } from "@/lib/server/session-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = await guardSessionRequest(request);
  if (rejected) return rejected;
  try {
    const deps = getSessionDeps();
    const body = await readJson(request);
    const session = await startSession(deps, { sessionId: body.sessionId, pathname: body.pathname, filename: body.filename });
    after(() => processDueOpportunistically(deps));
    return Response.json(session, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
