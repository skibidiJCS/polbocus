"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { clampSeek, formatBytes, formatRange, formatTimestamp } from "@/lib/time";
import type { SearchSegment, VideoSummary } from "@/types/video";
import { ApiError, deleteVideo, fetchVideos, retryVideo, searchMoments, uploadVideo, type SearchMode } from "./client-api";
import { DeleteDialog } from "./delete-dialog";
import { isInProgress, statusDetail, VideoLibrary } from "./video-library";

const searchModes: { value: SearchMode; label: string; hint: string }[] = [
  { value: "all", label: "Everything", hint: "What is seen, heard, and said" },
  { value: "visual", label: "Visuals", hint: "Only what is seen on screen" },
  { value: "speech", label: "Spoken words", hint: "Only what people say" },
];
const suggestions = ["When someone drops their phone", "A person walks through a doorway", "An outdoor scene at night", "When someone mentions the deadline"];
const ACCEPT = "video/mp4,video/quicktime,video/x-m4v,video/webm,video/x-matroska,.mp4,.mov,.m4v,.webm,.mkv";
const SELECTED_KEY = "footage.selectedVideo";

interface PendingFile {
  file: File;
  url: string;
  duration: number | null;
}

interface UploadState {
  name: string;
  loaded: number;
  total: number;
  abort: () => void;
}

interface Results {
  videoId: string;
  query: string;
  mode: SearchMode;
  segments: SearchSegment[];
  notes: string[];
}

function readStoredSelection() {
  try {
    return window.localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

const noopSubscribe = () => () => {};

function storeSelection(id: string | null) {
  try {
    if (id) window.localStorage.setItem(SELECTED_KEY, id);
    else window.localStorage.removeItem(SELECTED_KEY);
  } catch {
    // Selection memory is a convenience only.
  }
}

export function Workspace({ apiKeyConfigured, maxUploadBytes, initialVideos }: { apiKeyConfigured: boolean; maxUploadBytes: number; initialVideos: VideoSummary[] }) {
  const [videos, setVideos] = useState<VideoSummary[]>(initialVideos);
  // null until the user picks a video; falls back to the remembered or newest one.
  const [chosenId, setChosenId] = useState<string | null>(null);
  const storedId = useSyncExternalStore(noopSubscribe, readStoredSelection, () => null);
  const [pending, setPending] = useState<PendingFile | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [retrying, setRetrying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<VideoSummary | null>(null);

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("all");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const pendingUrl = useRef<string | null>(null);

  const selectedId = [chosenId, storedId].find((id) => id && videos.some((video) => video.id === id)) ?? videos[0]?.id ?? null;
  const selected = videos.find((video) => video.id === selectedId) ?? null;
  const anyInProgress = videos.some(isInProgress);
  const visibleResults = results && results.videoId === selectedId ? results : null;
  const activeSegment = visibleResults && activeIndex !== null ? visibleResults.segments[activeIndex] ?? null : null;

  const refresh = useCallback(async () => {
    try {
      setVideos(await fetchVideos());
    } catch {
      // Keep the last known library; the next poll will try again.
    }
  }, []);

  // Poll status while anything is in progress. Indexing itself runs on the server
  // and continues when this tab is closed.
  useEffect(() => {
    if (!anyInProgress) return;
    const poll = setInterval(refresh, 3000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [anyInProgress, refresh]);

  useEffect(() => () => {
    if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
    searchAbort.current?.abort();
  }, []);

  // The browser → server step needs this tab; warn before closing mid-upload.
  useEffect(() => {
    if (!upload) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [upload]);

  function selectVideo(id: string) {
    clearPending();
    setChosenId(id);
    storeSelection(id);
    setActiveIndex(null);
    setPlayerError(null);
    setSearchError(null);
  }

  function clearPending() {
    if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
    pendingUrl.current = null;
    setPending(null);
  }

  function chooseFile(candidate?: File) {
    if (!candidate) return;
    setError(null);
    setNotice(null);
    if (upload) {
      setError("Wait for the current upload to finish before adding another video.");
      return;
    }
    if (!apiKeyConfigured) {
      setError("Add TWELVELABS_API_KEY to .env.local and restart the server before uploading.");
      return;
    }
    if (candidate.type && !candidate.type.startsWith("video/")) {
      setError("Select a video file (MP4, MOV, M4V, WebM, or MKV).");
      return;
    }
    if (candidate.size > maxUploadBytes) {
      setError(`This file is ${formatBytes(candidate.size)}. The limit is ${formatBytes(maxUploadBytes)}.`);
      return;
    }
    clearPending();
    const url = URL.createObjectURL(candidate);
    pendingUrl.current = url;
    setPending({ file: candidate, url, duration: null });
  }

  async function startUpload() {
    if (!pending) return;
    const file = pending.file;
    setError(null);
    const { promise, abort } = uploadVideo(file, (loaded, total) => setUpload((current) => (current ? { ...current, loaded, total } : current)));
    setUpload({ name: file.name, loaded: 0, total: file.size, abort });
    clearPending();
    try {
      const { video, duplicate } = await promise;
      setNotice(duplicate ? `“${file.name}” has the same content as “${video.originalName}”, which is already in your library. It was not uploaded again.` : null);
      await refresh();
      selectVideo(video.id);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setUpload(null);
    }
  }

  async function runSearch(event?: React.FormEvent) {
    event?.preventDefault();
    if (!selected || selected.status !== "ready" || searching) return;
    const text = query.trim();
    if (!text) {
      setSearchError("Describe the moment you are looking for.");
      return;
    }
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await searchMoments(selected.id, text, mode, controller.signal);
      setResults({ videoId: selected.id, query: text, mode, segments: result.segments, notes: result.notes });
      setActiveIndex(null);
    } catch (searchFailure) {
      if (controller.signal.aborted) return;
      setSearchError(searchFailure instanceof ApiError ? searchFailure.message : "Search failed. Check that the local server is running.");
    } finally {
      if (searchAbort.current === controller) setSearching(false);
    }
  }

  function seekTo(seconds: number) {
    const player = videoRef.current;
    if (!player) return;
    const duration = Number.isFinite(player.duration) ? player.duration : selected?.durationSeconds;
    const target = clampSeek(seconds, duration);
    if (player.readyState >= HTMLMediaElement.HAVE_METADATA) {
      player.currentTime = target;
      player.play().catch(() => {});
    } else {
      // Applied in onLoadedMetadata once the browser knows the duration.
      pendingSeek.current = target;
    }
  }

  function playSegment(index: number) {
    if (!visibleResults) return;
    setActiveIndex(index);
    seekTo(visibleResults.segments[index].startSeconds);
  }

  async function retry(id: string) {
    setRetrying(id);
    setError(null);
    try {
      await retryVideo(id);
      await refresh();
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "Retry failed.");
    } finally {
      setRetrying(null);
    }
  }

  async function confirmDelete(includeProvider: boolean): Promise<string | null> {
    if (!deleting) return null;
    try {
      const result = await deleteVideo(deleting.id, includeProvider);
      if (!result.recordRemoved) {
        await refresh();
        return result.message;
      }
      setNotice(`“${deleting.originalName}”: ${result.message}`);
      if (results?.videoId === deleting.id) setResults(null);
      setDeleting(null);
      await refresh();
      return null;
    } catch (deleteError) {
      return deleteError instanceof Error ? deleteError.message : "Delete failed.";
    }
  }

  const step = !videos.length && !pending ? "01 / ADD FOOTAGE" : selected?.status === "ready" ? "03 / SEARCH" : "02 / INDEXING";
  const uploadPercent = upload && upload.total > 0 ? Math.min(100, Math.floor((upload.loaded / upload.total) * 100)) : 0;
  const durationWarning = pending?.duration !== null && pending?.duration !== undefined
    ? pending.duration < 4 ? "TwelveLabs requires videos to be at least 4 seconds long." : pending.duration > 4 * 3600 ? "TwelveLabs accepts videos up to 4 hours long." : null
    : null;

  let searchHelper: string;
  if (!selected) searchHelper = "Upload a video, wait for indexing, then describe a moment.";
  else if (selected.status === "ready") searchHelper = "Everything mixes visual, sound, and speech matches, and visual matches tend to rank first. For something someone said, choose Spoken words. Each search is one TwelveLabs request.";
  else if (selected.status === "failed") searchHelper = "Indexing failed for this video. Retry it from the library.";
  else searchHelper = `Search unlocks when indexing finishes. ${statusDetail(selected, now)}.`;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="Footage home"><span className="brand-mark">f.</span> footage<span className="brand-dot">/</span></Link>
        <div className="workspace-label">PERSONAL WORKSPACE</div>
        <div className="library-title"><span>Your footage</span><span className="count">{videos.length}</span></div>
        <button className="add-button" onClick={() => inputRef.current?.click()} disabled={Boolean(upload)}><span>＋</span> Upload a video</button>
        <input ref={inputRef} className="sr-only" type="file" accept={ACCEPT} aria-label="Choose a video to upload" onChange={(event) => { chooseFile(event.target.files?.[0]); event.target.value = ""; }} />
        {upload && (
          <div className="upload-progress" role="status" aria-live="polite">
            <div className="upload-progress-head"><strong title={upload.name}>{upload.name}</strong><span>{uploadPercent}%</span></div>
            <div className="progress-track"><div className="progress-bar" style={{ width: `${uploadPercent}%` }} /></div>
            <span>{uploadPercent < 100 ? `Uploading to this computer · ${formatBytes(upload.loaded)} of ${formatBytes(upload.total)}` : "Saving and checking the file…"}</span>
            {uploadPercent < 100 && <button className="text-button" onClick={upload.abort}>Cancel upload</button>}
          </div>
        )}
        <VideoLibrary videos={videos} selectedId={selectedId} now={now} onSelect={selectVideo} onRetry={retry} onDelete={setDeleting} retrying={retrying} />
        <div className="sidebar-footer"><span className="status-dot" /> Local workspace<span className="version">v0.2</span></div>
      </aside>
      <main className="main-content">
        <header className="topbar"><span>Workspace <span className="slash">/</span> Video search</span><span className="badge">LOCAL PROTOTYPE</span></header>
        <div className="content">
          <div className="page-heading"><div><p className="eyebrow">LESS SCRUBBING. MORE CREATING.</p><h1>Find the moment.</h1><p className="subtitle">Your footage, searchable by what happens.</p></div><span className="step-label">{step}</span></div>
          {notice && <p className="notice-message" role="status">{notice} <button className="text-button" onClick={() => setNotice(null)}>Dismiss</button></p>}
          {error && <p className="error-message" role="alert">{error}</p>}
          <div className="workspace-grid">
            <section className="video-column" aria-label="Video workspace">
              <div
                className={`player-panel ${dragging ? "is-dragging" : ""}`}
                onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]); }}
              >
                {pending ? (
                  <div className="confirm-upload">
                    <video src={pending.url} controls muted preload="metadata" aria-label={`Preview of ${pending.file.name}`} onLoadedMetadata={(event) => { const duration = event.currentTarget.duration; setPending((current) => (current ? { ...current, duration: Number.isFinite(duration) ? duration : null } : current)); }} />
                    <div className="confirm-upload-panel">
                      <div>
                        <strong title={pending.file.name}>{pending.file.name}</strong>
                        <span>{formatBytes(pending.file.size)}{pending.duration ? ` · ${formatTimestamp(pending.duration)}` : ""}</span>
                        <p>Uploading saves a copy in this app&apos;s local data folder and <strong>sends the video to TwelveLabs</strong> for indexing. Indexing uses your TwelveLabs plan&apos;s quota.</p>
                        {durationWarning && <p className="inline-warning">{durationWarning}</p>}
                      </div>
                      <div className="confirm-upload-actions">
                        <button className="primary-button" onClick={startUpload} disabled={Boolean(durationWarning)}>Upload &amp; index <span>↗</span></button>
                        <button className="text-button" onClick={clearPending}>Cancel</button>
                      </div>
                    </div>
                  </div>
                ) : selected ? (
                  <video
                    key={selected.id}
                    ref={videoRef}
                    src={`/api/videos/${selected.id}/media`}
                    controls
                    preload="metadata"
                    aria-label={selected.originalName}
                    onLoadedMetadata={(event) => {
                      if (pendingSeek.current !== null) {
                        event.currentTarget.currentTime = clampSeek(pendingSeek.current, event.currentTarget.duration);
                        pendingSeek.current = null;
                        event.currentTarget.play().catch(() => {});
                      }
                    }}
                    onError={(event) => {
                      const code = event.currentTarget.error?.code;
                      setPlayerError(code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE
                        ? "This browser cannot decode this video's codec (common with HEVC/H.265 in some browsers, ProRes, or MKV files). Search still works; result timestamps stay valid. Try Safari, or convert the file to H.264 MP4 and upload that copy."
                        : "The local video file could not be loaded. It may have been moved or deleted from the data folder.");
                    }}
                  />
                ) : (
                  <div className="player-empty">
                    <div className="frame-icon"><span>▶</span></div>
                    <h2>A place for your footage.</h2>
                    <p>Drop a video here, or select one to get started.</p>
                    <button className="primary-button" onClick={() => inputRef.current?.click()}>Select video <span>↗</span></button>
                    <small>MP4, MOV, M4V, WebM, or MKV · up to {formatBytes(maxUploadBytes)} · 4 seconds to 4 hours<br />You confirm before anything is uploaded. Videos are sent to TwelveLabs for indexing.</small>
                  </div>
                )}
              </div>
              <div className="player-caption">
                <span>{pending ? "Preview — not uploaded yet" : selected ? `${selected.originalName} · ${statusDetail(selected, now)}` : "No video selected"}</span>
                {!pending && selected && <span>{formatBytes(selected.sizeBytes)}{selected.durationSeconds ? ` · ${formatTimestamp(selected.durationSeconds)}` : ""}</span>}
              </div>
              {playerError && !pending && <p className="error-message" role="alert">{playerError}</p>}
              {activeSegment && !pending && (
                <div className="segment-bar" aria-live="polite">
                  <span>Selected segment <strong>{formatRange(activeSegment.startSeconds, activeSegment.endSeconds)}</strong></span>
                  <button className="secondary-button" onClick={() => seekTo(activeSegment.startSeconds)}>↺ Replay segment</button>
                </div>
              )}
              <form className="search-panel" aria-labelledby="search-title" onSubmit={runSearch}>
                <div className="search-head">
                  <label id="search-title" htmlFor="moment-query">What are you looking for?</label>
                  <div className="mode-toggle" role="radiogroup" aria-label="Search in">
                    {searchModes.map((option) => (
                      <button type="button" role="radio" key={option.value} aria-checked={mode === option.value} title={option.hint} className={mode === option.value ? "is-on" : ""} onClick={() => setMode(option.value)}>
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="search-input-row">
                  <span aria-hidden="true">⌕</span>
                  <input id="moment-query" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={500} disabled={selected?.status !== "ready"} placeholder="Describe a moment in your video…" autoComplete="off" />
                  <button type="submit" disabled={selected?.status !== "ready" || searching || !query.trim()}>{searching ? "Searching…" : <>Search <span>↗</span></>}</button>
                </div>
                <p className="helper">{searchHelper}</p>
                {searchError && <p className="error-message" role="alert">{searchError}</p>}
                <div className="suggestions" aria-label="Example searches">
                  <span className="suggestions-label">Examples:</span>
                  {suggestions.map((text) => (
                    <button type="button" key={text} onClick={() => setQuery(text)} disabled={selected?.status !== "ready"}>{text}</button>
                  ))}
                </div>
              </form>
            </section>
            <aside className={`results-panel ${searching ? "is-loading" : ""}`} aria-label="Search results" aria-busy={searching}>
              <div className="results-heading"><h2>Matching moments</h2><span className="count">{visibleResults?.segments.length ?? 0}</span></div>
              {searching && <div className="results-loading" role="status"><span className="spinner" aria-hidden="true" /> Searching TwelveLabs…</div>}
              {visibleResults ? (
                visibleResults.segments.length ? (
                  <ol className="results-list">
                    {visibleResults.segments.map((segment, index) => (
                      <li key={`${segment.startSeconds}-${segment.endSeconds}-${index}`}>
                        <button className={`result-card ${index === activeIndex ? "is-active" : ""}`} onClick={() => playSegment(index)} aria-pressed={index === activeIndex}>
                          <span className="result-thumb">
                            {segment.thumbnailUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={segment.thumbnailUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} />
                            ) : null}
                            <span className="thumb-fallback">{formatTimestamp(segment.startSeconds)}</span>
                          </span>
                          <span className="result-body">
                            <strong>{formatRange(segment.startSeconds, segment.endSeconds)}</strong>
                            {segment.rank !== undefined && <span className="result-rank" title="TwelveLabs relevance rank: 1 is the most relevant match. It is not a confidence score.">Rank {segment.rank}</span>}
                            {segment.transcription && <span className="result-transcript">“{segment.transcription}”</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="results-empty">
                    <h3>No matching moments.</h3>
                    <p>TwelveLabs found nothing relevant for “{visibleResults.query}” in this video. Try describing what is visible or said in different words.</p>
                  </div>
                )
              ) : !searching ? (
                <div className="results-empty"><span className="results-symbol" aria-hidden="true">⌕</span><h3>The right moment<br />starts with a search.</h3><p>Matching segments and timestamps appear here. Click one to play it.</p></div>
              ) : null}
              {visibleResults?.notes.map((note) => <p key={note} className="results-note">{note}</p>)}
              <div className="results-footnote">{visibleResults ? `Results for “${visibleResults.query}” in ${searchModes.find((m) => m.value === visibleResults.mode)?.label.toLowerCase()} · ordered by TwelveLabs rank` : "Only real TwelveLabs results are shown."}</div>
            </aside>
          </div>
          <section className="setup-panel" aria-labelledby="setup-title">
            <div>
              <span className="setup-icon" aria-hidden="true">⚙</span>
              <div>
                <h2 id="setup-title">{apiKeyConfigured ? "TwelveLabs key configured on the server." : "TwelveLabs is not configured."}</h2>
                <p>{apiKeyConfigured
                  ? "Uploaded videos are stored in the local data folder and sent to TwelveLabs for indexing. Indexing continues on the server if you close this tab."
                  : "Add TWELVELABS_API_KEY to .env.local and restart the server to enable uploads, indexing, and search. The key stays on the server."}</p>
              </div>
            </div>
            <span className="setup-status">{apiKeyConfigured ? "KEY CONFIGURED" : "NOT CONNECTED"}</span>
          </section>
        </div>
      </main>
      {deleting && <DeleteDialog video={deleting} onCancel={() => setDeleting(null)} onConfirm={confirmDelete} />}
    </div>
  );
}
