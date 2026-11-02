import { getDb } from "@/lib/server/db";
import { errorResponse, noStore, rejectNonLocal } from "@/lib/server/http";
import { getProvider } from "@/lib/server/runtime";
import { ProviderNotConfiguredError } from "@/lib/server/video-provider";
import { SEARCH_MODES, searchVideo, ServiceError, type SearchMode } from "@/lib/server/video-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Searches are billable; never retried automatically. One in flight per video.
const inFlight = new Set<string>();

export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  let videoId = "";
  try {
    const body = (await request.json().catch(() => null)) as { videoId?: unknown; query?: unknown; mode?: unknown } | null;
    if (!body || typeof body.videoId !== "string" || typeof body.query !== "string") {
      throw new ServiceError("Send a JSON body with videoId and query.", 400);
    }
    const mode = body.mode ?? "all";
    if (!SEARCH_MODES.includes(mode as SearchMode)) throw new ServiceError("mode must be all, visual, or speech.", 400);
    videoId = body.videoId;
    const provider = getProvider();
    if (!provider) throw new ProviderNotConfiguredError();
    if (inFlight.has(videoId)) throw new ServiceError("A search for this video is already running.", 409);
    inFlight.add(videoId);
    try {
      const result = await searchVideo(getDb(), provider, videoId, body.query, request.signal, mode as SearchMode);
      return Response.json(result, { headers: noStore });
    } finally {
      inFlight.delete(videoId);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
