"use client";

import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { clampSeek, formatTimestamp } from "@/lib/time";
import type { SearchSegment } from "@/types/video";

export interface PlayerHandle {
  /** Seeks (waiting for metadata if needed) and plays. */
  seekTo: (seconds: number) => void;
}

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** Major ticks every `step` seconds (about 8 across), with minor ticks between. */
function rulerTicks(duration: number) {
  const step = TICK_STEPS.find((candidate) => duration / candidate <= 8) ?? 3600;
  const minorDivisions = step % 5 === 0 ? 5 : step % 2 === 0 ? 2 : 1;
  const minor = step / minorDivisions;
  const ticks: { at: number; major: boolean }[] = [];
  for (let at = 0; at <= duration + 1e-6 && ticks.length < 200; at += minor) {
    ticks.push({ at, major: Math.abs(at / step - Math.round(at / step)) < 1e-6 });
  }
  return ticks;
}

function Icon({ name }: { name: "play" | "pause" | "sound" | "muted" | "expand" }) {
  const paths: Record<typeof name, React.ReactNode> = {
    play: <path d="M7 5.5v13l11-6.5z" fill="currentColor" stroke="none" />,
    pause: <><path d="M8 5.5v13" /><path d="M16 5.5v13" /></>,
    sound: <><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" /><path d="M15.5 9a4 4 0 0 1 0 6" /><path d="M18 6.5a7.5 7.5 0 0 1 0 11" /></>,
    muted: <><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" /><path d="M16 9.5l5 5" /><path d="M21 9.5l-5 5" /></>,
    expand: <><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></>,
  };
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function Player({ ref, src, label, fallbackDuration, segments, activeIndex, hoverIndex, onHover, onSelect, mediaError, onMediaError, onDuration }: {
  ref?: Ref<PlayerHandle>;
  src: string;
  label: string;
  fallbackDuration: number | null;
  segments: SearchSegment[];
  activeIndex: number | null;
  hoverIndex: number | null;
  onHover: (index: number | null) => void;
  onSelect: (index: number) => void;
  mediaError: string | null;
  onMediaError: (message: string) => void;
  onDuration?: (seconds: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const dragging = useRef(false);
  const [duration, setDuration] = useState<number | null>(fallbackDuration);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [ready, setReady] = useState(false);

  const ticks = useMemo(() => (duration ? rulerTicks(duration) : []), [duration]);

  // Paints the playhead and clock straight to the DOM (no React render per frame).
  function paint() {
    const video = videoRef.current;
    if (!video || !duration) return;
    const ratio = Math.min(1, Math.max(0, video.currentTime / duration));
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${ratio * 100}cqw)`;
    if (progressRef.current) progressRef.current.style.transform = `scaleX(${ratio})`;
    if (timeRef.current) timeRef.current.textContent = formatTimestamp(video.currentTime);
    trackRef.current?.setAttribute("aria-valuenow", String(Math.round(video.currentTime)));
    trackRef.current?.setAttribute("aria-valuetext", formatTimestamp(video.currentTime));
  }

  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function loop() {
      paint();
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
    // paint only depends on duration; re-running per render would restart the loop needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration]);

  function seek(seconds: number, play: boolean) {
    const video = videoRef.current;
    if (!video) return;
    const target = clampSeek(seconds, Number.isFinite(video.duration) ? video.duration : duration);
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      video.currentTime = target;
      paint();
      if (play) video.play().catch(() => {});
    } else {
      // Applied in onLoadedMetadata once the browser knows the duration.
      pendingSeek.current = target;
    }
  }

  useImperativeHandle(ref, () => ({ seekTo: (seconds) => seek(seconds, true) }));

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function timeAt(clientX: number) {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * (duration ?? 0);
  }

  function onTrackKey(event: React.KeyboardEvent) {
    const video = videoRef.current;
    if (!video || !duration) return;
    const step = event.shiftKey ? 1 : 5;
    const moves: Record<string, number> = { ArrowLeft: -step, ArrowRight: step, ArrowDown: -step, ArrowUp: step };
    if (event.key in moves) seek(video.currentTime + moves[event.key], false);
    else if (event.key === "Home") seek(0, false);
    else if (event.key === "End") seek(duration, false);
    else if (event.key === " " || event.key === "k") togglePlay();
    else return;
    event.preventDefault();
  }

  return (
    <div className="player">
      <div className="player-well">
        <video
          ref={videoRef}
          src={src}
          preload="metadata"
          playsInline
          aria-label={label}
          onClick={togglePlay}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (Number.isFinite(video.duration)) {
              setDuration(video.duration);
              onDuration?.(video.duration);
            }
            setReady(true);
            if (pendingSeek.current !== null) {
              video.currentTime = clampSeek(pendingSeek.current, video.duration);
              pendingSeek.current = null;
              video.play().catch(() => {});
            }
          }}
          onTimeUpdate={paint}
          onSeeked={paint}
          onPlay={() => setPlaying(true)}
          onPause={() => { setPlaying(false); paint(); }}
          onEnded={() => setPlaying(false)}
          onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
          onError={(event) => {
            const code = event.currentTarget.error?.code;
            onMediaError(code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE
              ? "This browser can’t decode the video’s codec — common with HEVC outside Safari, ProRes, or MKV. Search still works and timestamps stay correct. Try Safari, or upload an H.264 MP4 copy."
              : "The local file couldn’t be loaded. It may have been moved out of the data folder.");
          }}
        />
        {mediaError && <div className="player-message" role="alert"><p>{mediaError}</p></div>}
      </div>

      <div className="transport">
        <button className="icon-button" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} disabled={!ready}>
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <span className="clock"><span ref={timeRef}>00:00</span><span className="clock-total"> / {duration ? formatTimestamp(duration) : "--:--"}</span></span>
        <span className="transport-spacer" />
        <button className="icon-button" onClick={() => { if (videoRef.current) videoRef.current.muted = !videoRef.current.muted; }} aria-label={muted ? "Unmute" : "Mute"}>
          <Icon name={muted ? "muted" : "sound"} />
        </button>
        <button className="icon-button" onClick={() => videoRef.current?.requestFullscreen?.().catch(() => {})} aria-label="Full screen">
          <Icon name="expand" />
        </button>
      </div>

      <div
        ref={trackRef}
        className="ruler"
        role="slider"
        tabIndex={0}
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration ?? 0)}
        aria-valuenow={0}
        onKeyDown={onTrackKey}
        onPointerDown={(event) => {
          if (!duration || (event.target as HTMLElement).closest(".ruler-span")) return;
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          seek(timeAt(event.clientX), false);
        }}
        onPointerMove={(event) => { if (dragging.current) seek(timeAt(event.clientX), false); }}
        onPointerUp={() => { dragging.current = false; }}
        onPointerCancel={() => { dragging.current = false; }}
      >
        <div className="ruler-ticks" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick.at} className={tick.major ? "tick major" : "tick"} style={{ left: `${(tick.at / duration!) * 100}%` }}>
              {tick.major && tick.at > 0 && tick.at < duration! - 0.5 && <span className="tick-label">{formatTimestamp(tick.at)}</span>}
            </span>
          ))}
        </div>
        <div className="ruler-base" aria-hidden="true"><div ref={progressRef} className="ruler-progress" /></div>
        {duration ? segments.map((segment, index) => {
          const left = (segment.startSeconds / duration) * 100;
          const width = Math.max(0.6, ((segment.endSeconds - segment.startSeconds) / duration) * 100);
          const state = index === activeIndex ? "is-active" : index === hoverIndex ? "is-hover" : "";
          return (
            <button
              key={`${segment.startSeconds}-${index}`}
              className={`ruler-span ${state}`}
              style={{ left: `${left}%`, width: `${width}%`, ["--i" as string]: index }}
              onClick={() => onSelect(index)}
              onMouseEnter={() => onHover(index)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(index)}
              onBlur={() => onHover(null)}
              aria-label={`Moment ${index + 1}: ${formatTimestamp(segment.startSeconds)} to ${formatTimestamp(segment.endSeconds)}`}
            >
              <span className="ruler-span-label">{String(index + 1).padStart(2, "0")}</span>
            </button>
          );
        }) : null}
        <div ref={playheadRef} className="playhead" aria-hidden="true" />
      </div>
    </div>
  );
}
