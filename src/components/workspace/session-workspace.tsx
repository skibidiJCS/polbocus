"use client";

import { upload, uploadPresigned } from "@vercel/blob/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, formatElapsed, formatRange } from "@/lib/time";
import { ApiError, type SearchMode } from "./client-api";
import { DropOverlay } from "./drop-overlay";
import { Logo } from "./logo";
import { Player, type PlayerHandle } from "./player";
import { MomentsPanel, SearchForm, visibleSegments, type Results } from "./search-panels";

/**
 * Hosted, one-time use: one video at a time, nothing kept. The file plays from this
 * computer; TwelveLabs indexes a copy that is deleted when the page is left.
 */
const TYPES: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm", mkv: "video/x-matroska" };
const ACCEPT = "video/mp4,video/quicktime,video/x-m4v,video/webm,video/x-matroska,.mp4,.mov,.m4v,.webm,.mkv";
const MAX_BYTES = 4_000_000_000;

type Stage =
  | { kind: "empty" }
  | { kind: "shrinking"; fraction: number }
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

/** Reads a video's length from its metadata; null if the browser can't tell. */
function durationOf(url: string) {
  return new Promise<number | null>((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    const done = (value: number | null) => { video.removeAttribute("src"); video.load(); resolve(value); };
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null);
    video.onerror = () => done(null);
    setTimeout(() => done(null), 5000);
    video.src = url;
  });
}

function extensionOf(file: File) {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (TYPES[ext]) return ext;
  return Object.entries(TYPES).find(([, type]) => type === file.type)?.[0] ?? null;
}

export function SessionWorkspace({ presignedUploads }: { presignedUploads: boolean }) {
  const [local, setLocal] = useState<LocalFile | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "empty" });
  const [now, setNow] = useState(() => Date.now());
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
  // Results per query and mode for this video: asking again costs no API request.
  const searchCache = useRef(new Map<string, { segments: Results["segments"]; notes: string[] }>());
  // A search typed while the video is still being prepared; it runs once ready.
  const [pending, setPending] = useState<{ text: string; mode: SearchMode } | null>(null);

  const ready = stage.kind === "ready";
  const busy = stage.kind === "shrinking" || stage.kind === "uploading" || stage.kind === "processing" || stage.kind === "indexing";

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
    setPending(null);
    searchCache.current.clear();
  }, [endSession]);


  async function watchIndexing(signal: AbortSignal, duration: number | null) {
    let failures = 0;
    let indexing = false;
    // Preparing takes seconds, so check often. Indexing takes roughly as long as the video,
    // so the first check waits for half of it and later checks scale with its length:
    // short clips still turn ready within seconds, long ones don't spend requests.
    const seconds = duration ?? 60;
    const nextDelay = (enteredIndexing: boolean) =>
      !indexing ? 1500 : enteredIndexing ? Math.min(90_000, Math.max(3000, seconds * 500)) : Math.min(10_000, Math.max(2000, seconds * 70));
    let delay = 1000;
    while (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (signal.aborted) return;
      try {
        const status = await post<{ stage: string; indexedAssetId?: string; providerStatus?: string; durationSeconds?: number | null; message?: string }>(
          "/api/session/status", session.current, signal);
        failures = 0;
        const enteredIndexing = !indexing && status.stage === "indexing";
        if (status.stage === "indexing") indexing = true;
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
        delay = nextDelay(enteredIndexing);
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

  async function startUpload(local: LocalFile) {
    const controller = new AbortController();
    work.current = controller;
    try {
      // Large, high-resolution files are shrunk to 720p first: far less to upload.
      let file = local.file;
      if (file.size >= 25_000_000) {
        setStage({ kind: "shrinking", fraction: 0 });
        const { shrinkVideo } = await import("./shrink");
        file = (await shrinkVideo(file, (fraction) => setStage({ kind: "shrinking", fraction }), controller.signal)) ?? file;
        if (controller.signal.aborted) return;
      }
      const ext = extensionOf(file)!;
      setStage({ kind: "uploading", loaded: 0, total: file.size });
      const send = presignedUploads ? uploadPresigned : upload;
      const blob = await send(`sessions/${crypto.randomUUID()}.${ext}`, file, {
        access: "private",
        handleUploadUrl: "/api/session/upload",
        contentType: TYPES[ext],
        // Parallel parts upload faster; each part must be at least 5 MB.
        multipart: file.size > 10_000_000,
        abortSignal: controller.signal,
        onUploadProgress: ({ loaded, total }) => setStage({ kind: "uploading", loaded, total }),
      });
      session.current = { pathname: blob.pathname };
      setStage({ kind: "processing", since: Date.now() });
      const started = await post<{ assetId: string; indexId: string }>("/api/session/start", { pathname: blob.pathname, filename: local.file.name }, controller.signal);
      session.current = { ...session.current, assetId: started.assetId, indexId: started.indexId };
      await watchIndexing(controller.signal, local.duration ?? (await durationOf(local.url)));
    } catch (error) {
      if (controller.signal.aborted) return;
      setStage({ kind: "failed", message: error instanceof Error ? error.message : "Upload failed." });
    }
  }

  function choose(file?: File) {
    if (!file) return;
    if (busy) return setNotice("Wait for the current video to finish, or start over with “New video”.");
    if (!extensionOf(file)) return setNotice("That isn’t a supported video. Use MP4, MOV, M4V, WebM, or MKV.");
    if (file.size > MAX_BYTES) return setNotice(`That file is ${formatBytes(file.size)}; the limit is 4 GB.`);
    reset();
    setNotice(null);
    const next = { file, url: URL.createObjectURL(file), duration: null };
    setLocal(next);
    // Start right away: the drop zone already says the video goes to TwelveLabs.
    void startUpload(next);
  }

  function runSearch(event?: React.FormEvent) {
    event?.preventDefault();
    const text = query.trim();
    if (!text) return queryRef.current?.focus();
    if (busy) return setPending({ text, mode });
    void search(text, mode);
  }

  async function search(text: string, mode: SearchMode) {
    const { indexId, indexedAssetId } = session.current;
    if (!indexId || !indexedAssetId) return;
    const key = `${mode}\n${text.toLowerCase().replace(/\s+/g, " ")}`;
    const show = (result: { segments: Results["segments"]; notes: string[] }) => {
      setResults({ id: ++searchCount.current, query: text, mode, segments: result.segments, notes: result.notes });
      setActiveIndex(null);
      setHoverIndex(null);
    };
    const cached = searchCache.current.get(key);
    searchAbort.current?.abort();
    setPending(null);
    setSearchError(null);
    if (cached) {
      setSearching(false);
      return show(cached);
    }
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearching(true);
    try {
      const result = await post<{ segments: Results["segments"]; notes: string[] }>("/api/session/search", {
        indexId, videoId: indexedAssetId, query: text, mode, durationSeconds: local?.duration ?? session.current.durationSeconds ?? null,
      }, controller.signal);
      searchCache.current.set(key, { segments: result.segments, notes: result.notes });
      show(result);
    } catch (error) {
      if (!controller.signal.aborted) setSearchError(error instanceof Error ? error.message : "Search failed.");
    } finally {
      if (searchAbort.current === controller) setSearching(false);
    }
  }

  // Run a search typed during preparation as soon as the video is ready.
  useEffect(() => {
    if (ready && pending) void search(pending.text, pending.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- search reads refs and current state
  }, [ready, pending]);

  // The tab title says when the video is ready, so waiting can happen in another tab.
  useEffect(() => {
    document.title = ready ? "Ready · polbocus" : stage.kind === "failed" ? "Failed · polbocus" : "polbocus";
  }, [ready, stage.kind]);

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

  const percent = stage.kind === "uploading" && stage.total > 0 ? Math.min(100, Math.floor((stage.loaded / stage.total) * 100))
    : stage.kind === "shrinking" ? Math.floor(stage.fraction * 100) : 0;
  let statusLine = "";
  if (stage.kind === "shrinking") statusLine = `Shrinking ${percent}%`;
  else if (stage.kind === "uploading") statusLine = `Uploading ${percent}%`;
  else if (stage.kind === "processing") statusLine = `Preparing · ${formatElapsed(now - stage.since)}`;
  else if (stage.kind === "indexing") statusLine = `Indexing · ${formatElapsed(now - stage.since)}`;
  else if (stage.kind === "ready") statusLine = "Ready";
  else if (stage.kind === "failed") statusLine = "Failed";
  const tone = stage.kind === "ready" ? "is-ready" : stage.kind === "failed" ? "is-failed" : busy ? "is-busy" : "";
  const active = results && activeIndex !== null ? results.segments[activeIndex] : null;

  return (
    <div className="app">
      <header className="topbar">
        <Logo />
        <nav className="topbar-actions">
          {local && <button className="btn btn-ghost btn-sm" onClick={reset}>New video</button>}
          <button className="btn-text" onClick={signOut}>Sign out</button>
        </nav>
      </header>
      <input ref={inputRef} className="sr-only" type="file" accept={ACCEPT} aria-label="Choose a video" onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ""; }} />

      {!local ? (
        <main className="page page-empty">
          <section className="dropzone">
            <h1>Find any moment in a video.</h1>
            <button className="dropzone-target" onClick={() => inputRef.current?.click()}>
              <span className="dropzone-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 15V4" /><path d="M7.5 8.5 12 4l4.5 4.5" /><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
                </svg>
              </span>
              <span className="dropzone-title">Drop a video or <u>choose a file</u></span>
              <span className="dropzone-sub">Up to 4 GB. Indexed by TwelveLabs and deleted when you leave.</span>
            </button>
          </section>
        </main>
      ) : (
        <main className="page workbench">
          <section className="viewer" aria-label="Video">
            <header className="viewer-head">
              <h1 title={local.file.name}>{local.file.name}</h1>
              <p className={`status ${tone}`} aria-live="polite">{statusLine}</p>
            </header>
            <Player
              ref={playerRef}
              src={local.url}
              label={local.file.name}
              fallbackDuration={local.duration}
              segments={visibleSegments(results)}
              activeIndex={activeIndex}
              hoverIndex={hoverIndex}
              onHover={setHoverIndex}
              onSelect={playSegment}
              mediaError={mediaError}
              onMediaError={setMediaError}
              onDuration={(duration) => {
                setLocal((current) => (current ? { ...current, duration } : current));
                if (duration < 4 || duration > 4 * 3600) {
                  work.current?.abort();
                  endSession(false);
                  setStage({ kind: "failed", message: duration < 4 ? "Videos need to be at least 4 seconds long." : "Videos can be up to 4 hours long." });
                }
              }}
            />
            {(stage.kind === "uploading" || stage.kind === "shrinking") && (
              <div className="bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={stage.kind === "shrinking" ? "Shrinking progress" : "Upload progress"}>
                <span style={{ transform: `scaleX(${percent / 100})` }} />
              </div>
            )}
            {stage.kind === "failed" && (
              <div className="callout is-error">
                <p>{stage.message}</p>
                <button className="btn btn-ghost btn-sm" onClick={reset}>Try another video</button>
              </div>
            )}
            {active && (
              <div className="segment-line">
                <span className="mono">{formatRange(active.startSeconds, active.endSeconds)}</span>
                <button className="btn-text" onClick={() => playerRef.current?.seekTo(active.startSeconds)}>Replay</button>
              </div>
            )}
            {stage.kind !== "failed" && (
              <SearchForm
                inputRef={queryRef}
                canSearch={ready || busy}
                waiting={pending ? pending.text : null}
                searching={searching}
                query={query}
                onQuery={(value) => { setQuery(value); queryRef.current?.focus(); }}
                mode={mode}
                onMode={setMode}
                onSubmit={runSearch}
                error={searchError}
              />
            )}
          </section>
          <MomentsPanel results={results} searching={searching} activeIndex={activeIndex} hoverIndex={hoverIndex} onHover={setHoverIndex} onPlay={playSegment} onExpand={() => setResults((current) => (current ? { ...current, expanded: true } : current))} />
        </main>
      )}

      <DropOverlay onFile={choose} />
      <div className="toast-region" aria-live="polite">
        {notice && (
          <div className="toast is-error" role="alert">
            <p>{notice}</p>
            <button className="btn-text" onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        )}
      </div>
    </div>
  );
}
