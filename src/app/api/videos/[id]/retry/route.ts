import { getDb } from "@/lib/server/db";
import { errorResponse, noStore, rejectNonLocal } from "@/lib/server/http";
import { getProvider, getWorker } from "@/lib/server/runtime";
import { retryVideo } from "@/lib/server/video-service";
import { getVideoSummary } from "@/lib/server/videos-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: RouteContext<"/api/videos/[id]/retry">) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const { id } = await ctx.params;
  try {
    const db = getDb();
    await retryVideo(db, getProvider(), id);
    void getWorker().tick();
    return Response.json({ video: getVideoSummary(db, id) }, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
