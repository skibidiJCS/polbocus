import "server-only";
import { openAsBlob } from "node:fs";
import { PROVIDER_LIMITS } from "./config";
import {
  isNotFound,
  ProviderError,
  type AssetState,
  type IndexedAssetState,
  type ProviderIndex,
  type ProviderSearchItem,
  type SearchOption,
  type SettingsStore,
  type UploadFileInput,
  type VideoProvider,
} from "./video-provider";

/**
 * TwelveLabs REST adapter, API v1.3. Endpoints and fields verified on docs.twelvelabs.io
 * (2026-11-02): POST /assets, /assets/multipart-uploads*, GET /assets/{id},
 * GET /assets/{id}/indexed-assets, POST/GET/DELETE /indexes/{id}/indexed-assets,
 * POST /indexes, GET /indexes/{id}, POST /search, DELETE /assets/{id}?force=true.
 * The legacy POST /tasks flow is deprecated by TwelveLabs and is not used.
 */
export const TWELVELABS_BASE_URL = "https://api.twelvelabs.io/v1.3";
export const DEFAULT_MODEL_NAME = "marengo3.0";
const INDEX_SETTING_KEY = "twelvelabs.index_id";
const INDEX_CACHE_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const CHUNK_TIMEOUT_MS = 10 * 60_000;
const DIRECT_UPLOAD_TIMEOUT_MS = 60 * 60_000;

type FetchLike = typeof fetch;

interface RequestOptions {
  json?: unknown;
  form?: FormData;
  query?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.round((date - Date.now()) / 1000));
  return undefined;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function createTwelveLabsProvider(options: { apiKey: string; settings: SettingsStore; configuredIndexId: string | null; fetchImpl?: FetchLike; baseUrl?: string; sleep?: (ms: number) => Promise<void> }): VideoProvider {
  const { apiKey, settings, configuredIndexId } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? TWELVELABS_BASE_URL;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const indexCache = new Map<string, { at: number; index: ProviderIndex }>();
  let ensuring: Promise<ProviderIndex> | null = null;

  function scrub(text: string) {
    return apiKey ? text.split(apiKey).join("[redacted]") : text;
  }

  async function toProviderError(response: Response): Promise<ProviderError> {
    let code: string | undefined;
    let message = response.statusText || "Request failed";
    try {
      const body = (await response.json()) as { code?: unknown; error_code?: unknown; message?: unknown };
      if (typeof body.code === "string") code = body.code;
      else if (body.error_code !== undefined) code = String(body.error_code);
      if (typeof body.message === "string") message = body.message;
    } catch {
      // Non-JSON error body; keep the status text.
    }
    const status = response.status;
    const retryable = status === 408 || status === 429 || status >= 500;
    const text = scrub(`TwelveLabs ${status}${code ? ` ${code}` : ""}: ${message}`).slice(0, 400);
    return new ProviderError(text, { status, code, retryable, retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")) });
  }

  async function send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = new URL(baseUrl + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { "x-api-key": apiKey, accept: "application/json" };
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form;
    }
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      return await fetchImpl(url, { method, headers, body, signal });
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      if (isAbortError(error)) throw new ProviderError("TwelveLabs did not respond in time.", { retryable: true });
      throw new ProviderError("Could not reach TwelveLabs. Check the network connection.", { retryable: true });
    }
  }

  async function call<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const response = await send(method, path, opts);
    if (!response.ok) throw await toProviderError(response);
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  function readIndex(body: { _id?: string; models?: { model_name?: string; model_options?: string[] }[] }, indexId: string): ProviderIndex {
    const marengo = body.models?.find((model) => model.model_name?.toLowerCase().startsWith("marengo"));
    if (!marengo) {
      throw new ProviderError(`Index ${indexId} has no Marengo model. Search requires a Marengo index.`, { retryable: false, code: "index_incompatible" });
    }
    const modelOptions = marengo.model_options ?? [];
    if (!modelOptions.includes("visual")) {
      throw new ProviderError(`Index ${indexId} does not have the "visual" model option, so visual search is unavailable. Configure an index created with visual (and ideally audio).`, { retryable: false, code: "index_incompatible" });
    }
    const searchOptions: SearchOption[] = ["visual"];
    // Marengo's "audio" model option covers ambient sound, music, and human speech;
    // spoken words are searched with the "transcription" search option.
    if (modelOptions.includes("audio")) searchOptions.push("transcription", "audio");
    return { id: body._id ?? indexId, searchOptions };
  }

  async function getIndex(indexId: string, signal?: AbortSignal): Promise<ProviderIndex> {
    const cached = indexCache.get(indexId);
    if (cached && Date.now() - cached.at < INDEX_CACHE_MS) return cached.index;
    const body = await call<Parameters<typeof readIndex>[0]>("GET", `/indexes/${encodeURIComponent(indexId)}`, { signal });
    const index = readIndex(body, indexId);
    indexCache.set(indexId, { at: Date.now(), index });
    return index;
  }

  async function ensureIndexOnce(signal?: AbortSignal): Promise<ProviderIndex> {
    if (configuredIndexId) return getIndex(configuredIndexId, signal);
    const stored = settings.get(INDEX_SETTING_KEY);
    if (stored) {
      try {
        return await getIndex(stored, signal);
      } catch (error) {
        // Only replace the stored index when TwelveLabs says it no longer exists.
        if (!isNotFound(error)) throw error;
      }
    }
    // Reuse a compatible existing index (Marengo with visual + audio) before creating one.
    // The choice is deterministic so stateless instances agree: indexes this app created
    // first, then ones with thumbnails, then by ID.
    const listed = await call<{ data?: (Parameters<typeof readIndex>[0] & { addons?: string[]; index_name?: string })[] }>("GET", "/indexes", { signal, query: { page_limit: "50" } });
    const compatible = (listed.data ?? [])
      .flatMap((body) => {
        try {
          const index = readIndex(body, body._id ?? "");
          const thumbnails = Boolean(body.addons?.includes("thumbnail") || body.models?.some((m) => (m as { addons?: string[] }).addons?.includes("thumbnail")));
          const ours = Boolean(body.index_name?.startsWith("footage-search"));
          return index.id && index.searchOptions.includes("audio") ? [{ index, thumbnails, ours }] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => Number(b.ours) - Number(a.ours) || Number(b.thumbnails) - Number(a.thumbnails) || a.index.id.localeCompare(b.index.id));
    if (compatible.length) {
      const { index } = compatible[0];
      settings.set(INDEX_SETTING_KEY, index.id);
      indexCache.set(index.id, { at: Date.now(), index });
      return index;
    }
    const name = `footage-search-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
    const created = await call<{ _id: string }>("POST", "/indexes", {
      signal,
      json: { index_name: name, models: [{ model_name: DEFAULT_MODEL_NAME, model_options: ["visual", "audio"] }], addons: ["thumbnail"] },
    });
    settings.set(INDEX_SETTING_KEY, created._id);
    const index: ProviderIndex = { id: created._id, searchOptions: ["visual", "transcription", "audio"] };
    indexCache.set(created._id, { at: Date.now(), index });
    return index;
  }

  async function uploadDirect(file: UploadFileInput, signal?: AbortSignal) {
    const form = new FormData();
    form.append("method", "direct");
    form.append("file", await openAsBlob(file.path, { type: file.mimeType }), file.filename);
    form.append("filename", file.filename);
    form.append("enable_hls", "false");
    form.append("enable_thumbnail", "false");
    const asset = await call<{ _id: string }>("POST", "/assets", { form, signal, timeoutMs: DIRECT_UPLOAD_TIMEOUT_MS });
    return { assetId: asset._id };
  }

  async function uploadMultipart(file: UploadFileInput, signal?: AbortSignal, onHeartbeat?: () => void) {
    type Chunk = { chunk_index: number; url: string };
    const session = await call<{
      upload_id: string; asset_id: string; upload_urls: Chunk[]; upload_headers?: Record<string, string>; chunk_size: number; total_chunks: number;
    }>("POST", "/assets/multipart-uploads", { signal, json: { filename: file.filename, type: "video", total_size: file.sizeBytes } });
    const blob = await openAsBlob(file.path);
    const urls = new Map<number, { url: string; issuedAt: number }>();
    const remember = (chunks: Chunk[]) => chunks.forEach((chunk) => urls.set(chunk.chunk_index, { url: chunk.url, issuedAt: Date.now() }));
    remember(session.upload_urls ?? []);
    const pending: { chunk_index: number; proof: string; proof_type: "etag"; chunk_size: number }[] = [];
    let lastReport: { total_completed?: number } | null = null;
    const report = async () => {
      if (!pending.length) return;
      lastReport = await call("POST", `/assets/multipart-uploads/${encodeURIComponent(session.upload_id)}`, { signal, json: { completed_chunks: pending.splice(0) } });
    };

    for (let index = 1; index <= session.total_chunks; index++) {
      const known = urls.get(index);
      // Presigned URLs are single-use and expire after one hour; refresh well before that.
      if (!known || Date.now() - known.issuedAt > 45 * 60_000) {
        const count = Math.min(50, session.total_chunks - index + 1);
        const more = await call<{ upload_urls: Chunk[] }>("POST", `/assets/multipart-uploads/${encodeURIComponent(session.upload_id)}/presigned-urls`, { signal, json: { start: index, count } });
        remember(more.upload_urls ?? []);
      }
      const target = urls.get(index);
      if (!target) throw new ProviderError(`TwelveLabs did not provide an upload URL for chunk ${index}.`, { retryable: true });
      const offset = (index - 1) * session.chunk_size;
      const length = Math.min(session.chunk_size, file.sizeBytes - offset);
      let etag: string | null = null;
      for (let attempt = 1; attempt <= 3 && !etag; attempt++) {
        try {
          const response = await fetchImpl(target.url, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream", ...(session.upload_headers ?? {}) },
            body: blob.slice(offset, offset + length),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CHUNK_TIMEOUT_MS)]) : AbortSignal.timeout(CHUNK_TIMEOUT_MS),
          });
          if (!response.ok) throw new Error(`chunk upload returned HTTP ${response.status}`);
          etag = response.headers.get("etag")?.replace(/"/g, "") ?? null;
          if (!etag) throw new Error("chunk upload response had no ETag");
        } catch (error) {
          if (signal?.aborted) throw error;
          if (attempt === 3) throw new ProviderError(`Uploading chunk ${index} of ${session.total_chunks} failed: ${error instanceof Error ? error.message : "unknown error"}`, { retryable: true });
          await sleep(2000 * attempt);
        }
      }
      pending.push({ chunk_index: index, proof: etag!, proof_type: "etag", chunk_size: length });
      onHeartbeat?.();
      if (pending.length >= 10) await report();
    }
    await report();
    const completed = (lastReport as { total_completed?: number } | null)?.total_completed;
    if (completed !== undefined && completed !== session.total_chunks) {
      throw new ProviderError(`TwelveLabs acknowledged ${completed} of ${session.total_chunks} chunks.`, { retryable: true });
    }
    // "completed" means TwelveLabs received the file; the asset is then processed separately.
    for (let check = 0; check < 120; check++) {
      const status = await call<{ status: string }>("GET", `/assets/multipart-uploads/${encodeURIComponent(session.upload_id)}`, { signal, query: { page_limit: "1" } });
      if (status.status === "completed") return { assetId: session.asset_id };
      if (status.status === "failed" || status.status === "expired") {
        throw new ProviderError(`TwelveLabs multipart upload ${status.status}.`, { retryable: true });
      }
      onHeartbeat?.();
      await sleep(5000);
    }
    throw new ProviderError("TwelveLabs did not confirm the multipart upload within 10 minutes.", { retryable: true });
  }

  return {
    getIndex,

    ensureIndex(signal) {
      // One in-flight resolution per process so concurrent jobs never create two indexes.
      ensuring ??= ensureIndexOnce(signal).finally(() => { ensuring = null; });
      return ensuring;
    },

    async uploadAsset(file, signal, onHeartbeat) {
      if (file.sizeBytes <= PROVIDER_LIMITS.directUploadMaxBytes) {
        const heartbeat = onHeartbeat ? setInterval(onHeartbeat, 30_000) : null;
        try {
          return await uploadDirect(file, signal);
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
      }
      return uploadMultipart(file, signal, onHeartbeat);
    },

    async createAssetFromUrl(url, filename, signal) {
      const form = new FormData();
      form.append("method", "url");
      form.append("url", url);
      form.append("filename", filename);
      // The app plays files locally and gets thumbnails from search, so skip TwelveLabs'
      // optional streaming copy and asset thumbnails.
      form.append("enable_hls", "false");
      form.append("enable_thumbnail", "false");
      const asset = await call<{ _id: string }>("POST", "/assets", { form, signal });
      return { assetId: asset._id };
    },

    async listAssets(signal) {
      const body = await call<{ data?: { _id: string; filename?: string; created_at?: string }[] }>("GET", "/assets", { signal, query: { page_limit: "50" } });
      return (body.data ?? []).map((asset) => ({ id: asset._id, filename: asset.filename ?? null, createdAt: asset.created_at ?? null }));
    },

    async getAsset(assetId, signal): Promise<AssetState> {
      const body = await call<{ status?: string; duration?: unknown; error?: { message?: string } }>("GET", `/assets/${encodeURIComponent(assetId)}`, { signal });
      if (body.status === "ready") return { status: "ready", durationSeconds: asNumberOrNull(body.duration) };
      if (body.status === "failed") return { status: "failed", message: body.error?.message ? `TwelveLabs could not process the file: ${body.error.message}` : "TwelveLabs could not process the file." };
      return { status: "processing" };
    },

    async findIndexedAssets(assetId, indexId, signal) {
      const body = await call<{ data?: { _id: string; index?: { _id?: string } }[] }>("GET", `/assets/${encodeURIComponent(assetId)}/indexed-assets`, { signal, query: { page_limit: "50" } });
      return (body.data ?? []).filter((item) => item.index?._id === indexId).map((item) => item._id);
    },

    async indexAsset(indexId, assetId, signal) {
      const body = await call<{ _id: string }>("POST", `/indexes/${encodeURIComponent(indexId)}/indexed-assets`, { signal, json: { asset_id: assetId } });
      return { indexedAssetId: body._id };
    },

    async getIndexedAsset(indexId, indexedAssetId, signal): Promise<IndexedAssetState> {
      const body = await call<{ status?: string; system_metadata?: { duration?: unknown } }>("GET", `/indexes/${encodeURIComponent(indexId)}/indexed-assets/${encodeURIComponent(indexedAssetId)}`, { signal });
      const durationSeconds = asNumberOrNull(body.system_metadata?.duration);
      if (body.status === "ready") return { status: "ready", durationSeconds };
      if (body.status === "failed") return { status: "failed", message: "TwelveLabs reported that indexing failed. Check that the video is 4 seconds to 4 hours long, at least 360x360, and uses a common codec." };
      return { status: "in_progress", providerStatus: body.status ?? "unknown", durationSeconds };
    },

    async search({ indexId, providerVideoId, query, searchOptions, pageLimit }, signal): Promise<ProviderSearchItem[]> {
      const form = new FormData();
      form.append("index_id", indexId);
      form.append("query_text", query);
      for (const option of searchOptions) form.append("search_options", option);
      if (searchOptions.length > 1) form.append("operator", "or");
      // Documented filter syntax for restricting results to specific videos.
      form.append("filter", JSON.stringify({ id: [providerVideoId] }));
      form.append("page_limit", String(pageLimit));
      const body = await call<{ data?: { video_id?: string; start?: unknown; end?: unknown; rank?: unknown; thumbnail_url?: string; transcription?: string }[] }>("POST", "/search", { form, signal });
      return (body.data ?? []).map((item) => ({
        videoId: item.video_id ?? null,
        start: item.start,
        end: item.end,
        rank: item.rank,
        thumbnailUrl: typeof item.thumbnail_url === "string" ? item.thumbnail_url : null,
        transcription: typeof item.transcription === "string" && item.transcription.trim() ? item.transcription.trim() : null,
      }));
    },

    async deleteIndexedAsset(indexId, indexedAssetId, signal) {
      try {
        await call("DELETE", `/indexes/${encodeURIComponent(indexId)}/indexed-assets/${encodeURIComponent(indexedAssetId)}`, { signal });
        return "deleted";
      } catch (error) {
        if (isNotFound(error)) return "not_found";
        throw error;
      }
    },

    async deleteAsset(assetId, signal) {
      try {
        // force=true also removes indexed assets that reference this asset.
        await call("DELETE", `/assets/${encodeURIComponent(assetId)}`, { signal, query: { force: "true" } });
        return "deleted";
      } catch (error) {
        if (isNotFound(error)) return "not_found";
        throw error;
      }
    },
  };
}
