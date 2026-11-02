import "server-only";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Db } from "./db";
import { getSetting, nowIso, setSetting } from "./db";
import { isNotFound, ProviderError, type SearchOption, type VideoProvider } from "./video-provider";
import { deleteVideoRecord, getVideo, updateVideo } from "./videos-repo";
import { normalizeSegments } from "@/lib/segments";
import type { DeleteVideoResult, DeletionOutcome, SearchSegment } from "@/types/video";

export class ServiceError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

export const MAX_QUERY_LENGTH = 500;
export const SEARCH_PAGE_LIMIT = 20;

const noTranscriptionKey = (indexId: string) => `twelvelabs.no_transcription.${indexId}`;

/**
 * Which TwelveLabs search options to use. "all" combines every option the index supports
 * (operator=or); live testing showed visual matches then outrank speech, so users can
 * restrict a search to what is seen or to what is said.
 */
export type SearchMode = "all" | "visual" | "speech";
export const SEARCH_MODES: SearchMode[] = ["all", "visual", "speech"];

export interface SearchResponse {
  segments: SearchSegment[];
  searchOptions: SearchOption[];
  notes: string[];
}

export async function searchVideo(db: Db, provider: VideoProvider, videoId: string, rawQuery: string, signal?: AbortSignal, mode: SearchMode = "all"): Promise<SearchResponse> {
  const query = rawQuery.trim();
  if (!query) throw new ServiceError("Describe the moment you are looking for.", 400);
  if (query.length > MAX_QUERY_LENGTH) throw new ServiceError(`Keep the description under ${MAX_QUERY_LENGTH} characters.`, 400);
  const video = getVideo(db, videoId);
  if (!video) throw new ServiceError("That video is no longer in the library.", 404);
  if (video.status !== "ready" || !video.providerVideoId || !video.providerIndexId) {
    throw new ServiceError("This video is not ready to search yet.", 409);
  }

  const index = await provider.getIndex(video.providerIndexId, signal);
  const supported = index.searchOptions.filter((option) => !(option === "transcription" && getSetting(db, noTranscriptionKey(index.id))));
  let options = mode === "visual" ? supported.filter((o) => o === "visual") : mode === "speech" ? supported.filter((o) => o === "transcription") : supported;
  if (!options.length) {
    throw new ServiceError(mode === "speech" ? "This video's index does not support spoken-word search. Search everything or visuals instead." : "This index does not support that kind of search.", 400);
  }
  const notes: string[] = [];
  const run = (searchOptions: SearchOption[]) =>
    provider.search({ indexId: index.id, providerVideoId: video.providerVideoId!, query, searchOptions, pageLimit: SEARCH_PAGE_LIMIT }, signal);

  let items;
  try {
    items = await run(options);
  } catch (error) {
    // One fallback, never a loop: drop transcription if this index rejects it.
    const rejected = error instanceof ProviderError && (error.code === "search_option_not_supported" || error.code === "search_option_combination_not_supported");
    if (!rejected || !options.includes("transcription")) throw error;
    if (mode === "speech") {
      setSetting(db, noTranscriptionKey(index.id), nowIso());
      throw new ServiceError("This video's index does not support spoken-word search. Search everything or visuals instead.", 400);
    }
    setSetting(db, noTranscriptionKey(index.id), nowIso());
    options = options.filter((option) => option !== "transcription");
    notes.push("This index does not support spoken-word (transcription) search, so only visual and audio search were used.");
    items = await run(options);
  }

  const result = normalizeSegments(items, { providerVideoId: video.providerVideoId, localVideoId: video.id, durationSeconds: video.durationSeconds });
  if (result.droppedOtherVideo > 0) {
    notes.push(`${result.droppedOtherVideo} result(s) from other videos in the index were hidden.`);
  }
  if (result.droppedInvalid > 0) {
    notes.push(`${result.droppedInvalid} result(s) had timestamps outside this video and were hidden.`);
  }
  return { segments: result.segments, searchOptions: options, notes };
}

/**
 * Makes a failed video eligible for the worker again, keeping provider resources
 * that can be reused (a ready asset) and removing ones that cannot (a failed indexed asset).
 */
export async function retryVideo(db: Db, provider: VideoProvider | null, videoId: string) {
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
      // An indexed asset that is still in progress (e.g. after the 12-hour timeout) is kept and polled again.
    }
  }

  const now = nowIso();
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare(
      `UPDATE videos SET status = 'queued', error = NULL, provider_status = NULL, provider_asset_id = ?, provider_task_id = ?,
         indexing_started_at = CASE WHEN ? IS NULL THEN NULL ELSE indexing_started_at END,
         updated_at = ?, status_changed_at = ? WHERE id = ?`,
    ).run(providerAssetId, providerTaskId, providerTaskId, now, now, video.id);
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
