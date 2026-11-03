import "server-only";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Db } from "./db";
import { dbSettings, nowIso } from "./db";
import { ServiceError } from "./errors";
import { searchIndexedVideo, validateQuery, type SearchMode, type SearchResponse } from "./search";
import { isNotFound, type VideoProvider } from "./video-provider";
import { deleteVideoRecord, getVideo, updateVideo } from "./videos-repo";
import type { DeleteVideoResult, DeletionOutcome } from "@/types/video";

export { ServiceError };
export { SEARCH_MODES, type SearchMode, type SearchResponse } from "./search";

export async function searchVideo(db: Db, provider: VideoProvider, videoId: string, rawQuery: string, signal?: AbortSignal, mode: SearchMode = "all"): Promise<SearchResponse> {
  const query = validateQuery(rawQuery);
  const video = getVideo(db, videoId);
  if (!video) throw new ServiceError("That video is no longer in the library.", 404);
  if (video.status !== "ready" || !video.providerVideoId || !video.providerIndexId) {
    throw new ServiceError("This video is not ready to search yet.", 409);
  }
  return searchIndexedVideo(provider, dbSettings(db), {
    indexId: video.providerIndexId, providerVideoId: video.providerVideoId, localVideoId: video.id, durationSeconds: video.durationSeconds, query, mode,
  }, signal);
}

/**
 * Makes a failed video eligible for the worker again, keeping provider resources
 * that can be reused (a ready asset) and removing ones that cannot (a failed indexed asset).
 */
export async function retryVideo(db: Db, provider: VideoProvider | null, videoId: string, clock: () => number = Date.now) {
  const video = getVideo(db, videoId);
  if (!video) throw new ServiceError("That video is no longer in the library.", 404);
  if (video.status !== "failed") throw new ServiceError("Only failed videos can be retried.", 409);
  if (!provider) throw new ServiceError("Add TWELVELABS_API_KEY to .env.local and restart the server first.", 503);

  let providerAssetId = video.providerAssetId;
  let providerTaskId = video.providerTaskId;
  if (providerAssetId) {
    const asset = await provider.getAsset(providerAssetId).catch((error) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (!asset || asset.status === "failed") {
      // The upload itself was unusable: remove it (with any indexed assets) and upload again.
      if (asset) await provider.deleteAsset(providerAssetId);
      providerAssetId = null;
      providerTaskId = null;
    } else if (providerTaskId && video.providerIndexId) {
      const state = await provider.getIndexedAsset(video.providerIndexId, providerTaskId).catch((error) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (!state || state.status === "failed") {
        if (state) await provider.deleteIndexedAsset(video.providerIndexId, providerTaskId);
        providerTaskId = null;
      }
      // An indexed asset that is still in progress (e.g. after the 12-hour timeout) is kept and
      // polled again, with a fresh timeout window below; nothing is uploaded or indexed twice.
    }
  }

  const now = nowIso(new Date(clock()));
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare(
      `UPDATE videos SET status = 'queued', error = NULL, provider_status = NULL, provider_asset_id = ?, provider_task_id = ?,
         indexing_first_started_at = CASE WHEN ? IS NULL THEN indexing_first_started_at ELSE COALESCE(indexing_first_started_at, indexing_started_at) END,
         indexing_started_at = CASE WHEN ? IS NULL THEN NULL ELSE ? END,
         updated_at = ?, status_changed_at = ? WHERE id = ?`,
    ).run(providerAssetId, providerTaskId, providerTaskId, providerTaskId, now, now, now, video.id);
    db.prepare(
      `INSERT INTO indexing_jobs(id, video_id, attempts, next_attempt_at, updated_at) VALUES (lower(hex(randomblob(16))), ?, 0, ?, ?)
       ON CONFLICT(video_id) DO UPDATE SET attempts = 0, next_attempt_at = excluded.next_attempt_at, last_error = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = excluded.updated_at`,
    ).run(video.id, now, now);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

/**
 * Deletes the TwelveLabs copy (when requested and one exists), then the local file and record.
 * When the provider deletion fails, nothing local is removed so the user can retry or
 * explicitly choose to delete only the local copy.
 */
export async function deleteVideo(db: Db, provider: VideoProvider | null, videoId: string, options: { includeProvider: boolean; videosDir: string }): Promise<DeleteVideoResult> {
  const video = getVideo(db, videoId);
  if (!video) throw new ServiceError("That video is no longer in the library.", 404);

  let providerOutcome: DeletionOutcome = "skipped";
  if (options.includeProvider && video.providerAssetId) {
    if (!provider) {
      return { local: "skipped", provider: "failed", recordRemoved: false, message: "TwelveLabs is not configured, so its copy could not be deleted. Nothing was removed." };
    }
    try {
      providerOutcome = await provider.deleteAsset(video.providerAssetId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      updateVideo(db, video.id, { error: `Deleting the TwelveLabs copy failed: ${reason}` });
      return { local: "skipped", provider: "failed", recordRemoved: false, message: `Could not delete the TwelveLabs copy (${reason}). Nothing was removed locally. Try again, or delete only the local copy.` };
    }
  } else if (options.includeProvider && video.providerTaskId && video.providerIndexId && provider) {
    // No asset ID recorded but an indexed asset exists: remove it directly.
    try {
      providerOutcome = await provider.deleteIndexedAsset(video.providerIndexId, video.providerTaskId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      return { local: "skipped", provider: "failed", recordRemoved: false, message: `Could not delete the TwelveLabs copy (${reason}). Nothing was removed locally.` };
    }
  }

  let localOutcome: DeletionOutcome = "deleted";
  try {
    await rm(path.join(options.videosDir, video.storageName));
  } catch (error) {
    localOutcome = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "failed";
  }
  if (localOutcome === "failed") {
    return { local: "failed", provider: providerOutcome, recordRemoved: false, message: "The local file could not be deleted (check file permissions). The library entry was kept." };
  }
  deleteVideoRecord(db, video.id);

  const providerText: Record<DeletionOutcome, string> = {
    deleted: "Deleted the TwelveLabs copy.",
    not_found: "TwelveLabs no longer had a copy.",
    skipped: video.providerAssetId ? "The TwelveLabs copy was kept." : "Nothing had been sent to TwelveLabs.",
    failed: "",
  };
  const localText = localOutcome === "deleted" ? "Deleted the local file." : "The local file was already missing.";
  return { local: localOutcome, provider: providerOutcome, recordRemoved: true, message: `${localText} ${providerText[providerOutcome]}` };
}
