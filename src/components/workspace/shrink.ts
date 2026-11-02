import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, Quality, canEncodeVideo } from "mediabunny";

/**
 * Re-encodes large, high-resolution videos to 720p in the browser before upload.
 * Search quality doesn't need more, and the upload is the part that grows with file size.
 * Timestamps are kept, so results still line up with the original file playing locally.
 * Returns null whenever shrinking isn't possible or wouldn't save much; the caller then
 * uploads the original.
 */
const TARGET_SHORT_SIDE = 720;
const MIN_BYTES = 25_000_000;
const MAX_SECONDS = 30 * 60; // The result is held in memory.
const HIGH_BITRATE = 6_000_000; // bits per second
const TARGET_BITRATE = 2_500_000; // plenty for 720p search

export async function shrinkVideo(file: File, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<File | null> {
  if (file.size < MIN_BYTES || typeof VideoEncoder === "undefined") return null;
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const duration = await input.computeDuration();
    if (!duration || duration > MAX_SECONDS) return null;
    const shortSide = Math.min(track.displayWidth, track.displayHeight);
    const bitrate = (file.size * 8) / duration;
    if (shortSide <= TARGET_SHORT_SIDE && bitrate < HIGH_BITRATE) return null;
    if (!(await canEncodeVideo("avc"))) return null;

    const landscape = track.displayWidth >= track.displayHeight;
    const size = shortSide > TARGET_SHORT_SIDE ? (landscape ? { height: TARGET_SHORT_SIDE } : { width: TARGET_SHORT_SIDE }) : {};
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: { ...size, codec: "avc", quality: new Quality({ bitrate: TARGET_BITRATE }) },
      showWarnings: false,
    });
    if (!conversion.isValid) return null;
    conversion.onProgress = (progress) => onProgress(progress);
    const cancel = () => void conversion.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await conversion.execute();
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    const buffer = output.target.buffer;
    if (!buffer || buffer.byteLength > file.size * 0.7) return null;
    return new File([buffer], file.name.replace(/\.[^.]+$/, "") + ".mp4", { type: "video/mp4" });
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  } finally {
    input.dispose();
  }
}
