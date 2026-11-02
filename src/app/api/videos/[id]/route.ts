import { getServerConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { errorResponse, noStore, rejectNonLocal } from "@/lib/server/http";
import { getProvider, getWorker } from "@/lib/server/runtime";
import { deleteVideo } from "@/lib/server/video-service";
import { getVideoSummary } from "@/lib/server/videos-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/api/videos/[id]">) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const { id } = await ctx.params;
  const video = getVideoSummary(getDb(), id);
  if (!video) return Response.json({ error: "Video not found." }, { status: 404, headers: noStore });
  return Response.json({ video }, { headers: noStore });
}

/** ?provider=false deletes only the local copy and record; the default also deletes the TwelveLabs copy. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/videos/[id]">) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const { id } = await ctx.params;
  try {
    const includeProvider = new URL(request.url).searchParams.get("provider") !== "false";
    // Stop any in-flight upload/poll for this video before removing its resources.
    await getWorker().cancel(id);
    const result = await deleteVideo(getDb(), getProvider(), id, { includeProvider, videosDir: getServerConfig().videosDir });
    return Response.json(result, { status: result.recordRemoved ? 200 : 502, headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
