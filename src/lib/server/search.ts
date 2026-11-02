import "server-only";
import { ServiceError } from "./errors";
import { ProviderError, type SearchOption, type SettingsStore, type VideoProvider } from "./video-provider";
import { normalizeSegments } from "@/lib/segments";
import type { SearchSegment } from "@/types/video";

const nowIso = () => new Date().toISOString();

export const MAX_QUERY_LENGTH = 500;
export const SEARCH_PAGE_LIMIT = 20;

const noTranscriptionKey = (indexId: string) => `twelvelabs.no_transcription.${indexId}`;

/**
 * Which TwelveLabs search options to use. "all" combines every option the index supports
 * (operator=or); live testing showed visual matches then outrank speech, so users can
 * restrict a search to what is seen or to what is said.
 */
export type SearchMode = "all" | "visual" | "speech";
export const SEARCH_MODES: SearchMode[] = ["all", "visual", "speech"];

export interface SearchResponse {
  segments: SearchSegment[];
  searchOptions: SearchOption[];
  notes: string[];
}

export function validateQuery(rawQuery: string) {
  const query = rawQuery.trim();
  if (!query) throw new ServiceError("Describe the moment you are looking for.", 400);
  if (query.length > MAX_QUERY_LENGTH) throw new ServiceError(`Keep the description under ${MAX_QUERY_LENGTH} characters.`, 400);
  return query;
}

/** Searches one indexed video. Shared by the local library and the one-time session mode. */
export async function searchIndexedVideo(
  provider: VideoProvider,
  settings: SettingsStore,
  input: { indexId: string; providerVideoId: string; localVideoId: string; durationSeconds: number | null; query: string; mode: SearchMode },
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const { mode, query } = input;
  const index = await provider.getIndex(input.indexId, signal);
  const supported = index.searchOptions.filter((option) => !(option === "transcription" && settings.get(noTranscriptionKey(index.id))));
  let options = mode === "visual" ? supported.filter((o) => o === "visual") : mode === "speech" ? supported.filter((o) => o === "transcription") : supported;
  if (!options.length) {
    throw new ServiceError(mode === "speech" ? "This video's index does not support spoken-word search. Search everything or visuals instead." : "This index does not support that kind of search.", 400);
  }
  const notes: string[] = [];
  const run = (searchOptions: SearchOption[]) =>
    provider.search({ indexId: index.id, providerVideoId: input.providerVideoId, query, searchOptions, pageLimit: SEARCH_PAGE_LIMIT }, signal);

  let items;
  try {
    items = await run(options);
  } catch (error) {
    // One fallback, never a loop: drop transcription if this index rejects it.
    const rejected = error instanceof ProviderError && (error.code === "search_option_not_supported" || error.code === "search_option_combination_not_supported");
    if (!rejected || !options.includes("transcription")) throw error;
    if (mode === "speech") {
      settings.set(noTranscriptionKey(index.id), nowIso());
      throw new ServiceError("This video's index does not support spoken-word search. Search everything or visuals instead.", 400);
    }
    settings.set(noTranscriptionKey(index.id), nowIso());
    options = options.filter((option) => option !== "transcription");
    notes.push("This index does not support spoken-word (transcription) search, so only visual and audio search were used.");
    items = await run(options);
  }

  const result = normalizeSegments(items, { providerVideoId: input.providerVideoId, localVideoId: input.localVideoId, durationSeconds: input.durationSeconds });
  if (result.droppedOtherVideo > 0) {
    notes.push(`${result.droppedOtherVideo} result(s) from other videos in the index were hidden.`);
  }
  if (result.droppedInvalid > 0) {
    notes.push(`${result.droppedInvalid} result(s) had timestamps outside this video and were hidden.`);
  }
  return { segments: result.segments, searchOptions: options, notes };
}

