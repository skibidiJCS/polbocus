import { after } from "next/server";
import { startSession, sweepStaleSessions } from "@/lib/server/session";
import { errorResponse, readJson, rejectCrossOrigin } from "@/lib/server/session-http";
import { getSessionDeps } from "@/lib/server/session-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The sweep lists every asset; once per half hour per instance is plenty for a safety net.
const SWEEP_EVERY_MS = 30 * 60_000;
let lastSweep = 0;

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  try {
    const deps = getSessionDeps();
    const body = await readJson(request);
    const session = await startSession(deps, { pathname: body.pathname, filename: body.filename }, request.signal);
    // Clean up anything a previous visit left behind, after responding.
    if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
      lastSweep = Date.now();
      after(() => sweepStaleSessions(deps).then(() => {}, () => {}));
    }
    return Response.json(session, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
