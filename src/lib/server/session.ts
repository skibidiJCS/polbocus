import "server-only";
import type { BlobStore } from "./blob-store";
import { ServiceError } from "./errors";
import { ACCEPTED_FORMATS_LABEL, detectContainer } from "./media";
import type { SharedStore } from "./shared-store";
import { isNotFound, type VideoProvider } from "./video-provider";

/**
 * One-time sessions (hosted mode).
 *
 * The footage itself is only held by the private Vercel Blob store (until TwelveLabs has
 * fetched it) and by TwelveLabs (until the session ends). The shared store keeps a small
 * record per session naming those resources, so they can be deleted even when the browser
 * never says goodbye.
 *
 * Retention policy:
 * - Leaving the page or choosing "New video" deletes everything right away (best effort).
 * - An open page sends a heartbeat every few minutes. A session with no heartbeat for
 *   IDLE_TIMEOUT_MS is abandoned and deleted by the next cleanup run (the scheduled
 *   job, or a later visit). Age alone never ends an active session.
 * - Failed deletions are retried with backoff, up to CLEANUP_MAX_ATTEMPTS times, then
 *   logged as failed; the scheduled listing sweep keeps retrying their resources.
 */
export const BLOB_PREFIX = "sessions/";
// TwelveLabs asset filenames: footage-session--<session id>--<original name>
export const ASSET_TAG = "footage-session--";
export const SESSION_MAX_BYTES = 4_000_000_000;
export const HEARTBEAT_MS = 5 * 60_000;
export const IDLE_TIMEOUT_MS = 30 * 60_000;
/** Resources whose session record is already gone (e.g. an upload that finished after the session ended). */
export const ORPHAN_GRACE_MS = 60 * 60_000;
/** Tagged resources from before session records existed carry no session ID. */
export const LEGACY_STALE_MS = 24 * 60 * 60_000;
export const CLEANUP_MAX_ATTEMPTS = 8;
export const ASSET_PAGE_LIMIT = 50;
export const BLOB_PAGE_LIMIT = 1000;
const FETCH_URL_LIFETIME_MS = 2 * 60 * 60_000;
const RECORD_TTL_MS = 30 * 24 * 60 * 60_000;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_ID = new RegExp(`^${UUID}$`);
const PROVIDER_ID = /^[a-f0-9]{24}$/;
const BLOB_PATH = new RegExp(`^sessions/(${UUID})(-[A-Za-z0-9]+)?\\.(mp4|mov|m4v|webm|mkv)$`);
const TAGGED_ASSET = new RegExp(`^${ASSET_TAG}(${UUID})--`);
export const ALLOWED_UPLOAD_TYPES = ["video/mp4", "video/quicktime", "video/x-m4v", "video/webm", "video/x-matroska"];

export const KEYS = {
  record: (id: string) => `session:${id}`,
  seen: (id: string) => `session:${id}:seen`,
  asset: (id: string) => `session:${id}:asset`,
  due: "sessions:due",
  assetSweep: "sweep:assets",
  blobSweep: "sweep:blobs",
};

/**
 * State, last heartbeat and resource IDs live under separate keys so a heartbeat or a
 * start request can never overwrite an "ending" state written at the same moment.
 */
export interface SessionRecord {
  id: string;
  state: "active" | "ending" | "failed";
  createdAt: number;
  cleanup?: { attempts: number; lastError: string | null; nextAttemptAt: number | null };
}

/** Written by the server as soon as TwelveLabs answers, never by the browser. */
export interface SessionAsset {
  assetId: string;
  indexId: string;
  pathname: string;
  indexedAssetId?: string;
}

export interface SessionDeps {
  provider: VideoProvider;
  blob: BlobStore;
  store: SharedStore;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
}

const defaultLog: NonNullable<SessionDeps["log"]> = (level, message, detail) => console[level](`[session-cleanup] ${message}`, detail ?? "");

export function assertProviderId(value: unknown, label: string): string {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) throw new ServiceError(`Invalid ${label}.`, 400);
  return value;
}

export function assertSessionId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID.test(value)) throw new ServiceError("Invalid session.", 400);
  return value;
}

export function isSessionBlobPath(value: unknown): value is string {
  return typeof value === "string" && BLOB_PATH.test(value);
}

export function sessionIdOfPath(pathname: string): string | null {
  return BLOB_PATH.exec(pathname)?.[1] ?? null;
}

export function sessionIdOfAsset(filename: string | null): string | null {
  return filename ? (TAGGED_ASSET.exec(filename)?.[1] ?? null) : null;
}

export function taggedFilename(sessionId: string, original: string) {
  const clean = original.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, 120) || "video";
  return `${ASSET_TAG}${sessionId}--${clean}`;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const ended = () => new ServiceError("This session has ended. Start a new one.", 410);

/** Creates the record before any upload is allowed, so every resource has an owner on file. */
export async function registerSession(deps: Pick<SessionDeps, "store" | "now">, sessionId: string) {
  const now = (deps.now ?? Date.now)();
  const existing = await deps.store.getJson<SessionRecord>(KEYS.record(sessionId));
  if (existing && existing.state !== "active") throw ended();
  if (!existing) {
    await deps.store.setJson(KEYS.record(sessionId), { id: sessionId, state: "active", createdAt: now } satisfies SessionRecord, RECORD_TTL_MS);
  }
  await heartbeat(deps, sessionId, now, true);
}

// Status polls arrive every few seconds; recording a heartbeat that often would only cost
// store writes. Each instance records one at most every HEARTBEAT_WRITE_MS per session.
const HEARTBEAT_WRITE_MS = 2 * 60_000;
const lastHeartbeatWrite = new Map<string, number>();

async function heartbeat(deps: Pick<SessionDeps, "store">, sessionId: string, now: number, force = false) {
  const last = lastHeartbeatWrite.get(sessionId);
  if (!force && last !== undefined && now - last < HEARTBEAT_WRITE_MS && now >= last) return;
  lastHeartbeatWrite.set(sessionId, now);
  if (lastHeartbeatWrite.size > 1000) lastHeartbeatWrite.delete(lastHeartbeatWrite.keys().next().value!);
  await deps.store.setJson(KEYS.seen(sessionId), now, RECORD_TTL_MS);
  await deps.store.zadd(KEYS.due, now + IDLE_TIMEOUT_MS, sessionId);
}

/** Marks the session as in use. Throws 410 when it has ended (or never existed). */
export async function touchSession(deps: Pick<SessionDeps, "store" | "now">, sessionId: string) {
  const record = await deps.store.getJson<SessionRecord>(KEYS.record(sessionId));
  if (!record || record.state !== "active") throw ended();
  await heartbeat(deps, sessionId, (deps.now ?? Date.now)());
  return record;
}

export async function getSessionAsset(deps: Pick<SessionDeps, "store">, sessionId: string) {
  return deps.store.getJson<SessionAsset>(KEYS.asset(sessionId));
}

/** Validates the uploaded blob and asks TwelveLabs to fetch it. */
export async function startSession(deps: SessionDeps, input: { sessionId: unknown; pathname: unknown; filename: unknown }) {
  const sessionId = assertSessionId(input.sessionId);
  if (!isSessionBlobPath(input.pathname) || sessionIdOfPath(input.pathname) !== sessionId) throw new ServiceError("Unknown upload.", 400);
  const pathname = input.pathname;
  const filename = typeof input.filename === "string" ? input.filename : "video";
  const now = deps.now ?? Date.now;
  await touchSession(deps, sessionId);

  // Look up the index while the upload is checked; the two don't depend on each other.
  const indexLookup = deps.provider.ensureIndex();
  indexLookup.catch(() => {});
  const info = await deps.blob.head(pathname);
  if (!info) throw new ServiceError("The upload could not be found. Try again.", 404);
  if (info.size > SESSION_MAX_BYTES) {
    await deps.blob.remove([pathname]);
    throw new ServiceError("Videos can be up to 4 GB.", 413);
  }
  // Trust the bytes, not the name or browser-reported type.
  if (!detectContainer(await deps.blob.readStart(pathname, 64))) {
    await deps.blob.remove([pathname]);
    throw new ServiceError(`That file isn’t a supported video. Use ${ACCEPTED_FORMATS_LABEL}.`, 415);
  }

  const index = await indexLookup;
  const url = await deps.blob.presignGet(pathname, now() + FETCH_URL_LIFETIME_MS);
  // Deliberately not tied to the browser request: if the page cancels mid-call, the asset
  // is still recorded below and deleted, rather than existing with an ID nobody received.
  // Its filename carries the session ID as well, so even an unrecorded asset is findable.
  const { assetId } = await deps.provider.createAssetFromUrl(url, taggedFilename(sessionId, filename));
  await deps.store.setJson(KEYS.asset(sessionId), { assetId, indexId: index.id, pathname } satisfies SessionAsset, RECORD_TTL_MS);

  // The asset is written before the state is re-read, and endSession writes the state
  // before reading the asset, so whichever request runs second deletes it.
  const record = await deps.store.getJson<SessionRecord>(KEYS.record(sessionId));
  if (!record || record.state !== "active") {
    await cleanupSession(deps, sessionId);
    throw ended();
  }
  return { assetId, indexId: index.id, sizeBytes: info.size };
}

export type SessionStatus =
  | { stage: "processing" }
  | { stage: "indexing"; providerStatus: string; durationSeconds: number | null }
  | { stage: "ready"; durationSeconds: number | null }
  | { stage: "failed"; message: string };

/**
 * Moves a session one step forward. The browser calls this while the page is open;
 * TwelveLabs does the actual work, so no background process is needed.
 */
export async function advanceSession(deps: SessionDeps, input: { sessionId: unknown }, signal?: AbortSignal): Promise<SessionStatus> {
  const sessionId = assertSessionId(input.sessionId);
  await touchSession(deps, sessionId);
  const asset = await getSessionAsset(deps, sessionId);
  if (!asset) throw new ServiceError("This session has no video yet.", 409);

  if (asset.indexedAssetId) {
    const state = await deps.provider.getIndexedAsset(asset.indexId, asset.indexedAssetId, signal);
    if (state.status === "ready") return { stage: "ready", durationSeconds: state.durationSeconds };
    if (state.status === "failed") return { stage: "failed", message: state.message };
    return { stage: "indexing", providerStatus: state.providerStatus, durationSeconds: state.durationSeconds };
  }

  const state = await deps.provider.getAsset(asset.assetId, signal);
  if (state.status === "processing") return { stage: "processing" };
  // TwelveLabs has its own copy (or gave up): the temporary upload is no longer needed.
  await deps.blob.remove([asset.pathname]).catch(() => {});
  if (state.status === "failed") return { stage: "failed", message: state.message };
  // Reuse an indexed asset if an earlier call created one but its response was lost.
  const existing = await deps.provider.findIndexedAssets(asset.assetId, asset.indexId, signal);
  const indexedAssetId = existing[0] ?? (await deps.provider.indexAsset(asset.indexId, asset.assetId, signal)).indexedAssetId;
  await deps.store.setJson(KEYS.asset(sessionId), { ...asset, indexedAssetId } satisfies SessionAsset, RECORD_TTL_MS);
  return { stage: "indexing", providerStatus: "pending", durationSeconds: state.durationSeconds };
}

export type CleanupOutcome =
  | { outcome: "deleted" }
  | { outcome: "retrying"; attempts: number; nextAttemptAt: number; error: string }
  | { outcome: "failed"; attempts: number; error: string };

export function cleanupBackoffMs(attempts: number) {
  return Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

async function removeBlobsWithPrefix(blob: BlobStore, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await blob.list(prefix, { cursor, limit: BLOB_PAGE_LIMIT });
    if (page.blobs.length) await blob.remove(page.blobs.map((entry) => entry.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}

/**
 * Deletes everything a session created. Idempotent: resources already gone count as
 * deleted, and a missing record means there is nothing left to track.
 */
export async function cleanupSession(deps: SessionDeps, sessionId: string): Promise<CleanupOutcome> {
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? defaultLog;
  const record = await deps.store.getJson<SessionRecord>(KEYS.record(sessionId));
  try {
    await removeBlobsWithPrefix(deps.blob, `${BLOB_PREFIX}${sessionId}`);
    const asset = await getSessionAsset(deps, sessionId);
    const assetIds = new Set<string>(asset ? [asset.assetId] : []);
    // Also finds an asset whose ID was never recorded (the server stopped mid-request).
    const tagged = await deps.provider.listAssets({ page: 1, pageLimit: ASSET_PAGE_LIMIT, filename: `${ASSET_TAG}${sessionId}--` });
    for (const item of tagged.items) if (sessionIdOfAsset(item.filename) === sessionId) assetIds.add(item.id);
    for (const assetId of assetIds) {
      try {
        // force=true also removes the indexed asset that references it.
        await deps.provider.deleteAsset(assetId);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    await deps.store.del(KEYS.asset(sessionId));
    await deps.store.del(KEYS.seen(sessionId));
    await deps.store.del(KEYS.record(sessionId));
    await deps.store.zrem(KEYS.due, sessionId);
    if (record) log("info", "Session deleted", { sessionId, assets: assetIds.size });
    return { outcome: "deleted" };
  } catch (error) {
    const attempts = (record?.cleanup?.attempts ?? 0) + 1;
    const message = errorText(error);
    const base = { id: sessionId, createdAt: record?.createdAt ?? now };
    if (attempts >= CLEANUP_MAX_ATTEMPTS) {
      await deps.store.setJson(KEYS.record(sessionId), { ...base, state: "failed", cleanup: { attempts, lastError: message, nextAttemptAt: null } } satisfies SessionRecord, RECORD_TTL_MS).catch(() => {});
      await deps.store.zrem(KEYS.due, sessionId).catch(() => {});
      log("error", "Gave up deleting a session; the scheduled sweep keeps retrying its tagged resources", { sessionId, attempts, error: message });
      return { outcome: "failed", attempts, error: message };
    }
    const nextAttemptAt = now + cleanupBackoffMs(attempts);
    await deps.store.setJson(KEYS.record(sessionId), { ...base, state: "ending", cleanup: { attempts, lastError: message, nextAttemptAt } } satisfies SessionRecord, RECORD_TTL_MS).catch(() => {});
    await deps.store.zadd(KEYS.due, nextAttemptAt, sessionId).catch(() => {});
    log("warn", "Session deletion failed; will retry", { sessionId, attempts, nextAttemptAt, error: message });
    return { outcome: "retrying", attempts, nextAttemptAt, error: message };
  }
}

/** The page was left or "New video" was chosen. Safe to call more than once. */
export async function endSession(deps: SessionDeps, input: { sessionId: unknown }): Promise<CleanupOutcome> {
  const sessionId = assertSessionId(input.sessionId);
  const record = await deps.store.getJson<SessionRecord>(KEYS.record(sessionId));
  if (record?.state === "active") {
    // Written first: a start request still in flight sees this and deletes its own asset.
    await deps.store.setJson(KEYS.record(sessionId), { ...record, state: "ending" } satisfies SessionRecord, RECORD_TTL_MS);
    await deps.store.zadd(KEYS.due, (deps.now ?? Date.now)(), sessionId);
  }
  return cleanupSession(deps, sessionId);
}

const tally = (summary: { deleted: number; retrying: number; failed: number }, outcome: CleanupOutcome) => {
  summary[outcome.outcome]++;
};

/**
 * Ends abandoned sessions and retries failed deletions whose time has come. Sessions
 * still sending heartbeats are rescheduled, never deleted.
 */
export async function processDueSessions(deps: SessionDeps, limit = 50) {
  const now = (deps.now ?? Date.now)();
  const summary = { checked: 0, stillActive: 0, deleted: 0, retrying: 0, failed: 0 };
  for (const sessionId of await deps.store.zdue(KEYS.due, now, limit)) {
    summary.checked++;
    const record = await deps.store.getJson<SessionRecord>(KEYS.record(sessionId));
    if (record?.state === "failed") {
      await deps.store.zrem(KEYS.due, sessionId);
      continue;
    }
    if (record?.state === "active") {
      const seen = (await deps.store.getJson<number>(KEYS.seen(sessionId))) ?? record.createdAt;
      if (now - seen < IDLE_TIMEOUT_MS) {
        await deps.store.zadd(KEYS.due, seen + IDLE_TIMEOUT_MS, sessionId);
        summary.stillActive++;
        continue;
      }
      await deps.store.setJson(KEYS.record(sessionId), { ...record, state: "ending" } satisfies SessionRecord, RECORD_TTL_MS);
    }
    tally(summary, await cleanupSession(deps, sessionId));
  }
  return summary;
}

/** Whether a tagged resource may be deleted, given its session (if any) and age. */
async function isAbandoned(deps: SessionDeps, sessionId: string | null, createdAt: number | null, now: number) {
  const age = createdAt === null ? Infinity : now - createdAt;
  if (!sessionId) return age > LEGACY_STALE_MS;
  const record = await deps.store.getJson<SessionRecord>(KEYS.record(sessionId));
  if (!record) return age > ORPHAN_GRACE_MS;
  if (record.state !== "active") return true;
  const seen = (await deps.store.getJson<number>(KEYS.seen(sessionId))) ?? record.createdAt;
  return now - seen >= IDLE_TIMEOUT_MS;
}

export interface SweepCounts {
  listed: number;
  deleted: number;
  kept: number;
  failed: number;
  complete: boolean;
}

/**
 * Safety net that walks every tagged TwelveLabs asset and every upload under sessions/,
 * a bounded number of pages per run. Progress is saved in the shared store, so the next run
 * continues where this one stopped instead of re-reading the first pages. TwelveLabs assets
 * without this app's tag are never touched.
 */
export async function sweepListings(deps: SessionDeps, budget = { assetPages: 10, blobPages: 5 }) {
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? defaultLog;
  const fresh = (): SweepCounts => ({ listed: 0, deleted: 0, kept: 0, failed: 0, complete: false });
  const summary = { assets: fresh(), uploads: fresh() };

  // TwelveLabs pages newest first by page number. Deleting shifts later items forward, so
  // progress is the number of surviving items already looked at, not a page number.
  let offset = (await deps.store.getJson<{ offset: number }>(KEYS.assetSweep))?.offset ?? 0;
  for (let pages = 0; pages < budget.assetPages; pages++) {
    const pageNumber = Math.floor(offset / ASSET_PAGE_LIMIT) + 1;
    let page;
    try {
      page = await deps.provider.listAssets({ page: pageNumber, pageLimit: ASSET_PAGE_LIMIT, filename: ASSET_TAG });
    } catch (error) {
      summary.assets.failed++;
      log("warn", "Listing TwelveLabs assets failed; the next run resumes here", { offset, error: errorText(error) });
      break;
    }
    let survivors = 0;
    for (const item of page.items.slice(offset % ASSET_PAGE_LIMIT)) {
      summary.assets.listed++;
      const created = item.createdAt ? Date.parse(item.createdAt) : NaN;
      // The filename filter is a partial match; only names that start with the tag are ours.
      const ours = item.filename?.startsWith(ASSET_TAG) ?? false;
      if (!ours || !(await isAbandoned(deps, sessionIdOfAsset(item.filename), Number.isFinite(created) ? created : null, now))) {
        summary.assets.kept++;
        survivors++;
        continue;
      }
      try {
        await deps.provider.deleteAsset(item.id);
        summary.assets.deleted++;
      } catch (error) {
        if (isNotFound(error)) {
          summary.assets.deleted++;
          continue;
        }
        summary.assets.failed++;
        survivors++;
        log("warn", "Deleting a TwelveLabs asset failed; the next sweep retries it", { assetId: item.id, error: errorText(error) });
      }
    }
    offset += survivors;
    if (page.items.length < ASSET_PAGE_LIMIT || (page.totalPages !== null && pageNumber >= page.totalPages)) {
      summary.assets.complete = true;
      offset = 0;
      break;
    }
  }
  await deps.store.setJson(KEYS.assetSweep, { offset }).catch(() => {});

  // Blob listings use a cursor, which deletions do not disturb.
  let cursor = (await deps.store.getJson<{ cursor: string | null }>(KEYS.blobSweep))?.cursor ?? undefined;
  for (let pages = 0; pages < budget.blobPages; pages++) {
    let page;
    try {
      page = await deps.blob.list(BLOB_PREFIX, { cursor, limit: BLOB_PAGE_LIMIT });
    } catch (error) {
      summary.uploads.failed++;
      log("warn", "Listing uploads failed; the next run resumes here", { error: errorText(error) });
      break;
    }
    const doomed: string[] = [];
    for (const entry of page.blobs) {
      summary.uploads.listed++;
      if (await isAbandoned(deps, sessionIdOfPath(entry.pathname), entry.uploadedAt.getTime(), now)) doomed.push(entry.pathname);
      else summary.uploads.kept++;
    }
    if (doomed.length) {
      try {
        await deps.blob.remove(doomed);
        summary.uploads.deleted += doomed.length;
      } catch (error) {
        summary.uploads.failed += doomed.length;
        log("warn", "Deleting uploads failed; the next run retries this page", { count: doomed.length, error: errorText(error) });
        break; // The cursor stays before this page, so these are seen again.
      }
    }
    if (!page.hasMore || !page.cursor) {
      summary.uploads.complete = true;
      cursor = undefined;
      break;
    }
    cursor = page.cursor;
  }
  await deps.store.setJson(KEYS.blobSweep, { cursor: cursor ?? null }).catch(() => {});
  return summary;
}
