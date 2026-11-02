import { getServerConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { errorResponse, noStore, rejectNonLocal } from "@/lib/server/http";
import { sanitizeOriginalName } from "@/lib/server/media";
import { getProvider, getWorker } from "@/lib/server/runtime";
import { receiveToTempFile, storeReceivedFile, UploadError } from "@/lib/server/upload";
import { getVideoSummary, listVideoSummaries } from "@/lib/server/videos-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  getWorker();
  return Response.json({ videos: listVideoSummaries(getDb()) }, { headers: noStore });
}

/**
 * Raw-body streamed upload. The browser sends the file bytes as the request body
 * and the original name (URI-encoded) in X-File-Name; neither the name nor the
 * client MIME type is trusted.
 */
export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    if (!getProvider()) throw new UploadError("Add TWELVELABS_API_KEY to .env.local and restart the server before uploading.", 503);
    const config = getServerConfig();
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > config.maxUploadBytes) {
      throw new UploadError(`File exceeds the ${(config.maxUploadBytes / 1e9).toFixed(1)} GB limit.`, 413);
    }
    if (!request.body) throw new UploadError("No file was received.", 400);
    const received = await receiveToTempFile(request.body, { tmpDir: config.tmpDir, maxBytes: config.maxUploadBytes, signal: request.signal });
    const db = getDb();
    const { video, duplicate } = await storeReceivedFile(db, received, sanitizeOriginalName(request.headers.get("x-file-name")), config.videosDir);
    const worker = getWorker();
    if (!duplicate) void worker.tick();
    return Response.json({ video: getVideoSummary(db, video.id), duplicate }, { status: duplicate ? 200 : 201, headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
