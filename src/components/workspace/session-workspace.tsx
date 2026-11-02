"use client";

import { upload } from "@vercel/blob/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, formatElapsed, formatRange, formatTimestamp } from "@/lib/time";
import { ApiError, type SearchMode } from "./client-api";
import { Player, type PlayerHandle } from "./player";
import { MomentsPanel, SearchForm, type Results } from "./search-panels";

/**
 * Hosted, one-time use: one video at a time, nothing kept. The file plays from this
 * computer; TwelveLabs indexes a copy that is deleted when the page is left.
 */
const TYPES: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm", mkv: "video/x-matroska" };
const ACCEPT = "video/mp4,video/quicktime,video/x-m4v,video/webm,video/x-matroska,.mp4,.mov,.m4v,.webm,.mkv";
const MAX_BYTES = 4_000_000_000;

type Stage =
  | { kind: "empty" }
  | { kind: "confirm" }
  | { kind: "uploading"; loaded: number; total: number }
  | { kind: "processing"; since: number }
  | { kind: "indexing"; since: number; providerStatus: string }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

interface LocalFile {
  file: File;
  url: string;
  duration: number | null;
}

interface Session {
  pathname?: string;
  assetId?: string;
  indexId?: string;
  indexedAssetId?: string;
  durationSeconds?: number | null;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; retryAfterSeconds?: number };
  if (!response.ok) throw new ApiError(data.error || `Request failed (${response.status}).`, response.status, data.retryAfterSeconds);
  return data;
}

function extensionOf(file: File) {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (TYPES[ext]) return ext;
  return Object.entries(TYPES).find(([, type]) => type === file.type)?.[0] ?? null;
}

export function SessionWorkspace() {
  const [local, setLocal] = useState<LocalFile | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "empty" });
  const [now, setNow] = useState(() => Date.now());
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("all");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const session = useRef<Session>({});
  const work = useRef<AbortController | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const playerRef = useRef<PlayerHandle>(null);
  const searchCount = useRef(0);

  const ready = stage.kind === "ready";
  const busy = stage.kind === "uploading" || stage.kind === "processing" || stage.kind === "indexing";

  /** Deletes the TwelveLabs copy and any leftover upload. Beacon form survives page unload. */
  const endSession = useCallback((viaBeacon: boolean) => {
    const { assetId, pathname } = session.current;
    session.current = {};
    if (!assetId && !pathname) return;
    const body = JSON.stringify({ assetId, pathname });
    if (viaBeacon && navigator.sendBeacon) navigator.sendBeacon("/api/session/end", new Blob([body], { type: "text/plain" }));
    else void fetch("/api/session/end", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
  }, []);

  // Leaving the page (close, reload, navigate away) ends the session.
  useEffect(() => {
    const leave = () => {
      work.current?.abort();
      endSession(true);
    };
    // A page restored from the back/forward cache has already been cleaned up.
    const restore = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", restore);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", restore);
    };
  }, [endSession]);

  // Warn before leaving only while work is in progress (the result would be lost).
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.removeEventListener("beforeunload", warn);
      clearInterval(clock);
    };
  }, [busy]);

  const reset = useCallback(() => {
    work.current?.abort();
    searchAbort.current?.abort();
    endSession(false);
    setLocal((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
    setStage({ kind: "empty" });
    setResults(null);
    setActiveIndex(null);
    setHoverIndex(null);
    setMediaError(null);
    setSearchError(null);
  }, [endSession]);

  const choose = useCallback((file?: File) => {
    if (!file) return;
    if (busy) return setNotice("Wait for the current video to finish, or start over with “New video”.");
    if (!extensionOf(file)) return setNotice("That isn’t a supported video. Use MP4, MOV, M4V, WebM, or MKV.");
    if (file.size > MAX_BYTES) return setNotice(`That file is ${formatBytes(file.size)}; the limit is 4 GB.`);
    reset();
    setNotice(null);
    setLocal({ file, url: URL.createObjectURL(file), duration: null });
    setStage({ kind: "confirm" });
  }, [busy, reset]);

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
      choose(event.dataTransfer?.files[0]);
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
  }, [choose]);

  async function watchIndexing(signal: AbortSignal) {
    let failures = 0;
    let delay = 2000;
    while (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (signal.aborted) return;
      try {
        const status = await post<{ stage: string; indexedAssetId?: string; providerStatus?: string; durationSeconds?: number | null; message?: string }>(
          "/api/session/status", session.current, signal);
        failures = 0;
        if (status.indexedAssetId) session.current.indexedAssetId = status.indexedAssetId;
        if (status.durationSeconds) session.current.durationSeconds = status.durationSeconds;
        if (status.stage === "processing") setStage((s) => (s.kind === "processing" ? s : { kind: "processing", since: Date.now() }));
        else if (status.stage === "indexing") {
          session.current.pathname = undefined; // TwelveLabs has its copy; the upload was removed.
          setStage((s) => ({ kind: "indexing", since: s.kind === "indexing" ? s.since : Date.now(), providerStatus: status.providerStatus ?? "pending" }));
        } else if (status.stage === "ready") {
          setStage({ kind: "ready" });
          return;
        } else if (status.stage === "failed") {
          setStage({ kind: "failed", message: status.message ?? "TwelveLabs could not index this video." });
          return;
        }
        delay = Math.min(delay + 1000, 5000);
      } catch (error) {
        if (signal.aborted) return;
        failures++;
        if (failures >= 5) {
          setStage({ kind: "failed", message: error instanceof Error ? error.message : "Lost contact with the server." });
          return;
        }
        delay = Math.min(delay * 2, 20_000);
      }
    }
  }

  async function startUpload() {
    if (!local) return;
    const ext = extensionOf(local.file)!;
    const controller = new AbortController();
    work.current = controller;
    setStage({ kind: "uploading", loaded: 0, total: local.file.size });
    try {
      const blob = await upload(`sessions/${crypto.randomUUID()}.${ext}`, local.file, {
        access: "private",
        handleUploadUrl: "/api/session/upload",
        contentType: TYPES[ext],
        multipart: local.file.size > 100_000_000,
        abortSignal: controller.signal,
        onUploadProgress: ({ loaded, total }) => setStage({ kind: "uploading", loaded, total }),
      });
      session.current = { pathname: blob.pathname };
      setStage({ kind: "processing", since: Date.now() });
      const started = await post<{ assetId: string; indexId: string }>("/api/session/start", { pathname: blob.pathname, filename: local.file.name }, controller.signal);
      session.current = { ...session.current, assetId: started.assetId, indexId: started.indexId };
      await watchIndexing(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      setStage({ kind: "failed", message: error instanceof Error ? error.message : "Upload failed." });
    }
  }

  async function runSearch(event?: React.FormEvent) {
    event?.preventDefault();
    const { indexId, indexedAssetId } = session.current;
    if (!ready || searching || !indexId || !indexedAssetId) return;
    const text = query.trim();
    if (!text) return queryRef.current?.focus();
    const controller = new AbortController();
    searchAbort.current?.abort();
    searchAbort.current = controller;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await post<{ segments: Results["segments"]; notes: string[] }>("/api/session/search", {
        indexId, videoId: indexedAssetId, query: text, mode, durationSeconds: local?.duration ?? session.current.durationSeconds ?? null,
      }, controller.signal);
      setResults({ id: ++searchCount.current, query: text, mode, segments: result.segments, notes: result.notes });
      setActiveIndex(null);
      setHoverIndex(null);
    } catch (error) {
      if (!controller.signal.aborted) setSearchError(error instanceof Error ? error.message : "Search failed.");
    } finally {
      if (searchAbort.current === controller) setSearching(false);
    }
  }

  function playSegment(index: number) {
    if (!results) return;
    setActiveIndex(index);
    playerRef.current?.seekTo(results.segments[index].startSeconds);
  }

  async function signOut() {
    reset();
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.replace("/login");
  }

  const percent = stage.kind === "uploading" && stage.total > 0 ? Math.min(100, Math.floor((stage.loaded / stage.total) * 100)) : 0;
  let statusLine = "";
  if (stage.kind === "uploading") statusLine = `Uploading · ${percent}%`;
  else if (stage.kind === "processing") statusLine = `TwelveLabs is receiving it · ${formatElapsed(now - stage.since)}`;
  else if (stage.kind === "indexing") statusLine = `Indexing${stage.providerStatus !== "indexing" ? ` · ${stage.providerStatus}` : ""} · ${formatElapsed(now - stage.since)}`;
  else if (stage.kind === "ready") statusLine = "Ready to search";
  else if (stage.kind === "failed") statusLine = "Failed";

  let queryStatus: string;
  if (stage.kind === "empty") queryStatus = "Add a video to begin.";
  else if (stage.kind === "confirm") queryStatus = "Upload it first.";
  else if (ready) queryStatus = mode === "all" ? "Mixed results lean visual — for something said, search what’s said." : "Each search is one TwelveLabs request.";
  else if (stage.kind === "failed") queryStatus = "This video couldn’t be indexed.";
  else queryStatus = `Search opens when indexing finishes. ${statusLine}.`;

  const durationWarning = local?.duration != null
    ? local.duration < 4 ? "TwelveLabs needs at least 4 seconds of video." : local.duration > 4 * 3600 ? "TwelveLabs accepts up to 4 hours." : null
    : null;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-head">
          <span className="wordmark">footage</span>
          <button className="add-video" onClick={() => (local ? reset() : inputRef.current?.click())}>
            <span aria-hidden="true">+</span> {local ? "New video" : "Add video"}
          </button>
        </div>
        <input ref={inputRef} className="sr-only" type="file" accept={ACCEPT} aria-label="Choose a video" onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ""; }} />
        <div className="rail-label"><span>This visit</span></div>
        {local ? (
          <ol className="library">
            <li className="library-item is-selected">
              <div className="library-select">
                <span className="library-index">01</span>
                <span className="library-body">
                  <span className="library-name" title={local.file.name}>{local.file.name}</span>
                  <span className="library-meta">{[local.duration ? formatTimestamp(local.duration) : null, formatBytes(local.file.size)].filter(Boolean).join(" · ")}</span>
                  {stage.kind !== "confirm" && (
                    <span className={`library-status ${stage.kind === "failed" ? "status-failed" : stage.kind === "ready" ? "is-ready" : "status-indexing"}`}>
                      <span className="status-dot" aria-hidden="true" />{statusLine}
                    </span>
                  )}
                  {stage.kind === "uploading" && <span className="upload-line"><span style={{ transform: `scaleX(${percent / 100})` }} /></span>}
                </span>
              </div>
            </li>
          </ol>
        ) : (
          <p className="rail-empty">Nothing yet.</p>
        )}
        <p className="rail-note">Nothing is kept. Your video is deleted from TwelveLabs when you leave or start a new one.</p>
        <p className="rail-foot">
          <span className="conn-dot is-on" aria-hidden="true" />
          Signed in · <button className="link-button" onClick={signOut}>Sign out</button>
        </p>
      </aside>

      <main className="stage">
        <section className="stage-main" aria-label="Video">
          {!local ? (
            <div className="welcome">
              <h1>Drop a video <em>anywhere.</em></h1>
              <p>Then describe a moment in it — something seen, or something said — and jump straight there. Nothing is kept after you leave.</p>
              <button className="button-solid" onClick={() => inputRef.current?.click()}>Choose a file</button>
              <p className="welcome-fine">MP4 · MOV · M4V · WebM · MKV &nbsp;—&nbsp; up to 4 GB &nbsp;—&nbsp; 4 seconds to 4 hours<br />The video is sent to TwelveLabs to be indexed, and deleted when you leave.</p>
            </div>
          ) : (
            <>
              <header className="stage-head">
                <h1 title={local.file.name}>{local.file.name}</h1>
                <p className={`stage-status ${ready ? "status-ready" : stage.kind === "failed" ? "status-failed" : stage.kind === "confirm" ? "" : "status-indexing"}`}>
                  {busy && <span className="status-dot" aria-hidden="true" />}
                  {stage.kind === "confirm" ? "Not uploaded yet" : statusLine}
                </p>
              </header>
              <Player
                ref={playerRef}
                src={local.url}
                label={local.file.name}
                fallbackDuration={local.duration}
                segments={results?.segments ?? []}
                activeIndex={activeIndex}
                hoverIndex={hoverIndex}
                onHover={setHoverIndex}
                onSelect={playSegment}
                mediaError={mediaError}
                onMediaError={setMediaError}
                onDuration={(duration) => setLocal((current) => (current ? { ...current, duration } : current))}
              />
              {stage.kind === "confirm" && (
                <div className="confirm-bar">
                  <p className="confirm-text">
                    The video will be sent to TwelveLabs to be indexed. That copy is deleted when you leave this page or start a new video.
                    {durationWarning && <span className="is-warning"> {durationWarning}</span>}
                  </p>
                  <div className="confirm-actions">
                    <button className="button-solid" onClick={startUpload} disabled={Boolean(durationWarning)}>Upload &amp; index</button>
                    <button className="link-button" onClick={reset}>Cancel</button>
                  </div>
                </div>
              )}
              {stage.kind === "uploading" && (
                <div className="progress-bar-wide" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
                  <span style={{ transform: `scaleX(${percent / 100})` }} />
                </div>
              )}
              {stage.kind === "failed" && (
                <div className="confirm-bar">
                  <p className="confirm-text is-error">{stage.message}</p>
                  <div className="confirm-actions"><button className="button-ghost" onClick={reset}>Start over</button></div>
                </div>
              )}
              <div className={`segment-line ${results && activeIndex !== null ? "is-visible" : ""}`} aria-live="polite">
                {results && activeIndex !== null && results.segments[activeIndex] && (
                  <>
                    <span>Moment {String(activeIndex + 1).padStart(2, "0")}</span>
                    <span className="mono">{formatRange(results.segments[activeIndex].startSeconds, results.segments[activeIndex].endSeconds)}</span>
                    <button className="link-button" onClick={() => playerRef.current?.seekTo(results.segments[activeIndex].startSeconds)}>Replay segment</button>
                  </>
                )}
              </div>
            </>
          )}

          <SearchForm
            inputRef={queryRef}
            canSearch={ready}
            searching={searching}
            query={query}
            onQuery={(value) => { setQuery(value); queryRef.current?.focus(); }}
            mode={mode}
            onMode={setMode}
            onSubmit={runSearch}
            status={queryStatus}
            error={searchError}
          />
        </section>

        {local && (
          <MomentsPanel results={results} searching={searching} ready={ready} activeIndex={activeIndex} hoverIndex={hoverIndex} onHover={setHoverIndex} onPlay={playSegment} />
        )}
      </main>

      <div className={`drop-veil ${dragging ? "is-on" : ""}`} aria-hidden="true"><p>Release to add this video</p></div>
      <div className="toast-region" aria-live="polite">
        {notice && (
          <div className="toast is-error" role="alert">
            <p>{notice}</p>
            <button className="link-button" onClick={() => setNotice(null)}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
