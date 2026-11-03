import "server-only";
import { BlobNotFoundError, BlobPreconditionFailedError, del, get, list, put } from "@vercel/blob";

/**
 * Small key-value store shared by every serverless instance of the hosted app. It holds
 * only metadata: login attempt counters, which temporary uploads and TwelveLabs assets a
 * session created, and cleanup progress. No footage.
 *
 * Production keeps it as small JSON files under state/ in the project's private Vercel Blob
 * store, so no extra service is needed. Every read bypasses the CDN cache, and every
 * read-modify-write is a compare-and-swap on the file's ETag, so counters stay exact when
 * several instances write at once. The in-memory version is for tests and for trying hosted
 * mode locally; it is never used on Vercel, where each instance would get its own copy.
 */
export interface SharedStore {
  readonly durable: boolean;
  /** Atomically counts a hit in a fixed window that starts with the first hit. */
  hit(key: string, windowMs: number): Promise<{ count: number; resetInMs: number }>;
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Sorted set helpers used as a due-date queue. */
  zadd(key: string, score: number, member: string): Promise<void>;
  zrem(key: string, member: string): Promise<void>;
  zdue(key: string, maxScore: number, limit: number): Promise<string[]>;
  /** Removes expired entries left behind (e.g. old attempt counters). */
  prune?(): Promise<number>;
}

export class StoreError extends Error {}

/** The few file operations the Blob-backed store needs (swappable in tests). */
export interface FileOps {
  read(pathname: string): Promise<{ text: string; etag: string } | null>;
  /** `ifMatch`: replace only that version. `create`: fail if the file exists. Otherwise overwrite. */
  write(pathname: string, text: string, condition?: { ifMatch: string } | { create: true }): Promise<void>;
  remove(pathname: string): Promise<void>;
  list(prefix: string): Promise<{ pathname: string; uploadedAt: Date }[]>;
}

/** Thrown by FileOps.write when the condition does not hold (someone else wrote first). */
export class WriteConflict extends Error {}

const STATE_PREFIX = "state/";
const MAX_CAS_ATTEMPTS = 8;

interface Entry<T = unknown> {
  value: T;
  expiresAt: number | null;
}

export function blobFileOps(): FileOps {
  return {
    async read(pathname) {
      const result = await get(pathname, { access: "private", useCache: false });
      if (!result || result.statusCode !== 200) return null;
      return { text: await new Response(result.stream).text(), etag: result.blob.etag };
    },
    async write(pathname, text, condition) {
      const options = {
        access: "private" as const,
        contentType: "application/json",
        addRandomSuffix: false,
        cacheControlMaxAge: 60,
        ...(condition && "ifMatch" in condition ? { ifMatch: condition.ifMatch } : condition ? { allowOverwrite: false } : { allowOverwrite: true }),
      };
      try {
        await put(pathname, text, options);
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) throw new WriteConflict();
        throw error;
      }
    },
    async remove(pathname) {
      try {
        await del(pathname);
      } catch (error) {
        if (!(error instanceof BlobNotFoundError)) throw error;
      }
    },
    async list(prefix) {
      const out: { pathname: string; uploadedAt: Date }[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix, cursor, limit: 1000 });
        out.push(...page.blobs.map((blob) => ({ pathname: blob.pathname, uploadedAt: new Date(blob.uploadedAt) })));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
  };
}

/** "session:<id>:seen" → "state/session/<id>/seen.json" */
const pathOf = (key: string) => `${STATE_PREFIX}${key.replace(/[^A-Za-z0-9._-]+/g, "/")}.json`;

export function fileStore(ops: FileOps, now: () => number = Date.now): SharedStore {
  async function readEntry<T>(key: string) {
    const file = await ops.read(pathOf(key));
    if (!file) return { entry: null as Entry<T> | null, etag: null as string | null };
    try {
      const entry = JSON.parse(file.text) as Entry<T>;
      const live = entry.expiresAt === null || entry.expiresAt > now();
      return { entry: live ? entry : null, etag: file.etag };
    } catch {
      return { entry: null, etag: file.etag };
    }
  }

  /** Compare-and-swap loop: re-reads and retries when another instance wrote in between. */
  async function update<T, R>(key: string, change: (current: Entry<T> | null) => { next: Entry<T> | null; result: R }): Promise<R> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const { entry, etag } = await readEntry<T>(key);
      const { next, result } = change(entry);
      try {
        if (next === null) {
          if (etag) await ops.remove(pathOf(key));
        } else {
          await ops.write(pathOf(key), JSON.stringify(next), etag ? { ifMatch: etag } : { create: true });
        }
        return result;
      } catch (error) {
        // A failed create counts as a lost race if the file exists now (Blob reports an
        // existing pathname as a generic error, not a precondition failure).
        const lostCreate = !etag && next !== null && (await ops.read(pathOf(key)).catch(() => null)) !== null;
        if (!(error instanceof WriteConflict) && !lostCreate) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40 * (attempt + 1)));
      }
    }
    throw new StoreError("The shared store is busy; try again.");
  }

  return {
    durable: true,
    hit(key, windowMs) {
      return update<number, { count: number; resetInMs: number }>(key, (current) => {
        const expiresAt = current?.expiresAt ?? now() + windowMs;
        const count = (current?.value ?? 0) + 1;
        return { next: { value: count, expiresAt }, result: { count, resetInMs: Math.max(0, expiresAt - now()) } };
      });
    },
    async getJson<T>(key: string) {
      return (await readEntry<T>(key)).entry?.value ?? null;
    },
    async setJson(key, value, ttlMs) {
      await ops.write(pathOf(key), JSON.stringify({ value, expiresAt: ttlMs ? now() + ttlMs : null } satisfies Entry));
    },
    async del(key) {
      await ops.remove(pathOf(key));
    },
    zadd(key, score, member) {
      return update<Record<string, number>, void>(key, (current) => ({ next: { value: { ...(current?.value ?? {}), [member]: score }, expiresAt: null }, result: undefined }));
    },
    zrem(key, member) {
      return update<Record<string, number>, void>(key, (current) => {
        if (!current || !(member in current.value)) return { next: current, result: undefined };
        const rest = { ...current.value };
        delete rest[member];
        return { next: { value: rest, expiresAt: null }, result: undefined };
      });
    },
    async zdue(key, maxScore, limit) {
      const members = (await readEntry<Record<string, number>>(key)).entry?.value ?? {};
      return Object.entries(members).filter(([, score]) => score <= maxScore).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([member]) => member);
    },
    async prune() {
      // Attempt counters expire after minutes; anything a day old is safe to remove.
      const stale = (await ops.list(`${STATE_PREFIX}login/`)).filter((file) => now() - file.uploadedAt.getTime() > 24 * 60 * 60_000);
      for (const file of stale) await ops.remove(file.pathname);
      return stale.length;
    },
  };
}

export function memoryStore(now: () => number = Date.now): SharedStore {
  const values = new Map<string, { value: string; expires: number | null }>();
  const sets = new Map<string, Map<string, number>>();
  const read = (key: string) => {
    const entry = values.get(key);
    if (entry && entry.expires !== null && entry.expires <= now()) {
      values.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    durable: false,
    async hit(key, windowMs) {
      const entry = read(key);
      const next = { value: String(Number(entry?.value ?? 0) + 1), expires: entry?.expires ?? now() + windowMs };
      values.set(key, next);
      return { count: Number(next.value), resetInMs: Math.max(0, (next.expires ?? now()) - now()) };
    },
    async getJson<T>(key: string) {
      const entry = read(key);
      return entry ? (JSON.parse(entry.value) as T) : null;
    },
    async setJson(key, value, ttlMs) {
      values.set(key, { value: JSON.stringify(value), expires: ttlMs ? now() + ttlMs : null });
    },
    async del(key) {
      values.delete(key);
    },
    async zadd(key, score, member) {
      if (!sets.has(key)) sets.set(key, new Map());
      sets.get(key)!.set(member, score);
    },
    async zrem(key, member) {
      sets.get(key)?.delete(member);
    },
    async zdue(key, maxScore, limit) {
      return [...(sets.get(key) ?? new Map<string, number>()).entries()]
        .filter(([, score]) => score <= maxScore)
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit)
        .map(([member]) => member);
    },
  };
}

let local: SharedStore | null = null;

/**
 * The store for this deployment: the private Blob store on Vercel, or null when none is
 * connected (the page then shows setup instructions). Locally, an in-memory store.
 */
export function getSharedStore(env: Record<string, string | undefined> = process.env): SharedStore | null {
  if (env.VERCEL) {
    const blobConnected = Boolean((env.BLOB_STORE_ID && env.BLOB_WEBHOOK_PUBLIC_KEY) || env.BLOB_READ_WRITE_TOKEN);
    return blobConnected ? fileStore(blobFileOps()) : null;
  }
  local ??= memoryStore();
  return local;
}
