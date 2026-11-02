import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/db";
import { ProviderError } from "@/lib/server/video-provider";
import { deleteVideo, retryVideo, searchVideo } from "@/lib/server/video-service";
import { getVideo, insertQueuedVideo } from "@/lib/server/videos-repo";
import { fakeProvider } from "./fake-provider";
import { tempDb, tempDir } from "./helpers";

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

function readyVideo(id = "v1", providerVideoId = "pv1") {
  writeFileSync(path.join(dir.dir, `${id}.mp4`), "x");
  insertQueuedVideo(db, { id, originalName: `${id}.mp4`, storageName: `${id}.mp4`, sha256: `sha-${id}`, sizeBytes: 1, mimeType: "video/mp4" });
  db.prepare("UPDATE videos SET status = 'ready', provider_asset_id = ?, provider_index_id = 'idx1', provider_task_id = ?, provider_video_id = ?, duration_seconds = 90 WHERE id = ?").run(`asset-${id}`, providerVideoId, providerVideoId, id);
}

describe("searchVideo", () => {
  it("searches only the selected video's provider ID and hides other videos' results", async () => {
    readyVideo("v1", "pv1");
    readyVideo("v2", "pv2");
    const provider = fakeProvider({
      search: async () => [
        { videoId: "pv1", start: 5.5, end: 9.25, rank: 1, thumbnailUrl: null, transcription: null },
        { videoId: "pv2", start: 1, end: 2, rank: 2, thumbnailUrl: null, transcription: null },
      ],
    });
    const result = await searchVideo(db, provider, "v1", "  person waves  ");
    expect(provider.search).toHaveBeenCalledWith(expect.objectContaining({ indexId: "idx1", providerVideoId: "pv1", query: "person waves" }), undefined);
    expect(result.segments).toEqual([{ videoId: "v1", startSeconds: 5.5, endSeconds: 9.25, rank: 1 }]);
    expect(result.notes.join(" ")).toMatch(/1 result\(s\) from other videos/);
  });

  it("refuses to search videos that are not ready and validates the query", async () => {
    readyVideo();
    db.prepare("UPDATE videos SET status = 'indexing' WHERE id = 'v1'").run();
    const provider = fakeProvider();
    await expect(searchVideo(db, provider, "v1", "x")).rejects.toMatchObject({ status: 409 });
    await expect(searchVideo(db, provider, "v1", "   ")).rejects.toMatchObject({ status: 400 });
    await expect(searchVideo(db, provider, "missing", "x")).rejects.toMatchObject({ status: 404 });
    expect(provider.search).not.toHaveBeenCalled();
  });

  it("falls back once without transcription when the index rejects it, and remembers that", async () => {
    readyVideo();
    let calls = 0;
    const provider = fakeProvider({
      search: async ({ searchOptions }) => {
        calls++;
        if (searchOptions.includes("transcription")) throw new ProviderError("unsupported", { status: 400, code: "search_option_not_supported", retryable: false });
        return [];
      },
    });
    const first = await searchVideo(db, provider, "v1", "deadline");
    expect(calls).toBe(2);
    expect(first.searchOptions).toEqual(["visual", "audio"]);
    await searchVideo(db, provider, "v1", "deadline");
    expect(calls).toBe(3);
  });

  it("restricts the TwelveLabs search options to the chosen mode", async () => {
    readyVideo();
    const provider = fakeProvider();
    expect((await searchVideo(db, provider, "v1", "q", undefined, "speech")).searchOptions).toEqual(["transcription"]);
    expect((await searchVideo(db, provider, "v1", "q", undefined, "visual")).searchOptions).toEqual(["visual"]);
    expect((await searchVideo(db, provider, "v1", "q")).searchOptions).toEqual(["visual", "transcription", "audio"]);
    const visualOnly = fakeProvider({ getIndex: async (id: string) => ({ id, searchOptions: ["visual"] }) });
    await expect(searchVideo(db, visualOnly, "v1", "q", undefined, "speech")).rejects.toMatchObject({ status: 400 });
    expect(visualOnly.search).not.toHaveBeenCalled();
  });

  it("does not retry rate-limited searches automatically", async () => {
    readyVideo();
    const provider = fakeProvider({ search: async () => { throw new ProviderError("429", { status: 429, retryable: true, retryAfterSeconds: 30 }); } });
    await expect(searchVideo(db, provider, "v1", "q")).rejects.toMatchObject({ status: 429 });
    expect(provider.search).toHaveBeenCalledTimes(1);
  });
});

describe("deleteVideo", () => {
  it("deletes the provider copy, then the local file and record", async () => {
    readyVideo();
    const provider = fakeProvider();
    const result = await deleteVideo(db, provider, "v1", { includeProvider: true, videosDir: dir.dir });
    expect(provider.deleteAsset).toHaveBeenCalledWith("asset-v1");
    expect(result).toMatchObject({ local: "deleted", provider: "deleted", recordRemoved: true });
    expect(existsSync(path.join(dir.dir, "v1.mp4"))).toBe(false);
    expect(getVideo(db, "v1")).toBeNull();
  });

  it("keeps everything when the provider deletion fails and says so", async () => {
    readyVideo();
    const provider = fakeProvider({ deleteAsset: async () => { throw new ProviderError("TwelveLabs 500: boom", { status: 500, retryable: true }); } });
    const result = await deleteVideo(db, provider, "v1", { includeProvider: true, videosDir: dir.dir });
    expect(result).toMatchObject({ provider: "failed", local: "skipped", recordRemoved: false });
    expect(existsSync(path.join(dir.dir, "v1.mp4"))).toBe(true);
    expect(getVideo(db, "v1")?.error).toMatch(/Deleting the TwelveLabs copy failed/);
  });

  it("can delete only the local copy and reports the provider copy as kept", async () => {
    readyVideo();
    const provider = fakeProvider();
    const result = await deleteVideo(db, provider, "v1", { includeProvider: false, videosDir: dir.dir });
    expect(provider.deleteAsset).not.toHaveBeenCalled();
    expect(result).toMatchObject({ provider: "skipped", local: "deleted", recordRemoved: true });
    expect(result.message).toMatch(/TwelveLabs copy was kept/);
  });

  it("reports a provider copy that was already gone as not found", async () => {
    readyVideo();
    const result = await deleteVideo(db, fakeProvider({ deleteAsset: async () => "not_found" }), "v1", { includeProvider: true, videosDir: dir.dir });
    expect(result.provider).toBe("not_found");
    expect(result.message).toMatch(/no longer had a copy/);
  });
});

describe("retryVideo", () => {
  it("reuses a ready asset, deletes the failed indexed asset, and requeues", async () => {
    readyVideo();
    db.prepare("UPDATE videos SET status = 'failed', provider_video_id = NULL, error = 'x' WHERE id = 'v1'").run();
    db.prepare("UPDATE indexing_jobs SET attempts = 6 WHERE video_id = 'v1'").run();
    const provider = fakeProvider({ getIndexedAsset: async () => ({ status: "failed", message: "x" }) });
    await retryVideo(db, provider, "v1");
    expect(provider.deleteIndexedAsset).toHaveBeenCalledWith("idx1", "pv1");
    expect(provider.deleteAsset).not.toHaveBeenCalled();
    expect(getVideo(db, "v1")).toMatchObject({ status: "queued", providerAssetId: "asset-v1", providerTaskId: null, error: null });
    expect(db.prepare("SELECT attempts FROM indexing_jobs WHERE video_id = 'v1'").get()).toEqual({ attempts: 0 });
  });

  it("only retries failed videos", async () => {
    readyVideo();
    await expect(retryVideo(db, fakeProvider(), "v1")).rejects.toMatchObject({ status: 409 });
  });
});
