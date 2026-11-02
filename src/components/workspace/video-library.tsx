"use client";

import { formatBytes, formatElapsed, formatTimestamp } from "@/lib/time";
import type { VideoSummary } from "@/types/video";

const statusLabel: Record<VideoSummary["status"], string> = {
  queued: "Queued",
  uploading: "Sending to TwelveLabs",
  indexing: "Indexing",
  ready: "Ready to search",
  failed: "Failed",
};

/** Elapsed time for in-progress states; TwelveLabs exposes states, not percentages. */
export function statusDetail(video: VideoSummary, now: number): string {
  if (video.status === "indexing") {
    const since = Date.parse(video.indexingStartedAt ?? video.statusChangedAt ?? video.createdAt);
    const provider = video.providerStatus && video.providerStatus !== "indexing" ? ` (${video.providerStatus})` : "";
    return `Indexing${provider} · ${formatElapsed(now - since)}`;
  }
  if (video.status === "uploading") {
    const since = Date.parse(video.statusChangedAt ?? video.createdAt);
    const phase = video.providerStatus === "processing" ? "TwelveLabs is processing the upload" : "Sending to TwelveLabs";
    return `${phase} · ${formatElapsed(now - since)}`;
  }
  if (video.status === "queued") {
    const waiting = video.nextAttemptAt && Date.parse(video.nextAttemptAt) > now;
    return waiting ? `Queued · next attempt in ${formatElapsed(Date.parse(video.nextAttemptAt!) - now)}` : "Queued for TwelveLabs";
  }
  return statusLabel[video.status];
}

export function isInProgress(video: VideoSummary) {
  return video.status === "queued" || video.status === "uploading" || video.status === "indexing";
}

export function VideoLibrary({ videos, selectedId, now, onSelect, onRetry, onDelete, retrying }: {
  videos: VideoSummary[];
  selectedId: string | null;
  now: number;
  onSelect: (id: string) => void;
  onRetry: (id: string) => void;
  onDelete: (video: VideoSummary) => void;
  retrying: string | null;
}) {
  if (!videos.length) {
    return <p className="sidebar-empty">Your library starts here.<br />Upload a video to index and search it.</p>;
  }
  return (
    <ul className="library-list" aria-label="Uploaded videos">
      {videos.map((video) => {
        const selected = video.id === selectedId;
        const meta = [formatBytes(video.sizeBytes), video.durationSeconds ? formatTimestamp(video.durationSeconds) : null].filter(Boolean).join(" · ");
        return (
          <li key={video.id} className={`library-item ${selected ? "is-selected" : ""} status-${video.status}`}>
            <button className="library-select" onClick={() => onSelect(video.id)} aria-current={selected ? "true" : undefined}>
              <span className="file-icon" aria-hidden="true">{video.status === "ready" ? "▶" : video.status === "failed" ? "!" : "◌"}</span>
              <span className="library-text">
                <strong title={video.originalName}>{video.originalName}</strong>
                <span>{meta}</span>
                <span className={`status-pill status-${video.status}`} aria-live="polite">
                  {isInProgress(video) && <span className="spinner" aria-hidden="true" />}
                  {statusDetail(video, now)}
                </span>
              </span>
            </button>
            {video.error && <p className={video.status === "failed" ? "library-error" : "library-warning"}>{video.error}</p>}
            <div className="library-actions">
              {video.status === "failed" && (
                <button className="text-button" onClick={() => onRetry(video.id)} disabled={retrying === video.id}>
                  {retrying === video.id ? "Retrying…" : "Retry indexing"}
                </button>
              )}
              <button className="text-button danger" onClick={() => onDelete(video)} aria-label={`Delete ${video.originalName}`}>Delete</button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
