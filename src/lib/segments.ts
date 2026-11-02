import type { SearchSegment } from "@/types/video";

export interface RawSegment {
  videoId: string | null;
  start: unknown;
  end: unknown;
  rank: unknown;
  thumbnailUrl: string | null;
  transcription: string | null;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Share of the shorter segment covered by the overlap of a and b. */
function overlapRatio(a: SearchSegment, b: SearchSegment) {
  const overlap = Math.min(a.endSeconds, b.endSeconds) - Math.max(a.startSeconds, b.startSeconds);
  if (overlap <= 0) return 0;
  const shorter = Math.min(a.endSeconds - a.startSeconds, b.endSeconds - b.startSeconds);
  return shorter > 0 ? overlap / shorter : 1;
}

/**
 * Converts provider items into segments for one local video.
 * - Drops anything for a different provider video (defence in depth on top of the search filter).
 * - Keeps the provider's timestamp precision; only clamps to a known duration.
 * - Removes exact duplicates and segments mostly covered by a better-ranked one.
 */
export function normalizeSegments(items: RawSegment[], options: { providerVideoId: string; localVideoId: string; durationSeconds: number | null }) {
  let otherVideo = 0;
  let invalid = 0;
  const candidates: SearchSegment[] = [];
  items.forEach((item) => {
    if (item.videoId !== null && item.videoId !== options.providerVideoId) {
      otherVideo++;
      return;
    }
    if (!finite(item.start) || !finite(item.end) || item.start < 0 || item.end <= item.start) {
      invalid++;
      return;
    }
    let end = item.end;
    const duration = options.durationSeconds;
    if (duration !== null && duration > 0) {
      if (item.start >= duration) {
        invalid++;
        return;
      }
      end = Math.min(end, duration);
    }
    candidates.push({
      videoId: options.localVideoId,
      startSeconds: item.start,
      endSeconds: end,
      ...(finite(item.rank) ? { rank: item.rank } : {}),
      ...(item.thumbnailUrl ? { thumbnailUrl: item.thumbnailUrl } : {}),
      ...(item.transcription ? { transcription: item.transcription } : {}),
    });
  });

  // Stable sort: ranked results first by rank, unranked keep provider order.
  const ordered = candidates
    .map((segment, order) => ({ segment, order }))
    .sort((a, b) => (a.segment.rank ?? Infinity) - (b.segment.rank ?? Infinity) || a.order - b.order)
    .map(({ segment }) => segment);

  const kept: SearchSegment[] = [];
  let merged = 0;
  for (const segment of ordered) {
    if (kept.some((better) => overlapRatio(better, segment) >= 0.8)) {
      merged++;
      continue;
    }
    kept.push(segment);
  }
  return { segments: kept, droppedOtherVideo: otherVideo, droppedInvalid: invalid, mergedOverlaps: merged };
}
