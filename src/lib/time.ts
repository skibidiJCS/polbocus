/** "02:14" or "1:02:14". Display only: floors to whole seconds; stored values keep full precision. */
export function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatRange(start: number, end: number): string {
  return `${formatTimestamp(start)}–${formatTimestamp(end)}`;
}

/** Validates a seek target against the media duration (when known). */
export function clampSeek(seconds: number, duration: number | null | undefined): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  if (duration && Number.isFinite(duration) && duration > 0) return Math.min(seconds, Math.max(0, duration - 0.05));
  return seconds;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
