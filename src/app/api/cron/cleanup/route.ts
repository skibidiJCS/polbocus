import { isSessionMode } from "@/lib/auth";
import { isAuthorizedCron } from "@/lib/server/cron-auth";
import { processDueSessions, sweepListings } from "@/lib/server/session";
import { errorResponse } from "@/lib/server/session-http";
import { getSessionDeps } from "@/lib/server/session-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduled cleanup (vercel.json → crons). Ends abandoned sessions, retries failed
 * deletions, then sweeps a bounded number of listing pages, resuming where the last run
 * stopped. Requires CRON_SECRET; the proxy lets it through without a session cookie.
 */
export async function GET(request: Request) {
  if (!isSessionMode()) return Response.json({ error: "Not found." }, { status: 404 });
  if (!isAuthorizedCron(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const deps = getSessionDeps();
    const sessions = await processDueSessions(deps, 100);
    const sweep = await sweepListings(deps);
    const prunedCounters = (await deps.store.prune?.().catch(() => 0)) ?? 0;
    const summary = { sessions, sweep, prunedCounters };
    console.info("[session-cleanup] Scheduled run", JSON.stringify(summary));
    const failed = sessions.failed + sweep.assets.failed + sweep.uploads.failed;
    return Response.json(summary, { status: failed ? 207 : 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[session-cleanup] Scheduled run failed", error instanceof Error ? error.message : error);
    return errorResponse(error);
  }
}
