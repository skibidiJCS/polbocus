import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import type { Db } from "./db";
import { UploadError } from "./errors";
import { ACCEPTED_FORMATS_LABEL, detectContainer, type DetectedContainer } from "./media";
import { findVideoBySha256, insertQueuedVideo } from "./videos-repo";
import type { VideoRecord } from "@/types/video";

export { UploadError };

const SNIFF_BYTES = 64;

export interface ReceivedFile {
  tempPath: string;
  sha256: string;
  sizeBytes: number;
  container: DetectedContainer;
}

/**
 * Streams a request body to a temporary file while hashing it, enforcing the size
 * limit and checking the container signature from the first bytes.
 */
export async function receiveToTempFile(body: ReadableStream<Uint8Array>, options: { tmpDir: string; maxBytes: number; signal?: AbortSignal }): Promise<ReceivedFile> {
  await mkdir(options.tmpDir, { recursive: true });
  const tempPath = path.join(options.tmpDir, `${randomUUID()}.part`);
  const out = createWriteStream(tempPath, { flags: "wx" });
  const hash = createHash("sha256");
  const head = new Uint8Array(SNIFF_BYTES);
  let headLength = 0;
  let container: DetectedContainer | null = null;
  let size = 0;
  const reader = body.getReader();
  try {
    while (true) {
      if (options.signal?.aborted) throw new UploadError("Upload was cancelled.", 499);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > options.maxBytes) {
        throw new UploadError(`File exceeds the ${(options.maxBytes / 1e9).toFixed(1)} GB limit.`, 413);
      }
      if (headLength < SNIFF_BYTES) {
        const take = Math.min(SNIFF_BYTES - headLength, value.byteLength);
        head.set(value.subarray(0, take), headLength);
        headLength += take;
        if (headLength === SNIFF_BYTES) {
          container = detectContainer(head);
          if (!container) throw new UploadError(`Unsupported file. Upload an ${ACCEPTED_FORMATS_LABEL} video.`, 415);
        }
      }
      hash.update(value);
      if (!out.write(value)) await once(out, "drain");
    }
    if (!container) container = detectContainer(head.subarray(0, headLength));
    if (size === 0) throw new UploadError("The file is empty.", 400);
    if (!container) throw new UploadError(`Unsupported file. Upload an ${ACCEPTED_FORMATS_LABEL} video.`, 415);
    out.end();
    await once(out, "finish");
    return { tempPath, sha256: hash.digest("hex"), sizeBytes: size, container };
  } catch (error) {
    reader.cancel().catch(() => {});
    out.destroy();
    // The file is opened asynchronously; wait until the stream has fully closed so the
    // file cannot reappear after it is removed.
    await finished(out).catch(() => {});
    await rm(tempPath, { force: true });
    throw error;
  }
}

/**
 * Moves a received file into the library under a generated name, or discards it
 * when identical content (same SHA-256) is already stored.
 */
export async function storeReceivedFile(db: Db, file: ReceivedFile, originalName: string, videosDir: string): Promise<{ video: VideoRecord; duplicate: boolean }> {
  const existing = findVideoBySha256(db, file.sha256);
  if (existing) {
    await rm(file.tempPath, { force: true });
    return { video: existing, duplicate: true };
  }
  const id = randomUUID();
  const storageName = `${id}.${file.container.extension}`;
  const finalPath = path.join(/* turbopackIgnore: true */ videosDir, storageName);
  await mkdir(videosDir, { recursive: true });
  await rename(file.tempPath, finalPath);
  try {
    const video = insertQueuedVideo(db, { id, originalName, storageName, sha256: file.sha256, sizeBytes: file.sizeBytes, mimeType: file.container.mimeType });
    return { video, duplicate: false };
  } catch (error) {
    await rm(finalPath, { force: true });
    // A concurrent upload of the same content won the unique sha256 constraint.
    const winner = findVideoBySha256(db, file.sha256);
    if (winner) return { video: winner, duplicate: true };
    throw error;
  }
}
