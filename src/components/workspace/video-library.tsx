"use client";

import { formatBytes, formatElapsed, formatTimestamp } from "@/lib/time";
import type { VideoSummary } from "@/types/video";

/** Short state line. TwelveLabs exposes states, not percentages, so we show state + elapsed time. */
export function statusDetail(video: VideoSummary, now: number): string {
  if (video.status === "indexing") {
    const since = Date.parse(video.indexingStartedAt ?? video.statusChangedAt ?? video.createdAt);
    const provider = video.providerStatus && video.providerStatus !== "indexing" ? ` · ${video.providerStatus}` : "";
    return `Indexing${provider} · ${formatElapsed(now - since)}`;
  }
  if (video.status === "uploading") {
    const since = Date.parse(video.statusChangedAt ?? video.createdAt);
    return `${video.providerStatus === "processing" ? "Processing at TwelveLabs" : "Sending to TwelveLabs"} · ${formatElapsed(now - since)}`;
  }
  if (video.status === "queued") {
    const waiting = video.nextAttemptAt && Date.parse(video.nextAttemptAt) > now;
    return waiting ? `Waiting to retry · ${formatElapsed(Date.parse(video.nextAttemptAt!) - now)}` : "Queued";
  }
  return video.status === "ready" ? "Ready" : "Failed";
}

export function isInProgress(video: VideoSummary) {
  return video.status === "queued" || video.status === "uploading" || video.status === "indexing";
}

export interface UploadingItem {
  name: string;
  loaded: number;
  total: number;
  abort: () => void;
}

export function VideoLibrary({ videos, selectedId, now, upload, onSelect, onRetry, onDelete, retrying }: {
  videos: VideoSummary[];
  selectedId: string | null;
  now: number;
  upload: UploadingItem | null;
  onSelect: (id: string) => void;
  onRetry: (id: string) => void;
  onDelete: (video: VideoSummary) => void;
  retrying: string | null;
}) {
  const percent = upload && upload.total > 0 ? Math.min(100, Math.floor((upload.loaded / upload.total) * 100)) : 0;
  return (
    <ol className="library" aria-label="Your videos">
      {upload && (
        <li className="library-item is-uploading" aria-live="polite">
          <span className="library-index">↑</span>
          <div className="library-body">
            <span className="library-name" title={upload.name}>{upload.name}</span>
            <div className="upload-line"><span style={{ transform: `scaleX(${percent / 100})` }} /></div>
            <span className="library-meta">
              {percent < 100 ? `${percent}% · ${formatBytes(upload.loaded)} of ${formatBytes(upload.total)}` : "Checking file…"}
            </span>
            {percent < 100 && <button className="link-button" onClick={upload.abort}>Cancel</button>}
          </div>
        </li>
      )}
      {videos.map((video, index) => {
        const selected = video.id === selectedId;
        const meta = [video.durationSeconds ? formatTimestamp(video.durationSeconds) : null, formatBytes(video.sizeBytes)].filter(Boolean).join(" · ");
        return (
          <li key={video.id} className={`library-item ${selected ? "is-selected" : ""}`}>
            <button className="library-select" onClick={() => onSelect(video.id)} aria-current={selected ? "true" : undefined}>
              <span className="library-index">{String(videos.length - index).padStart(2, "0")}</span>
              <span className="library-body">
                <span className="library-name" title={video.originalName}>{video.originalName}</span>
                <span className="library-meta">{meta}</span>
                {video.status !== "ready" && (
                  <span className={`library-status status-${video.status}`}>
                    {statusDetail(video, now)}
                  </span>
                )}
              </span>
            </button>
            {video.error && <p className={video.status === "failed" ? "library-note is-error" : "library-note"}>{video.error}</p>}
            <div className="library-actions">
              {video.status === "failed" && (
                <button className="link-button" onClick={() => onRetry(video.id)} disabled={retrying === video.id}>
                  {retrying === video.id ? "Retrying…" : "Retry"}
                </button>
              )}
              <button className="link-button is-quiet" onClick={() => onDelete(video)} aria-label={`Delete ${video.originalName}`}>Delete</button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
