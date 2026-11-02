import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { receiveToTempFile, storeReceivedFile, UploadError } from "@/lib/server/upload";
import type { Db } from "@/lib/server/db";
import { fakeMp4, streamOf, tempDb, tempDir } from "./helpers";

let dir: ReturnType<typeof tempDir>;
let db: Db;
beforeEach(() => {
  dir = tempDir();
  db = tempDb(dir.dir);
});
afterEach(() => {
  db.close();
  dir.cleanup();
});

const tmpDir = () => path.join(dir.dir, "tmp");
const videosDir = () => path.join(dir.dir, "videos");

describe("streamed upload", () => {
  it("stores a valid video under a generated name with its hash and size", async () => {
    const bytes = fakeMp4(100_000);
    const received = await receiveToTempFile(streamOf(bytes.subarray(0, 10), bytes.subarray(10)), { tmpDir: tmpDir(), maxBytes: 1e6 });
    const { video, duplicate } = await storeReceivedFile(db, received, "../My Clip.mp4", videosDir());
    expect(duplicate).toBe(false);
    expect(video.storageName).toMatch(/^[0-9a-f-]{36}\.mp4$/);
    expect(video.sizeBytes).toBe(100_000);
    expect(video.status).toBe("queued");
    expect(readFileSync(path.join(videosDir(), video.storageName)).equals(bytes)).toBe(true);
    expect(readdirSync(tmpDir())).toEqual([]);
    const job = db.prepare("SELECT attempts FROM indexing_jobs WHERE video_id = ?").get(video.id);
    expect(job).toBeTruthy();
  });

  it("deduplicates identical content instead of storing it twice", async () => {
    const bytes = fakeMp4(5000);
    const first = await storeReceivedFile(db, await receiveToTempFile(streamOf(bytes), { tmpDir: tmpDir(), maxBytes: 1e6 }), "a.mp4", videosDir());
    const second = await storeReceivedFile(db, await receiveToTempFile(streamOf(bytes), { tmpDir: tmpDir(), maxBytes: 1e6 }), "copy of a.mp4", videosDir());
    expect(second.duplicate).toBe(true);
    expect(second.video.id).toBe(first.video.id);
    expect(readdirSync(videosDir())).toHaveLength(1);
    expect(readdirSync(tmpDir())).toEqual([]);
  });

  it("rejects non-video bytes regardless of the claimed name and removes the temp file", async () => {
    const fake = Buffer.alloc(1000, 0x20);
    fake.write("%PDF-1.7", 0, "latin1");
    await expect(receiveToTempFile(streamOf(fake), { tmpDir: tmpDir(), maxBytes: 1e6 })).rejects.toMatchObject({ status: 415 });
    expect(readdirSync(tmpDir())).toEqual([]);
  });

  it("enforces the size limit while streaming", async () => {
    const error = await receiveToTempFile(streamOf(fakeMp4(3000), fakeMp4(3000)), { tmpDir: tmpDir(), maxBytes: 4000 }).catch((e) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error.status).toBe(413);
    expect(readdirSync(tmpDir())).toEqual([]);
  });

  it("rejects empty bodies", async () => {
    await expect(receiveToTempFile(streamOf(), { tmpDir: tmpDir(), maxBytes: 4000 })).rejects.toMatchObject({ status: 400 });
    expect(existsSync(tmpDir())).toBe(true);
  });
});
