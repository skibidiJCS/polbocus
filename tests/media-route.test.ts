import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

const dir = tempDir();
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
let GET: (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let HEAD: typeof GET;

beforeAll(async () => {
  process.env.DATA_DIR = dir.dir;
  delete process.env.TWELVELABS_API_KEY;
  const { getDb } = await import("@/lib/server/db");
  const { insertQueuedVideo } = await import("@/lib/server/videos-repo");
  const db = getDb();
  const storageName = "00000000-0000-4000-8000-000000000001.mp4";
  mkdirSync(path.join(dir.dir, "videos"), { recursive: true });
  writeFileSync(path.join(dir.dir, "videos", storageName), bytes);
  insertQueuedVideo(db, { id: "vid", originalName: "a.mp4", storageName, sha256: "s", sizeBytes: bytes.length, mimeType: "video/mp4" });
  const route = await import("@/app/api/videos/[id]/media/route");
  GET = route.GET as unknown as typeof GET;
  HEAD = route.HEAD as unknown as typeof GET;
});
afterAll(() => dir.cleanup());

const ctx = (id = "vid") => ({ params: Promise.resolve({ id }) });
const req = (headers: Record<string, string> = {}, method = "GET") => new Request("http://127.0.0.1:3000/api/videos/vid/media", { method, headers: { host: "127.0.0.1:3000", ...headers } });

describe("GET /api/videos/:id/media", () => {
  it("serves the whole file with Accept-Ranges", async () => {
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("serves byte ranges with 206 and Content-Range", async () => {
    const res = await GET(req({ range: "bytes=100-199" }), ctx());
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(res.headers.get("content-length")).toBe("100");
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(100, 200))).toBe(true);
    const tail = await GET(req({ range: "bytes=-10" }), ctx());
    expect(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(990))).toBe(true);
  });

  it("returns 416 for unsatisfiable ranges, 404 for unknown ids, and no body for HEAD", async () => {
    const res = await GET(req({ range: "bytes=5000-" }), ctx());
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1000");
    expect((await GET(req(), ctx("nope"))).status).toBe(404);
    const head = await HEAD(req({}, "HEAD"), ctx());
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("1000");
    expect(head.body).toBeNull();
  });

  it("rejects requests addressed to non-local hosts", async () => {
    const res = await GET(req({ host: "evil.example" }), ctx());
    expect(res.status).toBe(403);
  });
});
