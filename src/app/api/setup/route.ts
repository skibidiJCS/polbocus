import { getServerConfig } from "@/lib/server/config";
import { getDb, getSetting } from "@/lib/server/db";
import { errorResponse, noStore, rejectNonLocal } from "@/lib/server/http";
import { getProvider } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness report. Never returns secrets. With ?check=1 it makes one
 * non-billable GET to TwelveLabs to validate the key and index.
 */
export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const config = getServerConfig();
  const storedIndexId = getSetting(getDb(), "twelvelabs.index_id");
  const indexId = config.indexId ?? storedIndexId;
  const base = {
    stage: "prototype",
    apiKeyConfigured: Boolean(config.apiKey),
    indexSource: config.indexId ? "env" : storedIndexId ? "stored-by-app" : "chosen-on-first-upload",
    maxUploadBytes: config.maxUploadBytes,
    capabilities: { upload: Boolean(config.apiKey), indexing: Boolean(config.apiKey), search: Boolean(config.apiKey) },
  };
  if (new URL(request.url).searchParams.get("check") !== "1") {
    return Response.json({ ...base, providerConnected: null }, { headers: noStore });
  }
  const provider = getProvider();
  if (!provider || !indexId) {
    return Response.json({ ...base, providerConnected: null, note: provider ? "No index yet; it is created on the first upload." : "No API key configured." }, { headers: noStore });
  }
  try {
    const index = await provider.getIndex(indexId);
    return Response.json({ ...base, providerConnected: true, searchOptions: index.searchOptions }, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
