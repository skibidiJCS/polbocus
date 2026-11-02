import { describe, expect, it, vi } from "vitest";
import type { BlobStore } from "@/lib/server/blob-store";
import { advanceSession, ASSET_TAG, endSession, startSession, STALE_AFTER_MS, sweepStaleSessions } from "@/lib/server/session";
import { ProviderError } from "@/lib/server/video-provider";
import { fakeProvider } from "./fake-provider";
import { fakeMp4 } from "./helpers";

const PATH = "sessions/0b5e8c3a-4f1e-4a8a-9d3e-2c1f0e9b7a6d-Ab12Cd.mp4";
const ASSET = "6ae827b7eeb94daa3de92d19";
const INDEX = "6ae827b6e3a9fc22dae1089c";
const INDEXED = "6ae827ba5bbdac01fc5291b1";

function fakeBlob(overrides: Partial<BlobStore> = {}) {
  const blob = {
    configured: vi.fn(() => true),
    head: vi.fn(async () => ({ size: 5000, contentType: "video/mp4" })),
    readStart: vi.fn(async () => new Uint8Array(fakeMp4(64))),
    presignGet: vi.fn(async (pathname: string) => `https://store.private.blob.vercel-storage.com/${pathname}?vercel-blob-signature=x`),
    remove: vi.fn(async () => {}),
    list: vi.fn(async () => [] as { pathname: string; uploadedAt: Date }[]),
  };
  for (const [key, impl] of Object.entries(overrides)) (blob as Record<string, unknown>)[key] = vi.fn(impl as (...args: unknown[]) => unknown);
  return blob;
}

describe("startSession", () => {
  it("checks the upload's bytes and hands TwelveLabs a temporary link, tagging the asset", async () => {
    const provider = fakeProvider({ ensureIndex: async () => ({ id: INDEX, searchOptions: ["visual"] }) });
    const blob = fakeBlob();
    const result = await startSession({ provider, blob, now: () => 1_000 }, { pathname: PATH, filename: "Holiday.mov" });
    expect(result).toEqual({ assetId: "asset1", indexId: INDEX, sizeBytes: 5000 });
    expect(blob.presignGet).toHaveBeenCalledWith(PATH, 1_000 + 2 * 60 * 60_000);
    expect(provider.createAssetFromUrl).toHaveBeenCalledWith(expect.stringContaining(PATH), `${ASSET_TAG}Holiday.mov`, undefined);
  });

  it("rejects unknown paths, non-video bytes and oversize files, deleting the upload", async () => {
    const provider = fakeProvider();
    await expect(startSession({ provider, blob: fakeBlob() }, { pathname: "../etc/passwd", filename: "x" })).rejects.toMatchObject({ status: 400 });
    const notVideo = fakeBlob({ readStart: async () => new TextEncoder().encode("%PDF-1.7 not a video at all, just some text padding") });
    await expect(startSession({ provider, blob: notVideo }, { pathname: PATH, filename: "x" })).rejects.toMatchObject({ status: 415 });
    expect(notVideo.remove).toHaveBeenCalledWith([PATH]);
    const huge = fakeBlob({ head: async () => ({ size: 5_000_000_000, contentType: "video/mp4" }) });
    await expect(startSession({ provider, blob: huge }, { pathname: PATH, filename: "x" })).rejects.toMatchObject({ status: 413 });
    expect(provider.createAssetFromUrl).not.toHaveBeenCalled();
  });
});

describe("advanceSession", () => {
  it("waits while TwelveLabs processes, then deletes the upload and indexes once", async () => {
    let assetState: "processing" | "ready" = "processing";
    const provider = fakeProvider({ getAsset: async () => (assetState === "ready" ? { status: "ready", durationSeconds: 24 } : { status: "processing" }), indexAsset: async () => ({ indexedAssetId: INDEXED }) });
    const blob = fakeBlob();
    const deps = { provider, blob };
    expect(await advanceSession(deps, { assetId: ASSET, indexId: INDEX, pathname: PATH })).toEqual({ stage: "processing" });
    expect(blob.remove).not.toHaveBeenCalled();
    assetState = "ready";
    expect(await advanceSession(deps, { assetId: ASSET, indexId: INDEX, pathname: PATH })).toEqual({ stage: "indexing", indexedAssetId: INDEXED, providerStatus: "pending", durationSeconds: 24 });
    expect(blob.remove).toHaveBeenCalledWith([PATH]);
    expect(provider.indexAsset).toHaveBeenCalledTimes(1);
  });

  it("reuses an indexed asset instead of indexing twice", async () => {
    const provider = fakeProvider({ findIndexedAssets: async () => [INDEXED] });
    const status = await advanceSession({ provider, blob: fakeBlob() }, { assetId: ASSET, indexId: INDEX });
    expect(status).toMatchObject({ stage: "indexing", indexedAssetId: INDEXED });
    expect(provider.indexAsset).not.toHaveBeenCalled();
  });

  it("reports indexing progress, readiness and failure", async () => {
    const states = [
      { status: "in_progress", providerStatus: "queued", durationSeconds: null },
      { status: "ready", durationSeconds: 24 },
      { status: "failed", message: "nope" },
    ];
    const provider = fakeProvider({ getIndexedAsset: async () => states.shift() as never });
    const deps = { provider, blob: fakeBlob() };
    const input = { assetId: ASSET, indexId: INDEX, indexedAssetId: INDEXED };
    expect(await advanceSession(deps, input)).toMatchObject({ stage: "indexing", providerStatus: "queued" });
    expect(await advanceSession(deps, input)).toEqual({ stage: "ready", indexedAssetId: INDEXED, durationSeconds: 24 });
    expect(await advanceSession(deps, input)).toEqual({ stage: "failed", message: "nope" });
  });

  it("validates IDs before calling TwelveLabs", async () => {
    const provider = fakeProvider();
    await expect(advanceSession({ provider, blob: fakeBlob() }, { assetId: "../x", indexId: INDEX })).rejects.toMatchObject({ status: 400 });
    expect(provider.getAsset).not.toHaveBeenCalled();
  });
});

describe("endSession and sweep", () => {
  it("deletes the TwelveLabs copy and the upload, and is safe to repeat", async () => {
    const provider = fakeProvider();
    const blob = fakeBlob();
    expect(await endSession({ provider, blob }, { assetId: ASSET, pathname: PATH })).toEqual({ provider: "deleted", upload: "deleted" });
    expect(provider.deleteAsset).toHaveBeenCalledWith(ASSET);
    const gone = fakeProvider({ deleteAsset: async () => { throw new ProviderError("gone", { status: 404, retryable: false }); } });
    expect((await endSession({ provider: gone, blob }, { assetId: ASSET })).provider).toBe("not_found");
    expect(await endSession({ provider, blob }, {})).toEqual({ provider: "skipped", upload: "skipped" });
  });

  it("only sweeps this app's tagged assets and uploads older than the cutoff", async () => {
    const now = Date.parse("2026-11-02T20:00:00Z");
    const old = new Date(now - STALE_AFTER_MS - 60_000).toISOString();
    const recent = new Date(now - 60_000).toISOString();
    const provider = fakeProvider({
      listAssets: async () => [
        { id: "a1", filename: `${ASSET_TAG}old.mp4`, createdAt: old },
        { id: "a2", filename: `${ASSET_TAG}current.mp4`, createdAt: recent },
        { id: "a3", filename: "my own upload.mov", createdAt: old },
      ],
    });
    const blob = fakeBlob({ list: async () => [{ pathname: "sessions/old.mp4", uploadedAt: new Date(old) }, { pathname: "sessions/new.mp4", uploadedAt: new Date(recent) }] });
    const removed = await sweepStaleSessions({ provider, blob, now: () => now });
    expect(provider.deleteAsset).toHaveBeenCalledTimes(1);
    expect(provider.deleteAsset).toHaveBeenCalledWith("a1");
    expect(blob.remove).toHaveBeenCalledWith(["sessions/old.mp4"]);
    expect(removed).toEqual({ assets: 1, uploads: 1 });
  });
});
