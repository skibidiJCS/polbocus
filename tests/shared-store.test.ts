import { describe, expect, it } from "vitest";
import { fileStore, getSharedStore, memoryStore, StoreError, WriteConflict, type FileOps } from "@/lib/server/shared-store";

/**
 * In-memory files with the same conditional-write rules as Vercel Blob (ifMatch / create).
 * Every call yields to the event loop, so concurrent callers interleave like separate instances.
 */
function fakeFiles(now: () => number = Date.now) {
  const files = new Map<string, { text: string; etag: string; uploadedAt: number }>();
  let version = 0;
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
  const ops: FileOps = {
    async read(pathname) {
      await tick();
      const file = files.get(pathname);
      return file ? { text: file.text, etag: file.etag } : null;
    },
    async write(pathname, text, condition) {
      await tick();
      const current = files.get(pathname);
      if (condition && "ifMatch" in condition && current?.etag !== condition.ifMatch) throw new WriteConflict();
      if (condition && "create" in condition && current) throw new WriteConflict();
      files.set(pathname, { text, etag: `"v${++version}"`, uploadedAt: now() });
    },
    async remove(pathname) {
      await tick();
      files.delete(pathname);
    },
    async list(prefix) {
      return [...files.entries()].filter(([p]) => p.startsWith(prefix)).map(([pathname, f]) => ({ pathname, uploadedAt: new Date(f.uploadedAt) }));
    },
  };
  return { ops, files };
}

describe("Blob-backed store", () => {
  it("never loses a hit when instances count concurrently", async () => {
    const { ops } = fakeFiles();
    const instances = [fileStore(ops), fileStore(ops), fileStore(ops)];
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => instances[i % 3].hit("login:global", 900_000)));
    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("starts the window at the first hit and resets it after expiry", async () => {
    let now = 1_000;
    const { ops } = fakeFiles(() => now);
    const store = fileStore(ops, () => now);
    expect(await store.hit("k", 1000)).toEqual({ count: 1, resetInMs: 1000 });
    now += 400;
    expect(await store.hit("k", 1000)).toEqual({ count: 2, resetInMs: 600 });
    now += 600;
    expect(await store.hit("k", 1000)).toEqual({ count: 1, resetInMs: 1000 });
  });

  it("keeps the due queue consistent under concurrent updates", async () => {
    const { ops } = fakeFiles();
    const [a, b] = [fileStore(ops), fileStore(ops)];
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).zadd("sessions:due", i, `s${i}`)));
    expect(await a.zdue("sessions:due", 100, 100)).toEqual(Array.from({ length: 10 }, (_, i) => `s${i}`));
    await Promise.all([a.zrem("sessions:due", "s0"), b.zrem("sessions:due", "s5"), a.zadd("sessions:due", 50, "s9")]);
    expect(await b.zdue("sessions:due", 9, 100)).toEqual(["s1", "s2", "s3", "s4", "s6", "s7", "s8"]);
  });

  it("stores values under state/, honours TTLs and treats deletes as idempotent", async () => {
    let now = 0;
    const { ops, files } = fakeFiles(() => now);
    const store = fileStore(ops, () => now);
    await store.setJson("session:abc:seen", 42, 1000);
    expect([...files.keys()]).toEqual(["state/session/abc/seen.json"]);
    expect(await store.getJson("session:abc:seen")).toBe(42);
    now = 1000;
    expect(await store.getJson("session:abc:seen")).toBeNull();
    await store.del("session:abc:seen");
    await store.del("session:abc:seen");
    expect(files.size).toBe(0);
  });

  it("treats a failed create as a lost race when the file appeared meanwhile", async () => {
    const { ops } = fakeFiles();
    let first = true;
    const store = fileStore({
      ...ops,
      write: async (pathname, text, condition) => {
        if (first && condition && "create" in condition) {
          first = false;
          await ops.write(pathname, JSON.stringify({ value: 1, expiresAt: null })); // another instance won
          throw new Error("Vercel Blob: This blob already exists"); // generic error, as Blob reports it
        }
        return ops.write(pathname, text, condition);
      },
    });
    expect((await store.hit("k", 60_000)).count).toBe(2);
  });

  it("gives up with an error instead of looping forever when writes keep conflicting", async () => {
    const { ops } = fakeFiles();
    const store = fileStore({ ...ops, write: async () => { throw new WriteConflict(); } });
    await expect(store.hit("k", 1000)).rejects.toBeInstanceOf(StoreError);
  });

  it("prunes old attempt counters only", async () => {
    let now = 0;
    const { ops, files } = fakeFiles(() => now);
    const store = fileStore(ops, () => now);
    await store.hit("login:source:abc", 1000);
    await store.setJson("session:x", { id: "x" });
    now = 2 * 24 * 60 * 60_000;
    expect(await store.prune!()).toBe(1);
    expect([...files.keys()]).toEqual(["state/session/x.json"]);
  });

  it("is required on Vercel (from the Blob connection) and in-memory locally", () => {
    expect(getSharedStore({ VERCEL: "1" })).toBeNull();
    expect(getSharedStore({ VERCEL: "1", BLOB_STORE_ID: "store_x", BLOB_WEBHOOK_PUBLIC_KEY: "k" })?.durable).toBe(true);
    expect(getSharedStore({})?.durable).toBe(false);
  });
});

describe("memory store", () => {
  it("expires windows and orders the due queue", async () => {
    let now = 0;
    const store = memoryStore(() => now);
    expect((await store.hit("k", 1000)).count).toBe(1);
    expect(await store.hit("k", 1000)).toEqual({ count: 2, resetInMs: 1000 });
    now = 1000;
    expect((await store.hit("k", 1000)).count).toBe(1);
    await store.zadd("q", 5, "late");
    await store.zadd("q", 1, "early");
    expect(await store.zdue("q", 5, 10)).toEqual(["early", "late"]);
  });
});
