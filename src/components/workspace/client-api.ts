import type { DeleteVideoResult, SearchSegment, VideoSummary } from "@/types/video";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; retryAfterSeconds?: number };
  if (!response.ok) {
    throw new ApiError(body.error || `Request failed (${response.status}).`, response.status, body.retryAfterSeconds ?? undefined);
  }
  return body;
}

export async function fetchVideos(): Promise<VideoSummary[]> {
  const body = await readJson<{ videos: VideoSummary[] }>(await fetch("/api/videos", { cache: "no-store" }));
  return body.videos;
}

export async function retryVideo(id: string): Promise<VideoSummary> {
  const body = await readJson<{ video: VideoSummary }>(await fetch(`/api/videos/${id}/retry`, { method: "POST" }));
  return body.video;
}

export async function deleteVideo(id: string, includeProvider: boolean): Promise<DeleteVideoResult> {
  const response = await fetch(`/api/videos/${id}?provider=${includeProvider}`, { method: "DELETE" });
  const body = (await response.json().catch(() => ({}))) as DeleteVideoResult & { error?: string };
  if (body.error) throw new ApiError(body.error, response.status);
  return body;
}

export interface SearchResult {
  segments: SearchSegment[];
  searchOptions: string[];
  notes: string[];
}

export type SearchMode = "all" | "visual" | "speech";

export async function searchMoments(videoId: string, query: string, mode: SearchMode, signal: AbortSignal): Promise<SearchResult> {
  const response = await fetch("/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ videoId, query, mode }),
    signal,
  });
  return readJson<SearchResult>(response);
}

/** XHR rather than fetch so the browser reports genuine upload progress. */
export function uploadVideo(file: File, onProgress: (loaded: number, total: number) => void) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ video: VideoSummary; duplicate: boolean }>((resolve, reject) => {
    xhr.open("POST", "/api/videos");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
    xhr.onload = () => {
      let body: { video?: VideoSummary; duplicate?: boolean; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Non-JSON response handled below.
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.video) resolve({ video: body.video, duplicate: Boolean(body.duplicate) });
      else reject(new ApiError(body.error || `Upload failed (${xhr.status}).`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("Upload failed: the connection to the local server was interrupted.", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled.", 0));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
