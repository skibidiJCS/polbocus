export type VideoStatus = "uploading" | "queued" | "indexing" | "ready" | "failed";

/** Server-side row. Never send storageName or provider IDs to the browser. */
export interface VideoRecord {
  id: string;
  originalName: string;
  storageName: string;
  sha256: string;
  sizeBytes: number;
  durationSeconds: number | null;
  status: VideoStatus;
  providerVideoId: string | null;
  // Indexed-asset ID polled while TwelveLabs indexes the video.
  providerTaskId: string | null;
  providerAssetId: string | null;
  providerIndexId: string | null;
  // Raw provider state (e.g. "validating", "pending", "indexing"); shown as-is, never as a percentage.
  providerStatus: string | null;
  mimeType: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string | null;
  indexingStartedAt: string | null;
}

/** What the browser receives about a video. */
export interface VideoSummary {
  id: string;
  originalName: string;
  sizeBytes: number;
  durationSeconds: number | null;
  status: VideoStatus;
  providerStatus: string | null;
  mimeType: string | null;
  error: string | null;
  hasProviderCopy: boolean;
  createdAt: string;
  statusChangedAt: string | null;
  indexingStartedAt: string | null;
  nextAttemptAt: string | null;
}

export interface SearchSegment {
  videoId: string;
  startSeconds: number;
  endSeconds: number;
  // Provider relevance rank (1 = most relevant). Never a probability of correctness.
  rank?: number;
  // Expires one hour after the search, per TwelveLabs.
  thumbnailUrl?: string;
  // Spoken words the provider returned for this segment, when it returned any.
  transcription?: string;
}

export type DeletionOutcome = "deleted" | "not_found" | "failed" | "skipped";

export interface DeleteVideoResult {
  local: DeletionOutcome;
  provider: DeletionOutcome;
  recordRemoved: boolean;
  message: string;
}
