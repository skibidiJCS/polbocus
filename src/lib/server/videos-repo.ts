import "server-only";
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import { nowIso } from "./db";
import type { VideoRecord, VideoStatus, VideoSummary } from "@/types/video";

interface VideoRow {
  id: string;
  original_name: string;
  storage_name: string;
  sha256: string;
  size_bytes: number;
  duration_seconds: number | null;
  status: VideoStatus;
  provider_video_id: string | null;
  provider_task_id: string | null;
  provider_asset_id: string | null;
  provider_index_id: string | null;
  provider_status: string | null;
  mime_type: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  status_changed_at: string | null;
  indexing_started_at: string | null;
  next_attempt_at?: string | null;
}

function toRecord(row: VideoRow): VideoRecord {
  return {
    id: row.id,
    originalName: row.original_name,
    storageName: row.storage_name,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    status: row.status,
    providerVideoId: row.provider_video_id,
    providerTaskId: row.provider_task_id,
    providerAssetId: row.provider_asset_id,
    providerIndexId: row.provider_index_id,
    providerStatus: row.provider_status,
    mimeType: row.mime_type,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statusChangedAt: row.status_changed_at,
    indexingStartedAt: row.indexing_started_at,
  };
}

export function toSummary(video: VideoRecord, nextAttemptAt: string | null = null): VideoSummary {
  return {
    id: video.id,
    originalName: video.originalName,
    sizeBytes: video.sizeBytes,
    durationSeconds: video.durationSeconds,
    status: video.status,
    providerStatus: video.providerStatus,
    mimeType: video.mimeType,
    error: video.error,
    hasProviderCopy: Boolean(video.providerAssetId),
    createdAt: video.createdAt,
    statusChangedAt: video.statusChangedAt,
    indexingStartedAt: video.indexingStartedAt,
    nextAttemptAt,
  };
}

export function listVideoSummaries(db: Db): VideoSummary[] {
  const rows = db.prepare(
    "SELECT v.*, j.next_attempt_at FROM videos v LEFT JOIN indexing_jobs j ON j.video_id = v.id ORDER BY v.created_at DESC",
  ).all() as unknown as VideoRow[];
  return rows.map((row) => toSummary(toRecord(row), row.next_attempt_at ?? null));
}

export function getVideo(db: Db, id: string): VideoRecord | null {
  const row = db.prepare("SELECT * FROM videos WHERE id = ?").get(id) as unknown as VideoRow | undefined;
  return row ? toRecord(row) : null;
}

export function getVideoSummary(db: Db, id: string): VideoSummary | null {
  const row = db.prepare(
    "SELECT v.*, j.next_attempt_at FROM videos v LEFT JOIN indexing_jobs j ON j.video_id = v.id WHERE v.id = ?",
  ).get(id) as unknown as VideoRow | undefined;
  return row ? toSummary(toRecord(row), row.next_attempt_at ?? null) : null;
}

export function findVideoBySha256(db: Db, sha256: string): VideoRecord | null {
  const row = db.prepare("SELECT * FROM videos WHERE sha256 = ?").get(sha256) as unknown as VideoRow | undefined;
  return row ? toRecord(row) : null;
}

/** Inserts the video and its indexing job atomically. */
export function insertQueuedVideo(db: Db, input: { id: string; originalName: string; storageName: string; sha256: string; sizeBytes: number; mimeType: string }): VideoRecord {
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare(
      `INSERT INTO videos(id, original_name, storage_name, sha256, size_bytes, status, mime_type, created_at, updated_at, status_changed_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    ).run(input.id, input.originalName, input.storageName, input.sha256, input.sizeBytes, input.mimeType, now, now, now);
    db.prepare("INSERT INTO indexing_jobs(id, video_id, attempts, next_attempt_at, updated_at) VALUES (?, ?, 0, ?, ?)").run(randomUUID(), input.id, now, now);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  return getVideo(db, input.id)!;
}

type VideoPatch = Partial<Pick<VideoRecord,
  "status" | "providerVideoId" | "providerTaskId" | "providerAssetId" | "providerIndexId" | "providerStatus" | "error" | "durationSeconds" | "indexingStartedAt">>;

const columns: Record<keyof VideoPatch, string> = {
  status: "status",
  providerVideoId: "provider_video_id",
  providerTaskId: "provider_task_id",
  providerAssetId: "provider_asset_id",
  providerIndexId: "provider_index_id",
  providerStatus: "provider_status",
  error: "error",
  durationSeconds: "duration_seconds",
  indexingStartedAt: "indexing_started_at",
};

/** Returns false when the video no longer exists (for example, deleted mid-job). */
export function updateVideo(db: Db, id: string, patch: VideoPatch): boolean {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof VideoPatch, unknown][];
  const now = nowIso();
  const sets = entries.map(([key]) => `${columns[key]} = ?`);
  const values = entries.map(([, value]) => value as string | number | null);
  sets.push("updated_at = ?");
  values.push(now);
  if (patch.status) {
    // Only reset the elapsed-time clock when the status actually changes.
    sets.push("status_changed_at = CASE WHEN status = ? THEN status_changed_at ELSE ? END");
    values.push(patch.status, now);
  }
  const result = db.prepare(`UPDATE videos SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  return Number(result.changes) > 0;
}

export function deleteVideoRecord(db: Db, id: string) {
  db.prepare("DELETE FROM videos WHERE id = ?").run(id);
}
