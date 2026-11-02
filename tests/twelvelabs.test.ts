import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/server/db";
import { dbSettings, getSetting } from "@/lib/server/db";
import { createTwelveLabsProvider, TWELVELABS_BASE_URL } from "@/lib/server/twelvelabs";
import { ProviderError } from "@/lib/server/video-provider";
import { jsonResponse, tempDb, tempDir } from "./helpers";

const API_KEY = "tlk_test_secret_value_123";
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

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
function mockFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body };
    calls.push(call);
    return handler(call);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const marengoIndex = { _id: "idx1", models: [{ model_name: "marengo3.0", model_options: ["visual", "audio"] }] };

describe("TwelveLabs adapter", () => {
  it("restricts search to the selected provider video with the documented filter", async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse({ data: [{ video_id: "vid-A", start: 1.25, end: 4.5, rank: 1, thumbnail_url: "https://thumb" }] }));
    const provider = createTwelveLabsProvider({ apiKey: API_KEY, settings: dbSettings(db), configuredIndexId: null, fetchImpl });
    const items = await provider.search({ indexId: "idx1", providerVideoId: "vid-A", query: "a dog jumps", searchOptions: ["visual", "transcription"], pageLimit: 20, transcriptionOptions: ["lexical"] });
    expect(calls[0].url).toBe(`${TWELVELABS_BASE_URL}/search`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["x-api-key"]).toBe(API_KEY);
    const form = calls[0].body as FormData;
    expect(form.get("index_id")).toBe("idx1");
    expect(form.get("query_text")).toBe("a dog jumps");
    expect(form.getAll("search_options")).toEqual(["visual", "transcription"]);
    expect(form.get("operator")).toBe("or");
    expect(form.getAll("transcription_options")).toEqual(["lexical"]);
    expect(JSON.parse(String(form.get("filter")))).toEqual({ id: ["vid-A"] });
    expect(items).toEqual([{ videoId: "vid-A", start: 1.25, end: 4.5, rank: 1, thumbnailUrl: "https://thumb", transcription: null }]);
  });

  it("creates an index once, persists it, and reuses it afterwards", async () => {
    const { calls, fetchImpl } = mockFetch((call) => {
      if (call.method === "GET" && call.url.includes("/indexes?")) return jsonResponse({ data: [{ _id: "pegasus-only", models: [{ model_name: "pegasus1.2", model_options: ["visual", "audio"] }] }] });
      if (call.method === "POST" && call.url.endsWith("/indexes")) return jsonResponse({ _id: "new-index" }, { status: 201 });
      if (call.url.endsWith("/indexes/new-index")) return jsonResponse({ ...marengoIndex, _id: "new-index" });
      throw new Error(`unexpected ${call.url}`);
    });
    const provider = createTwelveLabsProvider({ apiKey: API_KEY, settings: dbSettings(db), configuredIndexId: null, fetchImpl });
    const [a, b] = await Promise.all([provider.ensureIndex(), provider.ensureIndex()]);
    expect(a.id).toBe("new-index");
    expect(b.id).toBe("new-index");
    const created = calls.filter((c) => c.method === "POST");
    expect(created).toHaveLength(1);
    expect(JSON.parse(String(created[0].body))).toMatchObject({ models: [{ model_name: "marengo3.0", model_options: ["visual", "audio"] }], addons: ["thumbnail"] });
    expect(getSetting(db, "twelvelabs.index_id")).toBe("new-index");

    // A fresh adapter (e.g. after restart) reuses the stored index instead of creating another.
    const second = createTwelveLabsProvider({ apiKey: API_KEY, settings: dbSettings(db), configuredIndexId: null, fetchImpl });
    expect((await second.ensureIndex()).id).toBe("new-index");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("adopts a compatible existing index instead of creating one", async () => {
    const { calls, fetchImpl } = mockFetch((call) => {
      if (call.url.includes("/indexes?")) {
        return jsonResponse({ data: [
          { _id: "visual-only", models: [{ model_name: "marengo3.0", model_options: ["visual"] }], addons: ["thumbnail"] },
          { _id: "no-thumbs", models: [{ model_name: "marengo3.0", model_options: ["visual", "audio"] }], addons: [] },
          { _id: "best", models: [{ model_name: "marengo3.0", model_options: ["visual", "audio"] }], addons: ["thumbnail"] },
        ] });
      }
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });
    const provider = createTwelveLabsProvider({ apiKey: API_KEY, settings: dbSettings(db), configuredIndexId: null, fetchImpl });
    expect(await provider.ensureIndex()).toEqual({ id: "best", searchOptions: ["visual", "transcription", "audio"] });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(getSetting(db, "twelvelabs.index_id")).toBe("best");
  });

  it("uses a configured index and rejects incompatible ones", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ _id: "cfg", models: [{ model_name: "pegasus1.2", model_options: ["visual", "audio"] }] }));
    const provider = createTwelveLabsProvider({ apiKey: API_KEY, settings: dbSettings(db), configuredIndexId: "cfg", fetchImpl });
    await expect(provider.ensureIndex()).rejects.toMatchObject({ code: "index_incompatible", retryable: false });
  });

  it("derives search options from the index model options", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ _id: "v", models: [{ model_name: "marengo3.0", model_options: ["visual"] }] }));
    const provider = createTwelveLabsProvider({ apiKey: API_KEY, settings: dbSettings(db), configuredIndexId: "v", fetchImpl });
    expect((await provider.getIndex("v")).searchOptions).toEqual(["visual"]);
  });

  it("turns 429 into a retryable error with Retry-After and never leaks the key", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ code: "too_many_requests", message: `slow down ${API_KEY}` }, { status: 429, headers: { "retry-after": "17" } }));
    const provider = createTwelveLabsProvider({ apiKey: API_KEY, settings: dbSettings(db), configuredIndexId: null, fetchImpl });
    const error = await provider.search({ indexId: "i", providerVideoId: "v", query: "q", searchOptions: ["visual"], pageLimit: 5 }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(17);
    expect(error.code).toBe("too_many_requests");
    expect(error.message).not.toContain(API_KEY);
  });

  it("treats 4xx validation errors as permanent and network failures as temporary", async () => {
    const bad = createTwelveLabsProvider({ apiKey: API_KEY, settings: dbSettings(db), configuredIndexId: null, fetchImpl: mockFetch(() => jsonResponse({ code: "parameter_invalid", message: "nope" }, { status: 400 })).fetchImpl });
    await expect(bad.getAsset("a")).rejects.toMatchObject({ retryable: false, status: 400 });
    const offline = createTwelveLabsProvider({ apiKey: API_KEY, settings: dbSettings(db), configuredIndexId: null, fetchImpl: mockFetch(() => { throw new TypeError("fetch failed"); }).fetchImpl });
    await expect(offline.getAsset("a")).rejects.toMatchObject({ retryable: true });
  });

  it("reports not-found deletions honestly", async () => {
    const provider = createTwelveLabsProvider({ apiKey: API_KEY, settings: dbSettings(db), configuredIndexId: null, fetchImpl: mockFetch(() => jsonResponse({ code: "resource_not_exist", message: "gone" }, { status: 400 })).fetchImpl });
    expect(await provider.deleteAsset("a")).toBe("not_found");
    const ok = createTwelveLabsProvider({ apiKey: API_KEY, settings: dbSettings(db), configuredIndexId: null, fetchImpl: mockFetch(() => new Response(null, { status: 204 })).fetchImpl });
    expect(await ok.deleteAsset("a")).toBe("deleted");
    const failing = createTwelveLabsProvider({ apiKey: API_KEY, settings: dbSettings(db), configuredIndexId: null, fetchImpl: mockFetch(() => jsonResponse({ message: "boom" }, { status: 500 })).fetchImpl });
    await expect(failing.deleteAsset("a")).rejects.toBeInstanceOf(ProviderError);
  });

  it("uploads small files directly as multipart/form-data", async () => {
    const file = path.join(dir.dir, "clip.mp4");
    writeFileSync(file, Buffer.alloc(2048, 1));
    const { calls, fetchImpl } = mockFetch(() => jsonResponse({ _id: "asset-1", status: "processing" }, { status: 201 }));
    const provider = createTwelveLabsProvider({ apiKey: API_KEY, settings: dbSettings(db), configuredIndexId: null, fetchImpl });
    expect(await provider.uploadAsset({ path: file, sizeBytes: 2048, filename: "clip.mp4", mimeType: "video/mp4" })).toEqual({ assetId: "asset-1" });
    const form = calls[0].body as FormData;
    expect(calls[0].url).toBe(`${TWELVELABS_BASE_URL}/assets`);
    expect(form.get("method")).toBe("direct");
    expect((form.get("file") as File).size).toBe(2048);
  });

  it("uploads large files in chunks with ETag proofs (multipart workflow)", async () => {
    const file = path.join(dir.dir, "big.mp4");
    const size = 250_000_000;
    // Sparse file: no 250 MB allocation in memory.
    const { openSync, ftruncateSync, closeSync } = await import("node:fs");
    const fd = openSync(file, "w");
    ftruncateSync(fd, size);
    closeSync(fd);
    const chunkSize = 100_000_000;
    const puts: { url: string; size: number }[] = [];
    const { calls, fetchImpl } = mockFetch(async (call) => {
      if (call.url.endsWith("/assets/multipart-uploads") && call.method === "POST") {
        return jsonResponse({ upload_id: "up1", asset_id: "asset-big", chunk_size: chunkSize, total_chunks: 3, upload_urls: [1, 2].map((i) => ({ chunk_index: i, url: `https://s3/part${i}` })) }, { status: 201 });
      }
      if (call.url.endsWith("/presigned-urls")) return jsonResponse({ upload_urls: [{ chunk_index: 3, url: "https://s3/part3" }] });
      if (call.url.startsWith("https://s3/")) {
        puts.push({ url: call.url, size: (call.body as Blob).size });
        return new Response(null, { status: 200, headers: { etag: `"etag-${puts.length}"` } });
      }
      if (call.url.endsWith("/assets/multipart-uploads/up1") && call.method === "POST") return jsonResponse({ total_completed: 3 });
      if (call.url.includes("/assets/multipart-uploads/up1")) return jsonResponse({ status: "completed" });
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });
    const provider = createTwelveLabsProvider({ apiKey: API_KEY, settings: dbSettings(db), configuredIndexId: null, fetchImpl, sleep: async () => {} });
    const result = await provider.uploadAsset({ path: file, sizeBytes: size, filename: "big.mp4", mimeType: "video/mp4" });
    expect(result).toEqual({ assetId: "asset-big" });
    expect(puts.map((p) => p.size)).toEqual([100_000_000, 100_000_000, 50_000_000]);
    const report = calls.find((c) => c.url.endsWith("/assets/multipart-uploads/up1") && c.method === "POST");
    expect(JSON.parse(String(report!.body)).completed_chunks).toEqual([
      { chunk_index: 1, proof: "etag-1", proof_type: "etag", chunk_size: 100_000_000 },
      { chunk_index: 2, proof: "etag-2", proof_type: "etag", chunk_size: 100_000_000 },
      { chunk_index: 3, proof: "etag-3", proof_type: "etag", chunk_size: 50_000_000 },
    ]);
    // The API key is only sent to TwelveLabs, never to the presigned storage URLs.
    expect(calls.filter((c) => c.url.startsWith("https://s3/")).every((c) => !("x-api-key" in c.headers))).toBe(true);
  });
});
