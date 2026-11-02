"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { formatBytes, formatRange, formatTimestamp } from "@/lib/time";
import type { SearchSegment, VideoSummary } from "@/types/video";
import { ApiError, deleteVideo, fetchVideos, retryVideo, searchMoments, uploadVideo, type SearchMode } from "./client-api";
import { DeleteDialog } from "./delete-dialog";
import { Player, type PlayerHandle } from "./player";
import { isInProgress, statusDetail, VideoLibrary, type UploadingItem } from "./video-library";

const searchModes: { value: SearchMode; label: string; hint: string }[] = [
  { value: "all", label: "everything", hint: "What is seen, heard, and said" },
  { value: "visual", label: "what’s seen", hint: "Only what appears on screen" },
  { value: "speech", label: "what’s said", hint: "Only spoken words" },
];
const examples = ["someone drops their phone", "a person walks through a doorway", "outdoors, at night", "someone mentions the deadline"];
const ACCEPT = "video/mp4,video/quicktime,video/x-m4v,video/webm,video/x-matroska,.mp4,.mov,.m4v,.webm,.mkv";
const SELECTED_KEY = "footage.selectedVideo";

interface PendingFile {
  file: File;
  url: string;
  duration: number | null;
}

interface Results {
  id: number;
  videoId: string;
  query: string;
  mode: SearchMode;
  segments: SearchSegment[];
  notes: string[];
}

interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
}

function readStoredSelection() {
  try {
    return window.localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

const noopSubscribe = () => () => {};

function storeSelection(id: string) {
  try {
    window.localStorage.setItem(SELECTED_KEY, id);
  } catch {
    // Remembering the selection is a convenience only.
  }
}

export function Workspace({ apiKeyConfigured, maxUploadBytes, initialVideos }: { apiKeyConfigured: boolean; maxUploadBytes: number; initialVideos: VideoSummary[] }) {
  const [videos, setVideos] = useState<VideoSummary[]>(initialVideos);
  // null until the user picks a video; falls back to the remembered or newest one.
  const [chosenId, setChosenId] = useState<string | null>(null);
  const storedId = useSyncExternalStore(noopSubscribe, readStoredSelection, () => null);
  const [pending, setPending] = useState<PendingFile | null>(null);
  const [upload, setUpload] = useState<UploadingItem | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
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
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const playerRef = useRef<PlayerHandle>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const pendingUrl = useRef<string | null>(null);
  const searchCount = useRef(0);

  const selectedId = [chosenId, storedId].find((id) => id && videos.some((video) => video.id === id)) ?? videos[0]?.id ?? null;
  const selected = videos.find((video) => video.id === selectedId) ?? null;
  const anyInProgress = videos.some(isInProgress);
  const visible = results && results.videoId === selectedId ? results : null;
  const activeSegment = visible && activeIndex !== null ? visible.segments[activeIndex] ?? null : null;
  const canSearch = selected?.status === "ready" && !pending;

  const notify = useCallback((kind: Toast["kind"], text: string) => setToast({ id: Date.now(), kind, text }), []);

  const refresh = useCallback(async () => {
    try {
      setVideos(await fetchVideos());
    } catch {
      // Keep the last known library; the next poll tries again.
    }
  }, []);

  // Poll while anything is in progress. Indexing runs on the server and continues if this tab closes.
  useEffect(() => {
    if (!anyInProgress) return;
    const poll = setInterval(refresh, 3000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [anyInProgress, refresh]);

  useEffect(() => {
    if (!toast || toast.kind === "error") return;
    const timer = setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

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

  const clearPending = useCallback(() => {
    if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
    pendingUrl.current = null;
    setPending(null);
  }, []);

  const chooseFile = useCallback((candidate?: File) => {
    if (!candidate) return;
    if (upload) return notify("error", "One upload at a time — wait for the current one to finish.");
    if (!apiKeyConfigured) return notify("error", "Add TWELVELABS_API_KEY to .env.local and restart the server to upload.");
    if (candidate.type && !candidate.type.startsWith("video/")) return notify("error", "That isn’t a video. Use MP4, MOV, M4V, WebM, or MKV.");
    if (candidate.size > maxUploadBytes) return notify("error", `That file is ${formatBytes(candidate.size)}; the limit is ${formatBytes(maxUploadBytes)}.`);
    clearPending();
    const url = URL.createObjectURL(candidate);
    pendingUrl.current = url;
    setPending({ file: candidate, url, duration: null });
  }, [apiKeyConfigured, clearPending, maxUploadBytes, notify, upload]);

  // Drop a file anywhere in the window.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => { if (!hasFiles(event)) return; depth++; setDragging(true); };
    const over = (event: DragEvent) => { if (hasFiles(event)) event.preventDefault(); };
    const leave = (event: DragEvent) => { if (!hasFiles(event)) return; depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      chooseFile(event.dataTransfer?.files[0]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [chooseFile]);

  function selectVideo(id: string) {
    clearPending();
    setChosenId(id);
    storeSelection(id);
    setActiveIndex(null);
    setHoverIndex(null);
    setMediaError(null);
    setSearchError(null);
  }

  async function startUpload() {
    if (!pending) return;
    const file = pending.file;
    const { promise, abort } = uploadVideo(file, (loaded, total) => setUpload((current) => (current ? { ...current, loaded, total } : current)));
    setUpload({ name: file.name, loaded: 0, total: file.size, abort });
    clearPending();
    try {
      const { video, duplicate } = await promise;
      if (duplicate) notify("info", `Already in your library as “${video.originalName}” — nothing was uploaded again.`);
      await refresh();
      selectVideo(video.id);
    } catch (uploadError) {
      notify("error", uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setUpload(null);
    }
  }

  async function runSearch(event?: React.FormEvent) {
    event?.preventDefault();
    if (!selected || !canSearch || searching) return;
    const text = query.trim();
    if (!text) {
      queryRef.current?.focus();
      return;
    }
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await searchMoments(selected.id, text, mode, controller.signal);
      setResults({ id: ++searchCount.current, videoId: selected.id, query: text, mode, segments: result.segments, notes: result.notes });
      setActiveIndex(null);
      setHoverIndex(null);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setSearchError(failure instanceof ApiError ? failure.message : "Search failed. Is the local server running?");
    } finally {
      if (searchAbort.current === controller) setSearching(false);
    }
  }

  function playSegment(index: number) {
    if (!visible) return;
    setActiveIndex(index);
    playerRef.current?.seekTo(visible.segments[index].startSeconds);
  }

  async function retry(id: string) {
    setRetrying(id);
    try {
      await retryVideo(id);
      await refresh();
    } catch (retryError) {
      notify("error", retryError instanceof Error ? retryError.message : "Retry failed.");
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
      notify("info", `Deleted “${deleting.originalName}”. ${result.message}`);
      if (results?.videoId === deleting.id) setResults(null);
      setDeleting(null);
      await refresh();
      return null;
    } catch (deleteError) {
      return deleteError instanceof Error ? deleteError.message : "Delete failed.";
    }
  }

  const durationWarning = pending?.duration != null
    ? pending.duration < 4 ? "TwelveLabs needs at least 4 seconds of video." : pending.duration > 4 * 3600 ? "TwelveLabs accepts up to 4 hours." : null
    : null;

  let queryStatus: string;
  if (!selected) queryStatus = "Add a video to begin.";
  else if (pending) queryStatus = "Confirm the upload first.";
  else if (selected.status === "ready") queryStatus = mode === "all" ? "Mixed results lean visual — for something said, search what’s said." : "Each search is one TwelveLabs request.";
  else if (selected.status === "failed") queryStatus = "Indexing failed — retry it from the library.";
  else queryStatus = `Search opens when indexing finishes. ${statusDetail(selected, now)}.`;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-head">
          <span className="wordmark">footage</span>
          <button className="add-video" onClick={() => inputRef.current?.click()} disabled={Boolean(upload)}>
            <span aria-hidden="true">+</span> Add video
          </button>
        </div>
        <input ref={inputRef} className="sr-only" type="file" accept={ACCEPT} aria-label="Choose a video to upload" onChange={(event) => { chooseFile(event.target.files?.[0]); event.target.value = ""; }} />
        <div className="rail-label"><span>Library</span><span>{videos.length || ""}</span></div>
        {videos.length || upload ? (
          <VideoLibrary videos={videos} selectedId={pending ? null : selectedId} now={now} upload={upload} onSelect={selectVideo} onRetry={retry} onDelete={setDeleting} retrying={retrying} />
        ) : (
          <p className="rail-empty">Nothing here yet.</p>
        )}
        <p className="rail-foot">
          <span className={`conn-dot ${apiKeyConfigured ? "is-on" : ""}`} aria-hidden="true" />
          {apiKeyConfigured ? "TwelveLabs key set" : "No TwelveLabs key"} · local
        </p>
      </aside>

      <main className="stage">
        <section className="stage-main" aria-label="Video">
          {pending ? (
            <div className="confirm">
              <div className="player-well">
                <video src={pending.url} controls muted preload="metadata" aria-label={`Preview of ${pending.file.name}`}
                  onLoadedMetadata={(event) => { const d = event.currentTarget.duration; setPending((current) => (current ? { ...current, duration: Number.isFinite(d) ? d : null } : current)); }} />
              </div>
              <div className="confirm-bar">
                <div>
                  <p className="confirm-title">{pending.file.name}</p>
                  <p className="confirm-text">
                    {formatBytes(pending.file.size)}{pending.duration ? ` · ${formatTimestamp(pending.duration)}` : ""}. A copy stays on this computer and the video is sent to TwelveLabs to be indexed.
                  </p>
                  {durationWarning && <p className="confirm-text is-warning">{durationWarning}</p>}
                </div>
                <div className="confirm-actions">
                  <button className="button-solid" onClick={startUpload} disabled={Boolean(durationWarning)}>Upload &amp; index</button>
                  <button className="link-button" onClick={clearPending}>Cancel</button>
                </div>
              </div>
            </div>
          ) : selected ? (
            <>
              <header className="stage-head">
                <h1 title={selected.originalName}>{selected.originalName}</h1>
                <p className={`stage-status status-${selected.status}`}>
                  {selected.status !== "ready" && <span className="status-dot" aria-hidden="true" />}
                  {selected.status === "ready" ? `${selected.durationSeconds ? formatTimestamp(selected.durationSeconds) + " · " : ""}${formatBytes(selected.sizeBytes)} · indexed` : statusDetail(selected, now)}
                </p>
              </header>
              <Player
                key={selected.id}
                ref={playerRef}
                src={`/api/videos/${selected.id}/media`}
                label={selected.originalName}
                fallbackDuration={selected.durationSeconds}
                segments={visible?.segments ?? []}
                activeIndex={activeIndex}
                hoverIndex={hoverIndex}
                onHover={setHoverIndex}
                onSelect={playSegment}
                mediaError={mediaError}
                onMediaError={setMediaError}
              />
              <div className={`segment-line ${activeSegment ? "is-visible" : ""}`} aria-live="polite">
                {activeSegment && (
                  <>
                    <span>Moment {String(activeIndex! + 1).padStart(2, "0")}</span>
                    <span className="mono">{formatRange(activeSegment.startSeconds, activeSegment.endSeconds)}</span>
                    <button className="link-button" onClick={() => playerRef.current?.seekTo(activeSegment.startSeconds)}>Replay segment</button>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="welcome">
              <h1>Drop a video <em>anywhere.</em></h1>
              <p>Then describe a moment in it — something seen, or something said — and jump straight there.</p>
              <button className="button-solid" onClick={() => inputRef.current?.click()} disabled={!apiKeyConfigured}>Choose a file</button>
              <p className="welcome-fine">
                MP4 · MOV · M4V · WebM · MKV &nbsp;—&nbsp; up to {formatBytes(maxUploadBytes)} &nbsp;—&nbsp; 4 seconds to 4 hours
                <br />You’ll confirm before anything is uploaded. Videos are indexed by TwelveLabs.
                {!apiKeyConfigured && <><br />Add TWELVELABS_API_KEY to .env.local and restart to enable uploads.</>}
              </p>
            </div>
          )}

          <form className={`query ${canSearch ? "" : "is-disabled"} ${searching ? "is-searching" : ""}`} onSubmit={runSearch} role="search">
            <div className="query-line">
              <label htmlFor="moment-query" className="query-lead">Find the moment</label>
              <input
                ref={queryRef}
                id="moment-query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                maxLength={500}
                disabled={!canSearch}
                placeholder={canSearch ? "someone drops their phone" : "once a video is ready"}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="query-go" disabled={!canSearch || searching || !query.trim()}>
                {searching ? "Searching" : "Search ↵"}
              </button>
              <span className="query-rule" aria-hidden="true" />
            </div>
            <div className="query-meta">
              <div className="modes" role="radiogroup" aria-label="Search in">
                <span className="faint">in</span>
                {searchModes.map((option) => (
                  <button key={option.value} type="button" role="radio" aria-checked={mode === option.value} title={option.hint} className={mode === option.value ? "is-on" : ""} onClick={() => setMode(option.value)}>
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="query-status">{queryStatus}</p>
            </div>
            {canSearch && (
              <div className="examples">
                <span className="faint">Examples</span>
                {examples.map((text) => (
                  <button type="button" key={text} onClick={() => { setQuery(text); queryRef.current?.focus(); }}>{text}</button>
                ))}
              </div>
            )}
            {searchError && <p className="inline-error" role="alert">{searchError}</p>}
          </form>
        </section>

        {selected && !pending && <section className={`moments ${searching ? "is-loading" : ""}`} aria-label="Matching moments" aria-busy={searching}>
          <header className="moments-head">
            <h2>Moments</h2>
            {visible && <span className="mono faint">{visible.segments.length}</span>}
          </header>
          {visible ? (
            visible.segments.length ? (
              <ol className="moment-list" key={visible.id}>
                {visible.segments.map((segment, index) => {
                  const state = index === activeIndex ? "is-active" : index === hoverIndex ? "is-hover" : "";
                  return (
                    <li key={`${segment.startSeconds}-${index}`} style={{ ["--i" as string]: index }}>
                      <button
                        className={`moment ${state}`}
                        onClick={() => playSegment(index)}
                        onMouseEnter={() => setHoverIndex(index)}
                        onMouseLeave={() => setHoverIndex(null)}
                        aria-pressed={index === activeIndex}
                        title={segment.rank !== undefined ? `TwelveLabs rank ${segment.rank} (1 = most relevant). Not a confidence score.` : undefined}
                      >
                        <span className="moment-index">{String(index + 1).padStart(2, "0")}</span>
                        <span className="moment-body">
                          <span className="moment-time">{formatRange(segment.startSeconds, segment.endSeconds)}</span>
                          {segment.transcription && <span className="moment-quote">“{segment.transcription}”</span>}
                        </span>
                        <span className="moment-thumb">
                          <span className="moment-thumb-fallback">{formatTimestamp(segment.startSeconds)}</span>
                          {segment.thumbnailUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={segment.thumbnailUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} />
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="moments-empty">
                <p className="serif">Nothing matched “{visible.query}”.</p>
                <p>Try describing what’s visible or said in other words{visible.mode !== "all" ? ", or search everything" : ""}.</p>
              </div>
            )
          ) : (
            <div className="moments-empty">
              <p className="serif">{selected?.status === "ready" ? "Moments you find will gather here." : "Nothing to search yet."}</p>
              {selected?.status === "ready" && <p>Click one to play it from that point.</p>}
            </div>
          )}
          {visible?.notes.map((note) => <p key={note} className="moments-note">{note}</p>)}
          {visible && visible.segments.length > 0 && (
            <p className="moments-foot">Ordered by TwelveLabs relevance rank, most relevant first. Ranks are not confidence scores.</p>
          )}
        </section>}
      </main>

      <div className={`drop-veil ${dragging ? "is-on" : ""}`} aria-hidden="true">
        <p>Release to add this video</p>
      </div>

      <div className="toast-region" aria-live="polite">
        {toast && (
          <div key={toast.id} className={`toast ${toast.kind === "error" ? "is-error" : ""}`} role={toast.kind === "error" ? "alert" : "status"}>
            <p>{toast.text}</p>
            <button className="link-button" onClick={() => setToast(null)} aria-label="Dismiss">Close</button>
          </div>
        )}
      </div>

      {deleting && <DeleteDialog video={deleting} onCancel={() => setDeleting(null)} onConfirm={confirmDelete} />}
    </div>
  );
}
