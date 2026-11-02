import "server-only";
import { getServerConfig } from "./config";
import { getDb } from "./db";
import { createTwelveLabsProvider } from "./twelvelabs";
import type { VideoProvider } from "./video-provider";
import { createWorker, type Worker } from "./worker";

// Identifies this copy of the module. A dev hot reload loads a new copy, and the
// worker kept on globalThis is replaced so it never runs stale provider code.
// Job leases in SQLite keep the old and new worker from running the same job.
const moduleToken = Symbol("runtime");

const globalRuntime = globalThis as typeof globalThis & {
  __footageWorker?: { token: symbol; worker: Worker };
};

let cachedProvider: { key: string; provider: VideoProvider } | null = null;

/** Returns null when TWELVELABS_API_KEY is not configured. */
export function getProvider(): VideoProvider | null {
  const config = getServerConfig();
  if (!config.apiKey) return null;
  const cacheKey = `${config.apiKey.length}:${config.apiKey.slice(-4)}:${config.indexId ?? ""}`;
  if (cachedProvider?.key !== cacheKey) {
    cachedProvider = {
      key: cacheKey,
      provider: createTwelveLabsProvider({ apiKey: config.apiKey, db: getDb(), configuredIndexId: config.indexId }),
    };
  }
  return cachedProvider.provider;
}

/** One background worker per server process; it resumes persisted jobs on start. */
export function getWorker(): Worker {
  const current = globalRuntime.__footageWorker;
  if (current?.token === moduleToken) return current.worker;
  current?.worker.stop();
  const config = getServerConfig();
  const worker = createWorker({ db: getDb(), getProvider, videosDir: config.videosDir, tmpDir: config.tmpDir });
  worker.start();
  globalRuntime.__footageWorker = { token: moduleToken, worker };
  return worker;
}
