import { describe, expect, it } from "vitest";
import { normalizeSegments, type RawSegment } from "@/lib/segments";
import { clampSeek, formatRange, formatTimestamp } from "@/lib/time";

const item = (overrides: Partial<RawSegment>): RawSegment => ({ videoId: "pv1", start: 0, end: 5, rank: 1, thumbnailUrl: null, transcription: null, ...overrides });
const opts = { providerVideoId: "pv1", localVideoId: "local-1", durationSeconds: 120 };

describe("timestamp formatting", () => {
  it("formats minutes, hours and ranges", () => {
    expect(formatTimestamp(134.97)).toBe("02:14");
    expect(formatTimestamp(0)).toBe("00:00");
    expect(formatTimestamp(3725.2)).toBe("1:02:05");
    expect(formatRange(134.2, 141.9)).toBe("02:14–02:21");
    expect(formatTimestamp(Number.NaN)).toBe("--:--");
  });

  it("validates seek targets against the duration", () => {
    expect(clampSeek(12.345, 60)).toBe(12.345);
    expect(clampSeek(-3, 60)).toBe(0);
    expect(clampSeek(999, 60)).toBeCloseTo(59.95);
    expect(clampSeek(42.5, null)).toBe(42.5);
    expect(clampSeek(Number.NaN, 60)).toBe(0);
  });
});

describe("normalizeSegments", () => {
  it("preserves provider precision and maps to the local video id", () => {
    const { segments } = normalizeSegments([item({ start: 12.533333, end: 18.766667, rank: 2, thumbnailUrl: "https://t/1.jpg" })], opts);
    expect(segments).toEqual([{ videoId: "local-1", startSeconds: 12.533333, endSeconds: 18.766667, rank: 2, thumbnailUrl: "https://t/1.jpg" }]);
  });

  it("drops results for other videos even if the provider returns them", () => {
    const result = normalizeSegments([item({ videoId: "other", start: 1, end: 2 }), item({ start: 3, end: 4 })], opts);
    expect(result.segments.map((s) => s.startSeconds)).toEqual([3]);
    expect(result.droppedOtherVideo).toBe(1);
  });

  it("rejects invalid timestamps and clamps the end to the known duration", () => {
    const result = normalizeSegments([
      item({ start: "3", end: 5 }),
      item({ start: 10, end: 10 }),
      item({ start: -1, end: 4 }),
      item({ start: 130, end: 140 }),
      item({ start: 115, end: 125, rank: 1 }),
    ], opts);
    expect(result.droppedInvalid).toBe(4);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ startSeconds: 115, endSeconds: 120 });
  });

  it("orders by rank and removes duplicates and mostly-overlapping segments", () => {
    const result = normalizeSegments([
      item({ start: 40, end: 50, rank: 3 }),
      item({ start: 10, end: 20, rank: 1 }),
      item({ start: 10, end: 20, rank: 2 }),
      item({ start: 11, end: 19, rank: 4 }),
      item({ start: 18, end: 30, rank: 5 }),
    ], opts);
    expect(result.segments.map((s) => [s.startSeconds, s.rank])).toEqual([[10, 1], [40, 3], [18, 5]]);
    expect(result.mergedOverlaps).toBe(2);
  });

  it("never invents a rank, thumbnail or transcript", () => {
    const { segments } = normalizeSegments([item({ rank: undefined, thumbnailUrl: null, transcription: null })], opts);
    expect(segments[0]).not.toHaveProperty("rank");
    expect(segments[0]).not.toHaveProperty("thumbnailUrl");
    expect(segments[0]).not.toHaveProperty("transcription");
  });
});
