import { advanceSession } from "@/lib/server/session";
import { errorResponse, readJson, rejectCrossOrigin } from "@/lib/server/session-http";
import { getSessionDeps } from "@/lib/server/session-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  try {
    const body = await readJson(request);
    const status = await advanceSession(getSessionDeps(), { assetId: body.assetId, indexId: body.indexId, indexedAssetId: body.indexedAssetId, pathname: body.pathname }, request.signal);
    return Response.json(status, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
