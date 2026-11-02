import "server-only";
import { randomUUID } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Db } from "./db";
import { nowIso } from "./db";
import { ProviderError, type VideoProvider } from "./video-provider";
import { getVideo, updateVideo } from "./videos-repo";
import type { VideoRecord } from "@/types/video";

export const WORKER_LIMITS = {
  leaseMs: 2 * 60_000,
  heartbeatMs: 30_000,
  maxConsecutiveFailures: 6,
  maxBackoffMs: 10 * 60_000,
  assetProcessingTimeoutMs: 2 * 60 * 60_000,
  indexingTimeoutMs: 12 * 60 * 60_000,
  maxConcurrentJobs: 2,
} as const;

interface ClaimedJob {
  id: string;
  video_id: string;
  attempts: number;
}

type StepResult = { delayMs: number } | { done: true };

export interface WorkerDeps {
  db: Db;
  /** Null while no API key is configured; jobs then wait without consuming attempts. */
  getProvider: () => VideoProvider | null;
  videosDir: string;
  tmpDir?: string;
  now?: () => number;
  ownerId?: string;
}

export function pollDelayMs(elapsedMs: number) {
  if (elapsedMs < 2 * 60_000) return 5_000;
  if (elapsedMs < 10 * 60_000) return 10_000;
  return 30_000;
}

export function backoffMs(attempts: number, retryAfterSeconds?: number) {
  const exponential = Math.min(WORKER_LIMITS.maxBackoffMs, 5_000 * 2 ** Math.max(0, attempts - 1));
  return Math.max(exponential, (retryAfterSeconds ?? 0) * 1000);
}

export function createWorker(deps: WorkerDeps) {
  const { db, videosDir } = deps;
  const now = deps.now ?? Date.now;
  const owner = deps.ownerId ?? randomUUID();
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  const iso = (ms: number) => nowIso(new Date(ms));

  /** Atomically leases the next due job whose lease is free or expired. */
  function claim(): ClaimedJob | null {
    const at = iso(now());
    const row = db.prepare(
      `UPDATE indexing_jobs SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = (
         SELECT j.id FROM indexing_jobs j JOIN videos v ON v.id = j.video_id
         WHERE v.status IN ('queued', 'uploading', 'indexing')
           AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?)
           AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= ?)
         ORDER BY j.next_attempt_at LIMIT 1
       )
       RETURNING id, video_id, attempts`,
    ).get(owner, iso(now() + WORKER_LIMITS.leaseMs), at, at, at) as unknown as ClaimedJob | undefined;
    return row ?? null;
  }

  function renewLease(jobId: string) {
    db.prepare("UPDATE indexing_jobs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?").run(iso(now() + WORKER_LIMITS.leaseMs), jobId, owner);
  }

  function release(jobId: string, patch: { delayMs: number; attempts: number; lastError: string | null }) {
    db.prepare(
      "UPDATE indexing_jobs SET lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ? AND lease_owner = ?",
    ).run(iso(now() + patch.delayMs), patch.attempts, patch.lastError, iso(now()), jobId, owner);
  }

  function fail(video: VideoRecord, message: string) {
    updateVideo(db, video.id, { status: "failed", error: message });
  }

  async function step(video: VideoRecord, provider: VideoProvider, signal: AbortSignal, heartbeat: () => void): Promise<StepResult> {
    // 1. Send the file to TwelveLabs as an asset (skipped when a previous attempt already did).
    if (!video.providerAssetId) {
      const index = await provider.ensureIndex(signal);
      updateVideo(db, video.id, { status: "uploading", providerStatus: "sending", providerIndexId: index.id, error: null });
      const { assetId } = await provider.uploadAsset(
        { path: path.join(videosDir, video.storageName), sizeBytes: video.sizeBytes, filename: video.originalName, mimeType: video.mimeType ?? "video/mp4" },
        signal,
        heartbeat,
      );
      if (!updateVideo(db, video.id, { providerAssetId: assetId, providerStatus: "processing" })) {
        // The video was deleted while uploading; do not leave an orphaned provider copy.
        await provider.deleteAsset(assetId).catch(() => {});
        return { done: true };
      }
      return { delayMs: 2_000 };
    }

    // 2. Wait for the asset to be ready, then index it once.
    if (!video.providerTaskId) {
      const asset = await provider.getAsset(video.providerAssetId, signal);
      if (asset.status === "failed") {
        fail(video, asset.message);
        return { done: true };
      }
      if (asset.status === "processing") {
        updateVideo(db, video.id, { status: "uploading", providerStatus: "processing", error: null });
        const since = Date.parse(video.statusChangedAt ?? video.updatedAt);
        if (now() - since > WORKER_LIMITS.assetProcessingTimeoutMs) {
          fail(video, "TwelveLabs has not finished processing the upload after 2 hours. Retry to keep checking.");
          return { done: true };
        }
        return { delayMs: pollDelayMs(now() - since) };
      }
      const indexId = video.providerIndexId ?? (await provider.ensureIndex(signal)).id;
      // Reuse an indexed asset from an interrupted earlier attempt instead of indexing twice.
      const existing = await provider.findIndexedAssets(video.providerAssetId, indexId, signal);
      const indexedAssetId = existing[0] ?? (await provider.indexAsset(indexId, video.providerAssetId, signal)).indexedAssetId;
      updateVideo(db, video.id, {
        status: "indexing", providerIndexId: indexId, providerTaskId: indexedAssetId, providerStatus: "pending",
        indexingStartedAt: iso(now()), durationSeconds: asset.durationSeconds ?? video.durationSeconds, error: null,
      });
      return { delayMs: 5_000 };
    }

    // 3. Poll the indexed asset until TwelveLabs reports ready or failed.
    const indexId = video.providerIndexId;
    if (!indexId) {
      fail(video, "The provider index for this video is unknown. Delete and upload it again.");
      return { done: true };
    }
    const state = await provider.getIndexedAsset(indexId, video.providerTaskId, signal);
    if (state.status === "ready") {
      updateVideo(db, video.id, { status: "ready", providerVideoId: video.providerTaskId, providerStatus: "ready", durationSeconds: state.durationSeconds ?? video.durationSeconds, error: null });
      return { done: true };
    }
    if (state.status === "failed") {
      fail(video, state.message);
      return { done: true };
    }
    updateVideo(db, video.id, { status: "indexing", providerStatus: state.providerStatus, durationSeconds: state.durationSeconds ?? video.durationSeconds, error: null });
    const startedAt = Date.parse(video.indexingStartedAt ?? video.updatedAt);
    if (now() - startedAt > WORKER_LIMITS.indexingTimeoutMs) {
      fail(video, "TwelveLabs indexing has not finished after 12 hours. Retry to keep checking the same indexing job.");
      return { done: true };
    }
    return { delayMs: pollDelayMs(now() - startedAt) };
  }

  async function run(job: ClaimedJob, provider: VideoProvider, controller: AbortController) {
    const heartbeat = () => renewLease(job.id);
    const timer = setInterval(heartbeat, WORKER_LIMITS.heartbeatMs);
    try {
      const video = getVideo(db, job.video_id);
      if (!video) return;
      const result = await step(video, provider, controller.signal, heartbeat);
      release(job.id, { delayMs: "done" in result ? 0 : result.delayMs, attempts: 0, lastError: null });
    } catch (error) {
      if (controller.signal.aborted) {
        release(job.id, { delayMs: 0, attempts: job.attempts, lastError: null });
        return;
      }
      const video = getVideo(db, job.video_id);
      const message = error instanceof Error ? error.message : "Unknown error";
      const retryable = error instanceof ProviderError ? error.retryable : false;
      const attempts = job.attempts + 1;
      if (video && retryable && attempts < WORKER_LIMITS.maxConsecutiveFailures) {
        updateVideo(db, video.id, { error: `Temporary problem (attempt ${attempts} of ${WORKER_LIMITS.maxConsecutiveFailures}), will retry: ${message}` });
        release(job.id, { delayMs: backoffMs(attempts, error instanceof ProviderError ? error.retryAfterSeconds : undefined), attempts, lastError: message });
        return;
      }
      if (video) {
        fail(video, retryable ? `Stopped after ${attempts} failed attempts: ${message}` : message);
      }
      release(job.id, { delayMs: 0, attempts, lastError: message });
    } finally {
      clearInterval(timer);
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const provider = deps.getProvider();
      if (!provider) return;
      while (active.size < WORKER_LIMITS.maxConcurrentJobs) {
        const job = claim();
        if (!job) break;
        const controller = new AbortController();
        const done = run(job, provider, controller).finally(() => active.delete(job.video_id));
        active.set(job.video_id, { controller, done });
      }
    } finally {
      ticking = false;
    }
  }

  async function cleanTmp() {
    if (!deps.tmpDir) return;
    const entries = await readdir(deps.tmpDir).catch(() => [] as string[]);
    for (const name of entries) {
      if (!name.endsWith(".part")) continue;
      const file = path.join(deps.tmpDir, name);
      const info = await stat(file).catch(() => null);
      // Only remove leftovers from interrupted uploads, never one that may still be streaming.
      if (info && now() - info.mtimeMs > 6 * 60 * 60_000) await rm(file, { force: true });
    }
  }

  return {
    owner,
    tick,
    start(intervalMs = 2_000) {
      if (timer) return;
      void cleanTmp();
      timer = setInterval(() => void tick(), intervalMs);
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Stops in-process work for a video (used before deletion) and waits for it to settle. */
    async cancel(videoId: string) {
      const entry = active.get(videoId);
      if (!entry) return;
      entry.controller.abort();
      await entry.done;
    },
    /** Resolves when every in-flight job finishes (tests). */
    async idle() {
      await Promise.all([...active.values()].map((entry) => entry.done));
    },
  };
}

export type Worker = ReturnType<typeof createWorker>;
