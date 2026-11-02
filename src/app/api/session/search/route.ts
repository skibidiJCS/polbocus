import { ServiceError } from "@/lib/server/errors";
import { SEARCH_MODES, searchIndexedVideo, validateQuery, type SearchMode } from "@/lib/server/search";
import { assertProviderId } from "@/lib/server/session";
import { errorResponse, readJson, rejectCrossOrigin } from "@/lib/server/session-http";
import { getSessionDeps, sessionSettings } from "@/lib/server/session-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  try {
    const body = await readJson(request);
    const mode = (body.mode ?? "all") as SearchMode;
    if (!SEARCH_MODES.includes(mode)) throw new ServiceError("mode must be all, visual, or speech.", 400);
    const indexId = assertProviderId(body.indexId, "index");
    const videoId = assertProviderId(body.videoId, "video");
    const duration = typeof body.durationSeconds === "number" && Number.isFinite(body.durationSeconds) && body.durationSeconds > 0 ? body.durationSeconds : null;
    const result = await searchIndexedVideo(getSessionDeps().provider, sessionSettings, {
      indexId, providerVideoId: videoId, localVideoId: videoId, durationSeconds: duration, query: validateQuery(String(body.query ?? "")), mode,
    }, request.signal);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
