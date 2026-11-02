import { vi } from "vitest";
import type { VideoProvider } from "@/lib/server/video-provider";

/** In-memory stand-in for TwelveLabs. Every method is a spy with a sensible default. */
export function fakeProvider(overrides: Partial<VideoProvider> = {}) {
  const provider = {
    ensureIndex: vi.fn(async () => ({ id: "idx1", searchOptions: ["visual", "transcription", "audio"] as const })),
    getIndex: vi.fn(async (id: string) => ({ id, searchOptions: ["visual", "transcription", "audio"] as const })),
    uploadAsset: vi.fn(async () => ({ assetId: "asset1" })),
    getAsset: vi.fn(async () => ({ status: "ready" as const, durationSeconds: 61.5 })),
    findIndexedAssets: vi.fn(async () => [] as string[]),
    indexAsset: vi.fn(async () => ({ indexedAssetId: "ia1" })),
    getIndexedAsset: vi.fn(async () => ({ status: "ready" as const, durationSeconds: 61.5 })),
    search: vi.fn(async () => []),
    deleteIndexedAsset: vi.fn(async () => "deleted" as const),
    deleteAsset: vi.fn(async () => "deleted" as const),
  };
  for (const [key, impl] of Object.entries(overrides)) {
    (provider as Record<string, unknown>)[key] = vi.fn(impl as (...args: unknown[]) => unknown);
  }
  return provider as unknown as VideoProvider & { [K in keyof VideoProvider]: ReturnType<typeof vi.fn> };
}
