import "server-only";

/**
 * App-side contract for the indexing/search provider, shaped after the
 * TwelveLabs v1.3 asset → indexed-asset → search workflow. The worker and
 * routes depend on this interface so tests can substitute a fake.
 */
export interface ProviderIndex {
  id: string;
  /** Values for the search `search_options` field this index supports. */
  searchOptions: SearchOption[];
}

export type SearchOption = "visual" | "audio" | "transcription";
/** How spoken words are matched: exact words ("lexical") or meaning ("semantic"). */
export type TranscriptionOption = "lexical" | "semantic";

export type AssetState =
  | { status: "processing" }
  | { status: "ready"; durationSeconds: number | null }
  | { status: "failed"; message: string };

export type IndexedAssetState =
  // TwelveLabs reports pending, queued, validating, or indexing; providerStatus keeps the raw value.
  | { status: "in_progress"; providerStatus: string; durationSeconds: number | null }
  | { status: "ready"; durationSeconds: number | null }
  | { status: "failed"; message: string };

export interface ProviderSearchItem {
  videoId: string | null;
  start: unknown;
  end: unknown;
  rank: unknown;
  thumbnailUrl: string | null;
  transcription: string | null;
}

export interface UploadFileInput {
  path: string;
  sizeBytes: number;
  filename: string;
  mimeType: string;
}

export interface VideoProvider {
  /** Reuses the configured or previously created index; creates one only when none exists. */
  ensureIndex(signal?: AbortSignal): Promise<ProviderIndex>;
  getIndex(indexId: string, signal?: AbortSignal): Promise<ProviderIndex>;
  uploadAsset(file: UploadFileInput, signal?: AbortSignal, onHeartbeat?: () => void): Promise<{ assetId: string }>;
  /** TwelveLabs downloads the file from a public or presigned URL (videos up to 4 GB). */
  createAssetFromUrl(url: string, filename: string, signal?: AbortSignal): Promise<{ assetId: string }>;
  getAsset(assetId: string, signal?: AbortSignal): Promise<AssetState>;
  /** One page of assets, newest first. `filename` is TwelveLabs' case-insensitive partial match. */
  listAssets(
    query: { page: number; pageLimit: number; filename?: string },
    signal?: AbortSignal,
  ): Promise<{ items: { id: string; filename: string | null; createdAt: string | null }[]; totalPages: number | null }>;
  /** Indexed assets in `indexId` that reference `assetId` (to avoid indexing twice). */
  findIndexedAssets(assetId: string, indexId: string, signal?: AbortSignal): Promise<string[]>;
  indexAsset(indexId: string, assetId: string, signal?: AbortSignal): Promise<{ indexedAssetId: string }>;
  getIndexedAsset(indexId: string, indexedAssetId: string, signal?: AbortSignal): Promise<IndexedAssetState>;
  search(input: { indexId: string; providerVideoId: string; query: string; searchOptions: SearchOption[]; pageLimit: number; transcriptionOptions?: TranscriptionOption[] }, signal?: AbortSignal): Promise<ProviderSearchItem[]>;
  deleteIndexedAsset(indexId: string, indexedAssetId: string, signal?: AbortSignal): Promise<"deleted" | "not_found">;
  /** Deletes the asset and (force) any indexed assets that reference it. */
  deleteAsset(assetId: string, signal?: AbortSignal): Promise<"deleted" | "not_found">;
}

/** Small key/value store for provider state (chosen index, unsupported options). */
export interface SettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Per-process settings for stateless deployments; choices are re-derived after a cold start. */
export function memorySettings(): SettingsStore {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => void values.set(key, value) };
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly options: { status?: number; code?: string; retryable: boolean; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = "ProviderError";
  }
  get status() { return this.options.status; }
  get code() { return this.options.code; }
  get retryable() { return this.options.retryable; }
  get retryAfterSeconds() { return this.options.retryAfterSeconds; }
}

/**
 * Missing resources: TwelveLabs documents the code `resource_not_exist`; the live API
 * (2026-11-02) returned HTTP 404 with `resource_not_exists`. Accept all three signals.
 */
export function isNotFound(error: unknown) {
  return error instanceof ProviderError && (error.status === 404 || error.code === "resource_not_exist" || error.code === "resource_not_exists");
}

export class ProviderNotConfiguredError extends Error {
  constructor() {
    super("TWELVELABS_API_KEY is not set in .env.local.");
  }
}
