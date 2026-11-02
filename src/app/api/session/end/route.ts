import { endSession } from "@/lib/server/session";
import { errorResponse, readJson, rejectCrossOrigin } from "@/lib/server/session-http";
import { getSessionDeps } from "@/lib/server/session-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Called with navigator.sendBeacon when the page is left, and by "New video". */
export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  try {
    const body = await readJson(request);
    const result = await endSession(getSessionDeps(), { assetId: body.assetId, pathname: body.pathname });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
