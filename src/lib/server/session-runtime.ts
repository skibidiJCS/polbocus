import "server-only";
import { vercelBlobStore } from "./blob-store";
import { ServiceError } from "./errors";
import { createTwelveLabsProvider } from "./twelvelabs";
import { memorySettings, type VideoProvider } from "./video-provider";
import type { SessionDeps } from "./session";

// Hosted mode keeps no database: index choice and option support are re-derived per instance.
let cached: { key: string; provider: VideoProvider } | null = null;
const settings = memorySettings();

export function getSessionDeps(): SessionDeps {
  const apiKey = process.env.TWELVELABS_API_KEY?.trim();
  if (!apiKey) throw new ServiceError("TWELVELABS_API_KEY is not set in this deployment.", 503);
  const indexId = process.env.TWELVELABS_INDEX_ID?.trim() || null;
  const key = `${apiKey.length}:${apiKey.slice(-4)}:${indexId ?? ""}`;
  if (cached?.key !== key) cached = { key, provider: createTwelveLabsProvider({ apiKey, settings, configuredIndexId: indexId }) };
  const blob = vercelBlobStore();
  if (!blob.configured()) throw new ServiceError("Vercel Blob is not connected to this project (BLOB_READ_WRITE_TOKEN is missing).", 503);
  return { provider: cached.provider, blob };
}

export { settings as sessionSettings };
