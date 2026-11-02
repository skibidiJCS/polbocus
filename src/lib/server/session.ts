import "server-only";
import type { BlobStore } from "./blob-store";
import { ServiceError } from "./errors";
import { ACCEPTED_FORMATS_LABEL, detectContainer } from "./media";
import { isNotFound, type VideoProvider } from "./video-provider";

/**
 * One-time sessions (hosted mode). Nothing is stored by the app: the browser keeps the
 * IDs, TwelveLabs keeps the index entry until the page is left, and the uploaded file
 * only passes through a private Vercel Blob store until TwelveLabs has fetched it.
 */
export const BLOB_PREFIX = "sessions/";
// TwelveLabs asset filenames carry this tag so leftovers can be found and removed.
export const ASSET_TAG = "footage-session--";
export const SESSION_MAX_BYTES = 4_000_000_000;
export const STALE_AFTER_MS = 6 * 60 * 60_000;
const FETCH_URL_LIFETIME_MS = 2 * 60 * 60_000;

const PROVIDER_ID = /^[a-f0-9]{24}$/;
const BLOB_PATH = /^sessions\/[0-9a-f-]{36}(-[A-Za-z0-9]+)?\.(mp4|mov|m4v|webm|mkv)$/;
export const ALLOWED_UPLOAD_TYPES = ["video/mp4", "video/quicktime", "video/x-m4v", "video/webm", "video/x-matroska"];

export function assertProviderId(value: unknown, label: string): string {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) throw new ServiceError(`Invalid ${label}.`, 400);
  return value;
}

export function isSessionBlobPath(value: unknown): value is string {
  return typeof value === "string" && BLOB_PATH.test(value);
}

function taggedFilename(original: string) {
  const clean = original.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, 160) || "video";
  return ASSET_TAG + clean;
}

export interface SessionDeps {
  provider: VideoProvider;
  blob: BlobStore;
  now?: () => number;
}

/** Validates the uploaded blob and asks TwelveLabs to fetch it. */
export async function startSession(deps: SessionDeps, input: { pathname: unknown; filename: unknown }, signal?: AbortSignal) {
  if (!isSessionBlobPath(input.pathname)) throw new ServiceError("Unknown upload.", 400);
  const pathname = input.pathname;
  const filename = typeof input.filename === "string" ? input.filename : "video";
  const now = deps.now ?? Date.now;

  // Look up the index while the upload is checked; the two don't depend on each other.
  const indexLookup = deps.provider.ensureIndex(signal);
  indexLookup.catch(() => {});
  const info = await deps.blob.head(pathname);
  if (!info) throw new ServiceError("The upload could not be found. Try again.", 404);
  if (info.size > SESSION_MAX_BYTES) {
    await deps.blob.remove([pathname]);
    throw new ServiceError("Videos can be up to 4 GB.", 413);
  }
  // Trust the bytes, not the name or browser-reported type.
  if (!detectContainer(await deps.blob.readStart(pathname, 64))) {
    await deps.blob.remove([pathname]);
    throw new ServiceError(`That file isn’t a supported video. Use ${ACCEPTED_FORMATS_LABEL}.`, 415);
  }

  const index = await indexLookup;
  const url = await deps.blob.presignGet(pathname, now() + FETCH_URL_LIFETIME_MS);
  const { assetId } = await deps.provider.createAssetFromUrl(url, taggedFilename(filename), signal);
  return { assetId, indexId: index.id, sizeBytes: info.size };
}

export type SessionStatus =
  | { stage: "processing" }
  | { stage: "indexing"; indexedAssetId: string; providerStatus: string; durationSeconds: number | null }
  | { stage: "ready"; indexedAssetId: string; durationSeconds: number | null }
  | { stage: "failed"; message: string };

/**
 * Moves a session one step forward. The browser calls this while the page is open;
 * TwelveLabs does the actual work, so no background process is needed.
 */
export async function advanceSession(
  deps: SessionDeps,
  input: { assetId: unknown; indexId: unknown; indexedAssetId?: unknown; pathname?: unknown },
  signal?: AbortSignal,
): Promise<SessionStatus> {
  const assetId = assertProviderId(input.assetId, "asset");
  const indexId = assertProviderId(input.indexId, "index");
  const pathname = isSessionBlobPath(input.pathname) ? input.pathname : null;

  if (input.indexedAssetId) {
    const indexedAssetId = assertProviderId(input.indexedAssetId, "video");
    const state = await deps.provider.getIndexedAsset(indexId, indexedAssetId, signal);
    if (state.status === "ready") return { stage: "ready", indexedAssetId, durationSeconds: state.durationSeconds };
    if (state.status === "failed") return { stage: "failed", message: state.message };
    return { stage: "indexing", indexedAssetId, providerStatus: state.providerStatus, durationSeconds: state.durationSeconds };
  }

  const asset = await deps.provider.getAsset(assetId, signal);
  if (asset.status === "processing") return { stage: "processing" };
  // TwelveLabs has its own copy (or gave up): the temporary upload is no longer needed.
  if (pathname) await deps.blob.remove([pathname]).catch(() => {});
  if (asset.status === "failed") return { stage: "failed", message: asset.message };
  // Reuse an indexed asset if an earlier call created one but its response was lost.
  const existing = await deps.provider.findIndexedAssets(assetId, indexId, signal);
  const indexedAssetId = existing[0] ?? (await deps.provider.indexAsset(indexId, assetId, signal)).indexedAssetId;
  return { stage: "indexing", indexedAssetId, providerStatus: "pending", durationSeconds: asset.durationSeconds };
}

/** Deletes everything belonging to a session. Safe to call more than once. */
export async function endSession(deps: SessionDeps, input: { assetId?: unknown; pathname?: unknown }) {
  const result = { provider: "skipped" as "deleted" | "not_found" | "failed" | "skipped", upload: "skipped" as "deleted" | "failed" | "skipped" };
  if (isSessionBlobPath(input.pathname)) {
    result.upload = await deps.blob.remove([input.pathname]).then(() => "deleted" as const, () => "failed" as const);
  }
  if (typeof input.assetId === "string" && PROVIDER_ID.test(input.assetId)) {
    try {
      // force=true also removes the indexed asset that references it.
      result.provider = await deps.provider.deleteAsset(input.assetId);
    } catch (error) {
      result.provider = isNotFound(error) ? "not_found" : "failed";
    }
  }
  return result;
}

/**
 * Safety net for sessions whose "page left" signal never arrived: removes this app's
 * tagged TwelveLabs assets and leftover uploads older than six hours. Never touches
 * assets without the tag.
 */
export async function sweepStaleSessions(deps: SessionDeps) {
  const now = (deps.now ?? Date.now)();
  const removed = { assets: 0, uploads: 0 };
  const assets = await deps.provider.listAssets().catch(() => []);
  for (const asset of assets) {
    const created = asset.createdAt ? Date.parse(asset.createdAt) : NaN;
    if (asset.filename?.startsWith(ASSET_TAG) && Number.isFinite(created) && now - created > STALE_AFTER_MS) {
      const outcome = await deps.provider.deleteAsset(asset.id).catch(() => "failed");
      if (outcome === "deleted") removed.assets++;
    }
  }
  if (deps.blob.configured()) {
    const stale = (await deps.blob.list(BLOB_PREFIX).catch(() => [])).filter((blob) => now - blob.uploadedAt.getTime() > STALE_AFTER_MS);
    if (stale.length) {
      await deps.blob.remove(stale.map((blob) => blob.pathname)).then(() => { removed.uploads = stale.length; }, () => {});
    }
  }
  return removed;
}
