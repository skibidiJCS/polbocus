import { after } from "next/server";
import { startSession, sweepStaleSessions } from "@/lib/server/session";
import { errorResponse, readJson, rejectCrossOrigin } from "@/lib/server/session-http";
import { getSessionDeps } from "@/lib/server/session-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  try {
    const deps = getSessionDeps();
    const body = await readJson(request);
    const session = await startSession(deps, { pathname: body.pathname, filename: body.filename }, request.signal);
    // Clean up anything a previous visit left behind, after responding.
    after(() => sweepStaleSessions(deps).then(() => {}, () => {}));
    return Response.json(session, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
