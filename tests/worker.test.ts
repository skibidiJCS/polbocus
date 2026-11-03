import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/db";
import { ProviderError } from "@/lib/server/video-provider";
import { getVideo, insertQueuedVideo } from "@/lib/server/videos-repo";
import { retryVideo } from "@/lib/server/video-service";
import { createWorker, WORKER_LIMITS } from "@/lib/server/worker";
import { fakeProvider } from "./fake-provider";
import { tempDb, tempDir } from "./helpers";

let dir: ReturnType<typeof tempDir>;
let db: Db;
let clock: number;
beforeEach(() => {
  dir = tempDir();
  db = tempDb(dir.dir);
  clock = Date.parse("2026-11-02T10:00:00Z");
});
afterEach(() => {
  db.close();
  dir.cleanup();
});

function addVideo(id = "v1") {
  writeFileSync(path.join(dir.dir, `${id}.mp4`), "x");
  const video = insertQueuedVideo(db, { id, originalName: "clip.mp4", storageName: `${id}.mp4`, sha256: `sha-${id}`, sizeBytes: 1, mimeType: "video/mp4" });
  db.prepare("UPDATE indexing_jobs SET next_attempt_at = ? WHERE video_id = ?").run(new Date(clock - 1000).toISOString(), id);
  return video;
}

function worker(provider: ReturnType<typeof fakeProvider> | null, ownerId = "owner-a") {
  return createWorker({ db, getProvider: () => provider, videosDir: dir.dir, now: () => clock, ownerId });
}

async function runDue(w: ReturnType<typeof createWorker>) {
  await w.tick();
  await w.idle();
}

function advance(ms: number) {
  clock += ms;
}

function job(id = "v1") {
  return db.prepare("SELECT * FROM indexing_jobs WHERE video_id = ?").get(id) as { attempts: number; next_attempt_at: string; lease_owner: string | null; last_error: string | null };
}

describe("indexing worker", () => {
  it("runs upload → index → ready across ticks and persists provider IDs", async () => {
    addVideo();
    const provider = fakeProvider();
    const w = worker(provider);
    await runDue(w);
    expect(getVideo(db, "v1")).toMatchObject({ status: "uploading", providerAssetId: "asset1", providerIndexId: "idx1" });
    advance(10_000);
    await runDue(w);
    expect(getVideo(db, "v1")).toMatchObject({ status: "indexing", providerTaskId: "ia1", durationSeconds: 61.5 });
    advance(10_000);
    await runDue(w);
    expect(getVideo(db, "v1")).toMatchObject({ status: "ready", providerVideoId: "ia1", error: null });
    expect(provider.uploadAsset).toHaveBeenCalledTimes(1);
    expect(provider.indexAsset).toHaveBeenCalledTimes(1);
  });

  it("does nothing (and burns no attempts) while no API key is configured", async () => {
    addVideo();
    await runDue(worker(null));
    expect(getVideo(db, "v1")?.status).toBe("queued");
    expect(job().attempts).toBe(0);
  });

  it("recovers an indexing job after a restart without re-uploading or re-indexing", async () => {
    addVideo();
    // State left by a previous process that crashed mid-poll while holding a lease.
    db.prepare("UPDATE videos SET status = 'indexing', provider_asset_id = 'asset1', provider_index_id = 'idx1', provider_task_id = 'ia1', indexing_started_at = ? WHERE id = 'v1'").run(new Date(clock - 60_000).toISOString());
    db.prepare("UPDATE indexing_jobs SET lease_owner = 'dead-process', lease_expires_at = ? WHERE video_id = 'v1'").run(new Date(clock + 30_000).toISOString());
    const provider = fakeProvider({ getIndexedAsset: async () => ({ status: "in_progress", providerStatus: "indexing", durationSeconds: null }) });
    const w = worker(provider, "new-process");
    await runDue(w);
    expect(provider.getIndexedAsset).not.toHaveBeenCalled();
    advance(WORKER_LIMITS.leaseMs);
    await runDue(w);
    expect(provider.getIndexedAsset).toHaveBeenCalledWith("idx1", "ia1", expect.anything());
    expect(provider.uploadAsset).not.toHaveBeenCalled();
    expect(provider.indexAsset).not.toHaveBeenCalled();
    expect(getVideo(db, "v1")).toMatchObject({ status: "indexing", providerStatus: "indexing" });
    expect(job().lease_owner).toBeNull();
  });

  it("reuses an indexed asset created before a crash instead of indexing twice", async () => {
    addVideo();
    db.prepare("UPDATE videos SET status = 'uploading', provider_asset_id = 'asset1', provider_index_id = 'idx1' WHERE id = 'v1'").run();
    const provider = fakeProvider({ findIndexedAssets: async () => ["ia-existing"] });
    await runDue(worker(provider));
    expect(provider.indexAsset).not.toHaveBeenCalled();
    expect(getVideo(db, "v1")?.providerTaskId).toBe("ia-existing");
  });

  it("never lets two workers run the same job", async () => {
    addVideo();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = fakeProvider({ uploadAsset: async () => { await gate; return { assetId: "asset1" }; } });
    const a = worker(provider, "a");
    const b = worker(provider, "b");
    void a.tick();
    await new Promise((r) => setTimeout(r, 10));
    await b.tick();
    release();
    await a.idle();
    await b.idle();
    expect(provider.ensureIndex).toHaveBeenCalledTimes(1);
  });

  it("backs off on temporary failures, honours Retry-After, then gives up after the limit", async () => {
    addVideo();
    const provider = fakeProvider({ uploadAsset: async () => { throw new ProviderError("TwelveLabs 429 too_many_requests: slow", { status: 429, retryable: true, retryAfterSeconds: 120 }); } });
    const w = worker(provider);
    await runDue(w);
    expect(job().attempts).toBe(1);
    expect(Date.parse(job().next_attempt_at) - clock).toBe(120_000);
    expect(getVideo(db, "v1")?.error).toMatch(/Temporary problem \(attempt 1 of 6\)/);
    for (let i = 2; i <= WORKER_LIMITS.maxConsecutiveFailures; i++) {
      advance(WORKER_LIMITS.maxBackoffMs + 1);
      await runDue(w);
    }
    expect(provider.uploadAsset).toHaveBeenCalledTimes(WORKER_LIMITS.maxConsecutiveFailures);
    expect(getVideo(db, "v1")).toMatchObject({ status: "failed" });
    expect(getVideo(db, "v1")?.error).toMatch(/Stopped after 6 failed attempts/);
    advance(WORKER_LIMITS.maxBackoffMs + 1);
    await runDue(w);
    expect(provider.uploadAsset).toHaveBeenCalledTimes(WORKER_LIMITS.maxConsecutiveFailures);
  });

  it("fails immediately on permanent provider errors", async () => {
    addVideo();
    const provider = fakeProvider({ getAsset: async () => ({ status: "failed", message: "TwelveLabs could not process the file." }) });
    const w = worker(provider);
    await runDue(w);
    advance(5000);
    await runDue(w);
    expect(getVideo(db, "v1")).toMatchObject({ status: "failed", error: "TwelveLabs could not process the file." });
    expect(provider.indexAsset).not.toHaveBeenCalled();
  });

  it("marks indexing failures from TwelveLabs as failed", async () => {
    addVideo();
    db.prepare("UPDATE videos SET status = 'indexing', provider_asset_id = 'asset1', provider_index_id = 'idx1', provider_task_id = 'ia1' WHERE id = 'v1'").run();
    await runDue(worker(fakeProvider({ getIndexedAsset: async () => ({ status: "failed", message: "indexing failed" }) })));
    expect(getVideo(db, "v1")).toMatchObject({ status: "failed", error: "indexing failed" });
  });

  it("cleans up a provider asset when the video was deleted mid-upload", async () => {
    addVideo();
    const provider = fakeProvider({
      uploadAsset: async () => {
        db.prepare("DELETE FROM videos WHERE id = 'v1'").run();
        return { assetId: "orphan" };
      },
    });
    await runDue(worker(provider));
    expect(provider.deleteAsset).toHaveBeenCalledWith("orphan");
  });

  it("gives a retried indexing job a fresh timeout window without re-uploading or re-indexing", async () => {
    addVideo();
    let indexing: "in_progress" | "ready" = "in_progress";
    const provider = fakeProvider({
      getIndexedAsset: async () => (indexing === "ready" ? { status: "ready", durationSeconds: 30 } : { status: "in_progress", providerStatus: "indexing", durationSeconds: null }),
    });
    const w = worker(provider);
    await runDue(w); // uploaded
    advance(10_000);
    await runDue(w); // indexing started
    const firstStart = getVideo(db, "v1")!.indexingStartedAt;
    expect(getVideo(db, "v1")).toMatchObject({ status: "indexing", providerTaskId: "ia1" });

    // TwelveLabs is still indexing after 12 hours: the worker gives up.
    advance(WORKER_LIMITS.indexingTimeoutMs + 60_000);
    await runDue(w);
    expect(getVideo(db, "v1")).toMatchObject({ status: "failed", error: expect.stringMatching(/12 hours/) });

    // Retry while the provider still reports indexing: same job, new window.
    await retryVideo(db, provider, "v1", () => clock);
    const retried = getVideo(db, "v1")!;
    expect(retried).toMatchObject({ status: "queued", providerAssetId: "asset1", providerTaskId: "ia1" });
    expect(Date.parse(retried.indexingStartedAt!)).toBe(clock);
    expect(db.prepare("SELECT indexing_first_started_at AS first FROM videos WHERE id = 'v1'").get()).toEqual({ first: firstStart });

    advance(1_000);
    await runDue(w);
    expect(getVideo(db, "v1")).toMatchObject({ status: "indexing", error: null });
    expect(job().next_attempt_at > new Date(clock).toISOString()).toBe(true); // still scheduled for polling

    indexing = "ready";
    advance(60_000);
    await runDue(w);
    expect(getVideo(db, "v1")).toMatchObject({ status: "ready", providerVideoId: "ia1" });
    expect(provider.uploadAsset).toHaveBeenCalledTimes(1);
    expect(provider.indexAsset).toHaveBeenCalledTimes(1);
  });
});
