import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlobStore } from "@/lib/server/blob-store";
import {
  advanceSession, ASSET_TAG, CLEANUP_MAX_ATTEMPTS, cleanupBackoffMs, endSession, HEARTBEAT_MS, IDLE_TIMEOUT_MS, KEYS, LEGACY_STALE_MS,
  processDueSessions, registerSession, startSession, sweepListings, taggedFilename, touchSession, type SessionDeps,
} from "@/lib/server/session";
import { memoryStore, type SharedStore } from "@/lib/server/shared-store";
import { ProviderError } from "@/lib/server/video-provider";
import { fakeProvider } from "./fake-provider";
import { fakeMp4 } from "./helpers";

const SID = "0b5e8c3a-4f1e-4a8a-9d3e-2c1f0e9b7a6d";
const PATH = `sessions/${SID}-Ab12Cd.mp4`;
const INDEX = "6ae827b6e3a9fc22dae1089c";
const START = Date.parse("2026-11-02T10:00:00Z");
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hexId = (n: number) => n.toString(16).padStart(24, "0");

let clock: number;
let store: SharedStore;
let logs: { level: string; message: string }[];

/** In-memory TwelveLabs assets, listed newest first like the real API. */
function providerWithAssets() {
  const assets = new Map<string, { filename: string; createdAt: number }>();
  let next = 1;
  const provider = fakeProvider({
    ensureIndex: async () => ({ id: INDEX, searchOptions: ["visual"] }),
    createAssetFromUrl: async (_url: string, filename: string) => {
      const id = hexId(next++);
      assets.set(id, { filename, createdAt: clock });
      return { assetId: id };
    },
    listAssets: async ({ page, pageLimit, filename }: { page: number; pageLimit: number; filename?: string }) => {
      const all = [...assets.entries()]
        .filter(([, a]) => !filename || a.filename.toLowerCase().includes(filename.toLowerCase()))
        .sort((a, b) => b[1].createdAt - a[1].createdAt || b[0].localeCompare(a[0]));
      const items = all.slice((page - 1) * pageLimit, page * pageLimit).map(([id, a]) => ({ id, filename: a.filename, createdAt: new Date(a.createdAt).toISOString() }));
      return { items, totalPages: Math.max(1, Math.ceil(all.length / pageLimit)) };
    },
    deleteAsset: async (id: string) => {
      if (!assets.delete(id)) throw new ProviderError("not found", { status: 404, code: "resource_not_exists", retryable: false });
      return "deleted";
    },
  });
  const add = (filename: string, createdAt: number) => {
    const id = hexId(next++);
    assets.set(id, { filename, createdAt });
    return id;
  };
  return { provider, assets, add };
}

/** In-memory private Blob store with cursor pagination. */
function blobStore() {
  const blobs = new Map<string, number>();
  const store = {
    configured: vi.fn(() => true),
    head: vi.fn(async (pathname: string) => (blobs.has(pathname) ? { size: 5000, contentType: "video/mp4" } : null)),
    readStart: vi.fn(async () => new Uint8Array(fakeMp4(64))),
    presignGet: vi.fn(async (pathname: string) => `https://store.private.blob.vercel-storage.com/${pathname}?sig=x`),
    remove: vi.fn(async (pathnames: string[]) => { for (const p of pathnames) blobs.delete(p); }),
    list: vi.fn(async (prefix: string, page: { cursor?: string; limit?: number } = {}) => {
      const all = [...blobs.keys()].filter((p) => p.startsWith(prefix)).sort();
      const start = page.cursor ? all.findIndex((p) => p > page.cursor!) : 0;
      const slice = start < 0 ? [] : all.slice(start, start + (page.limit ?? 1000));
      const hasMore = start >= 0 && start + slice.length < all.length;
      return { blobs: slice.map((pathname) => ({ pathname, uploadedAt: new Date(blobs.get(pathname)!) })), hasMore, cursor: hasMore ? slice.at(-1) : undefined };
    }),
  };
  return { store: store as typeof store & BlobStore, blobs };
}

function harness() {
  const tl = providerWithAssets();
  const blob = blobStore();
  const deps: SessionDeps = {
    provider: tl.provider, blob: blob.store, store, now: () => clock,
    log: (level, message) => logs.push({ level, message }),
  };
  return { deps, tl, blob };
}

/** A session that has uploaded its file and been handed to TwelveLabs. */
async function startedSession(h: ReturnType<typeof harness>, id = SID) {
  const pathname = `sessions/${id}-Ab12Cd.mp4`;
  await registerSession(h.deps, id);
  h.blob.blobs.set(pathname, clock);
  const started = await startSession(h.deps, { sessionId: id, pathname, filename: "Holiday.mov" });
  return { pathname, assetId: started.assetId };
}

beforeEach(() => {
  clock = START;
  store = memoryStore(() => clock);
  logs = [];
});

describe("starting and advancing a session", () => {
  it("records the session before upload, tags the asset with it, and stores the IDs server-side", async () => {
    const h = harness();
    const { assetId, pathname } = await startedSession(h);
    expect(h.tl.provider.createAssetFromUrl).toHaveBeenCalledWith(expect.stringContaining(PATH), taggedFilename(SID, "Holiday.mov"));
    expect(h.tl.assets.get(assetId)?.filename).toBe(`${ASSET_TAG}${SID}--Holiday.mov`);
    expect(await store.getJson(KEYS.asset(SID))).toEqual({ assetId, indexId: INDEX, pathname });

    const status = await advanceSession(h.deps, { sessionId: SID });
    expect(status).toMatchObject({ stage: "indexing" });
    expect(h.blob.blobs.has(pathname)).toBe(false); // TwelveLabs has its copy
    expect(await store.getJson(KEYS.asset(SID))).toMatchObject({ indexedAssetId: "ia1" });
    expect(await advanceSession(h.deps, { sessionId: SID })).toMatchObject({ stage: "ready" });
    expect(h.tl.provider.indexAsset).toHaveBeenCalledTimes(1);
  });

  it("rejects uploads that don't belong to the session, non-video bytes, oversize files and ended sessions", async () => {
    const h = harness();
    await registerSession(h.deps, SID);
    await expect(startSession(h.deps, { sessionId: SID, pathname: `sessions/${sid(9)}.mp4`, filename: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(startSession(h.deps, { sessionId: SID, pathname: "../etc/passwd", filename: "x" })).rejects.toMatchObject({ status: 400 });
    h.blob.blobs.set(PATH, clock);
    h.blob.store.readStart.mockResolvedValueOnce(new TextEncoder().encode("%PDF-1.7 not a video at all, just padding text"));
    await expect(startSession(h.deps, { sessionId: SID, pathname: PATH, filename: "x" })).rejects.toMatchObject({ status: 415 });
    expect(h.blob.blobs.has(PATH)).toBe(false);
    h.blob.blobs.set(PATH, clock);
    h.blob.store.head.mockResolvedValueOnce({ size: 5_000_000_000, contentType: "video/mp4" });
    await expect(startSession(h.deps, { sessionId: SID, pathname: PATH, filename: "x" })).rejects.toMatchObject({ status: 413 });
    expect(h.tl.provider.createAssetFromUrl).not.toHaveBeenCalled();

    await endSession(h.deps, { sessionId: SID });
    await expect(registerSession(h.deps, SID)).resolves.toBeUndefined(); // record gone: a fresh session
    await endSession(h.deps, { sessionId: SID });
    await expect(startSession(h.deps, { sessionId: sid(5), pathname: `sessions/${sid(5)}.mp4`, filename: "x" })).rejects.toMatchObject({ status: 410 });
  });
});

describe("cleanup without the browser", () => {
  it("deletes an abandoned session after the idle timeout when the beacon never arrived, with no further upload", async () => {
    const h = harness();
    const { assetId, pathname } = await startedSession(h);
    // The page closes; no beacon reaches the server and nobody uploads again.
    clock += IDLE_TIMEOUT_MS - 60_000;
    expect(await processDueSessions(h.deps)).toMatchObject({ deleted: 0 });
    expect(h.tl.assets.has(assetId)).toBe(true);
    clock += 2 * 60_000;
    expect(await processDueSessions(h.deps)).toMatchObject({ checked: 1, deleted: 1 });
    expect(h.tl.assets.has(assetId)).toBe(false);
    expect(h.blob.blobs.has(pathname)).toBe(false);
    expect(await store.getJson(KEYS.record(SID))).toBeNull();
    expect(await store.zdue(KEYS.due, Infinity, 10)).toEqual([]);
  });

  it("keeps a session that is still sending heartbeats, however old it is", async () => {
    const h = harness();
    const { assetId } = await startedSession(h);
    for (let elapsed = 0; elapsed < 8 * 60 * 60_000; elapsed += HEARTBEAT_MS) {
      clock += HEARTBEAT_MS;
      await touchSession(h.deps, SID);
      await processDueSessions(h.deps);
    }
    await sweepListings(h.deps);
    expect(h.tl.assets.has(assetId)).toBe(true);
    expect(await store.getJson(KEYS.record(SID))).toMatchObject({ state: "active" });
    // Heartbeats stop: abandoned 30 minutes later.
    clock += IDLE_TIMEOUT_MS + 1;
    await processDueSessions(h.deps);
    expect(h.tl.assets.has(assetId)).toBe(false);
  });

  it("retries a failed deletion with backoff and logs each outcome until it succeeds", async () => {
    const h = harness();
    const { assetId } = await startedSession(h);
    const realDelete = h.tl.provider.deleteAsset.getMockImplementation()!;
    h.tl.provider.deleteAsset.mockImplementation(async () => { throw new ProviderError("TwelveLabs 503", { status: 503, retryable: true }); });

    const first = await endSession(h.deps, { sessionId: SID });
    expect(first).toMatchObject({ outcome: "retrying", attempts: 1, nextAttemptAt: clock + cleanupBackoffMs(1) });
    expect(await store.getJson(KEYS.record(SID))).toMatchObject({ state: "ending", cleanup: { attempts: 1, lastError: "TwelveLabs 503" } });
    expect(logs.at(-1)).toMatchObject({ level: "warn" });
    expect(await processDueSessions(h.deps)).toMatchObject({ checked: 0 }); // not due yet

    clock += cleanupBackoffMs(1);
    expect(await processDueSessions(h.deps)).toMatchObject({ retrying: 1 });
    h.tl.provider.deleteAsset.mockImplementation(realDelete);
    clock += cleanupBackoffMs(2);
    expect(await processDueSessions(h.deps)).toMatchObject({ deleted: 1 });
    expect(h.tl.assets.has(assetId)).toBe(false);
    expect(await store.getJson(KEYS.record(SID))).toBeNull();
  });

  it("gives up after a bounded number of attempts and logs an error", async () => {
    const h = harness();
    await startedSession(h);
    h.tl.provider.deleteAsset.mockImplementation(async () => { throw new ProviderError("TwelveLabs 500", { status: 500, retryable: true }); });
    let outcome = await endSession(h.deps, { sessionId: SID });
    for (let i = 1; i < CLEANUP_MAX_ATTEMPTS; i++) {
      clock += cleanupBackoffMs(i);
      await processDueSessions(h.deps);
    }
    outcome = (await store.getJson<{ state: string; cleanup: { attempts: number } }>(KEYS.record(SID))) as never;
    expect(outcome).toMatchObject({ state: "failed", cleanup: { attempts: CLEANUP_MAX_ATTEMPTS } });
    expect(await store.zdue(KEYS.due, Infinity, 10)).toEqual([]);
    expect(logs.filter((entry) => entry.level === "error")).toHaveLength(1);
    expect(h.tl.provider.deleteAsset).toHaveBeenCalledTimes(CLEANUP_MAX_ATTEMPTS);
  });

  it("is harmless to repeat", async () => {
    const h = harness();
    const { assetId } = await startedSession(h);
    expect(await endSession(h.deps, { sessionId: SID })).toEqual({ outcome: "deleted" });
    expect(await endSession(h.deps, { sessionId: SID })).toEqual({ outcome: "deleted" });
    clock += IDLE_TIMEOUT_MS * 2;
    expect(await processDueSessions(h.deps)).toMatchObject({ checked: 0 });
    expect(await sweepListings(h.deps)).toMatchObject({ assets: { deleted: 0, failed: 0 }, uploads: { deleted: 0, failed: 0 } });
    expect(h.tl.assets.has(assetId)).toBe(false);
  });
});

describe("cancellation racing with asset creation", () => {
  it("deletes the asset when the session ends while TwelveLabs is still creating it", async () => {
    const h = harness();
    await registerSession(h.deps, SID);
    h.blob.blobs.set(PATH, clock);
    let finishCreate!: () => void;
    const created = new Promise<void>((resolve) => { finishCreate = resolve; });
    const original = h.tl.provider.createAssetFromUrl.getMockImplementation()!;
    h.tl.provider.createAssetFromUrl.mockImplementation(async (...args: unknown[]) => {
      await created;
      return original(...args);
    });

    const start = startSession(h.deps, { sessionId: SID, pathname: PATH, filename: "clip.mp4" });
    await vi.waitFor(() => expect(h.tl.provider.createAssetFromUrl).toHaveBeenCalled());
    expect(await endSession(h.deps, { sessionId: SID })).toEqual({ outcome: "deleted" }); // nothing recorded yet
    finishCreate();
    await expect(start).rejects.toMatchObject({ status: 410 });
    expect(h.tl.assets.size).toBe(0);
    expect(h.blob.blobs.size).toBe(0);
    expect(await store.getJson(KEYS.asset(SID))).toBeNull();
  });

  it("finds an asset whose ID never reached the server or browser by its session tag", async () => {
    const h = harness();
    await registerSession(h.deps, SID);
    h.blob.blobs.set(PATH, clock);
    const original = h.tl.provider.createAssetFromUrl.getMockImplementation()!;
    h.tl.provider.createAssetFromUrl.mockImplementation(async (...args: unknown[]) => {
      await original(...args); // TwelveLabs created it...
      throw new ProviderError("network error", { status: 0, retryable: true }); // ...but the answer was lost
    });
    await expect(startSession(h.deps, { sessionId: SID, pathname: PATH, filename: "clip.mp4" })).rejects.toThrow("network error");
    expect(h.tl.assets.size).toBe(1);
    expect(await endSession(h.deps, { sessionId: SID })).toEqual({ outcome: "deleted" });
    expect(h.tl.assets.size).toBe(0);
  });
});

describe("paginated sweep", () => {
  const OLD = START - 2 * LEGACY_STALE_MS;

  it("finds stale resources beyond the first page and keeps fresh and unrelated ones", async () => {
    const h = harness();
    const stale: string[] = [];
    for (let i = 0; i < 5; i++) stale.push(h.tl.add(`${ASSET_TAG}${sid(i)}--old${i}.mp4`, OLD + i)); // oldest: last page
    const unrelated = h.tl.add("my own footage-session--notes.mov", OLD);
    const legacyRecent = h.tl.add(`${ASSET_TAG}holiday.mov`, START - 60_000);
    const live: string[] = [];
    for (let i = 0; i < 120; i++) {
      await registerSession(h.deps, sid(1000 + i));
      live.push(h.tl.add(`${ASSET_TAG}${sid(1000 + i)}--live.mp4`, START - i));
    }
    for (let i = 0; i < 2300; i++) h.blob.blobs.set(`sessions/${sid(5000 + i)}.mp4`, OLD); // orphaned uploads
    await registerSession(h.deps, sid(9999));
    h.blob.blobs.set(`sessions/${sid(9999)}.mp4`, START);

    const summary = await sweepListings(h.deps);
    expect(summary.assets).toMatchObject({ deleted: 5, complete: true });
    expect(stale.every((id) => !h.tl.assets.has(id))).toBe(true);
    expect(live.every((id) => h.tl.assets.has(id))).toBe(true);
    expect(h.tl.assets.has(legacyRecent)).toBe(true);
    expect(h.tl.assets.has(unrelated)).toBe(true);
    expect(h.tl.provider.deleteAsset).not.toHaveBeenCalledWith(unrelated);
    expect(summary.uploads).toMatchObject({ deleted: 2300, kept: 1, complete: true });
    expect([...h.blob.blobs.keys()]).toEqual([`sessions/${sid(9999)}.mp4`]);
  });

  it("continues from saved progress, so small budgets still reach the oldest pages", async () => {
    const h = harness();
    for (let i = 0; i < 160; i++) {
      await registerSession(h.deps, sid(1000 + i));
      h.tl.add(`${ASSET_TAG}${sid(1000 + i)}--live.mp4`, START - i);
    }
    const stale = h.tl.add(`${ASSET_TAG}${sid(1)}--old.mp4`, OLD);
    for (let i = 0; i < 2500; i++) h.blob.blobs.set(`sessions/${sid(5000 + i)}.mp4`, i === 2499 ? OLD : START);
    for (let i = 0; i < 2499; i++) await registerSession(h.deps, sid(5000 + i));

    const runs = [];
    for (let run = 0; run < 4 && h.tl.assets.has(stale); run++) runs.push(await sweepListings(h.deps, { assetPages: 1, blobPages: 1 }));
    expect(h.tl.assets.has(stale)).toBe(false);
    expect(runs.length).toBe(4); // pages 1, 2, 3, 4 of 161 assets
    // Uploads: three single-page runs reach the last page.
    for (let run = 0; run < 3; run++) await sweepListings(h.deps, { assetPages: 0, blobPages: 1 });
    expect(h.blob.blobs.has(`sessions/${sid(7499)}.mp4`)).toBe(false);
    expect(h.blob.blobs.size).toBe(2499);
  });

  it("keeps failed listings and deletions retryable", async () => {
    const h = harness();
    for (let i = 0; i < 60; i++) {
      await registerSession(h.deps, sid(1000 + i));
      h.tl.add(`${ASSET_TAG}${sid(1000 + i)}--live.mp4`, START - i);
    }
    const stale = h.tl.add(`${ASSET_TAG}${sid(1)}--old.mp4`, OLD);
    const list = h.tl.provider.listAssets.getMockImplementation()!;
    h.tl.provider.listAssets.mockImplementation(async (query: { page: number }) => {
      if (query.page === 2) throw new ProviderError("TwelveLabs 502", { status: 502, retryable: true });
      return list(query);
    });
    expect((await sweepListings(h.deps)).assets).toMatchObject({ failed: 1, complete: false });
    expect(h.tl.assets.has(stale)).toBe(true);
    h.tl.provider.listAssets.mockImplementation(list);
    expect((await sweepListings(h.deps)).assets).toMatchObject({ deleted: 1, complete: true });
    expect(h.tl.assets.has(stale)).toBe(false);

    // Upload deletion fails once: the page is seen again next run.
    h.blob.blobs.set(`sessions/${sid(2)}.mp4`, OLD);
    h.blob.store.remove.mockRejectedValueOnce(new Error("Blob 500"));
    expect((await sweepListings(h.deps)).uploads).toMatchObject({ failed: 1, complete: false });
    expect(h.blob.blobs.size).toBe(1);
    expect((await sweepListings(h.deps)).uploads).toMatchObject({ deleted: 1, complete: true });
    expect(h.blob.blobs.size).toBe(0);
  });

  it("deletes legacy tagged assets (no session ID) only after a day", async () => {
    const h = harness();
    const day = h.tl.add(`${ASSET_TAG}legacy.mov`, START - LEGACY_STALE_MS + 60_000);
    const older = h.tl.add(`${ASSET_TAG}legacy.mov`, START - LEGACY_STALE_MS - 60_000);
    await sweepListings(h.deps);
    expect(h.tl.assets.has(day)).toBe(true);
    expect(h.tl.assets.has(older)).toBe(false);
  });
});
