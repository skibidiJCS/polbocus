"use client";

import type { Ref } from "react";
import { formatRange, formatTimestamp } from "@/lib/time";
import type { SearchSegment } from "@/types/video";
import type { SearchMode } from "./client-api";

export const searchModes: { value: SearchMode; label: string; hint: string }[] = [
  { value: "all", label: "Everything", hint: "What is seen, heard, and said" },
  { value: "visual", label: "What’s seen", hint: "Only what appears on screen" },
  { value: "speech", label: "What’s said", hint: "Only spoken words" },
];

export interface Results {
  id: number;
  query: string;
  mode: SearchMode;
  segments: SearchSegment[];
  notes: string[];
}

export function SearchForm({ inputRef, canSearch, waiting = null, searching, query, onQuery, mode, onMode, onSubmit, error }: {
  inputRef: Ref<HTMLInputElement>;
  canSearch: boolean;
  /** A query that will run once the video is ready. */
  waiting?: string | null;
  searching: boolean;
  query: string;
  onQuery: (value: string) => void;
  mode: SearchMode;
  onMode: (mode: SearchMode) => void;
  onSubmit: (event: React.FormEvent) => void;
  error: string | null;
}) {
  return (
    <form className={`search ${canSearch ? "" : "is-disabled"} ${searching ? "is-searching" : ""}`} onSubmit={onSubmit} role="search">
      <div className="search-field">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="M16 16l4 4" />
        </svg>
        <label htmlFor="moment-query" className="sr-only">Describe a moment</label>
        <input
          ref={inputRef}
          id="moment-query"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          maxLength={500}
          disabled={!canSearch}
          placeholder={canSearch ? "Describe a moment, like “someone drops their phone”" : "Available once the video is ready"}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!canSearch || searching || !query.trim()}>
          {searching ? "Searching…" : waiting ? "Queued" : "Search"}
        </button>
        <span className="search-progress" aria-hidden="true" />
      </div>
      <div className="segmented" role="radiogroup" aria-label="Search in">
        {searchModes.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={mode === option.value} title={option.hint} className={mode === option.value ? "is-on" : ""} onClick={() => onMode(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
      {waiting && <p className="search-note" aria-live="polite">Searches “{waiting}” as soon as the video is ready.</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </form>
  );
}

export function MomentsPanel({ results, searching, activeIndex, hoverIndex, onHover, onPlay }: {
  results: Results | null;
  searching: boolean;
  activeIndex: number | null;
  hoverIndex: number | null;
  onHover: (index: number | null) => void;
  onPlay: (index: number) => void;
}) {
  return (
    <section className={`moments ${searching ? "is-loading" : ""}`} aria-label="Matching moments" aria-busy={searching}>
      <header className="moments-head">
        <h2>Moments</h2>
        {results && <span className="moments-count">{results.segments.length}</span>}
      </header>
      {results ? (
        results.segments.length ? (
          <ol className="moment-list" key={results.id}>
            {results.segments.map((segment, index) => {
              const state = index === activeIndex ? "is-active" : index === hoverIndex ? "is-hover" : "";
              return (
                <li key={`${segment.startSeconds}-${index}`} style={{ ["--i" as string]: index }}>
                  <button
                    className={`moment ${state}`}
                    onClick={() => onPlay(index)}
                    onMouseEnter={() => onHover(index)}
                    onMouseLeave={() => onHover(null)}
                    aria-pressed={index === activeIndex}
                    title={segment.rank !== undefined ? `TwelveLabs rank ${segment.rank} (1 = most relevant). Not a confidence score.` : undefined}
                  >
                    <span className="moment-thumb">
                      <span className="moment-thumb-fallback">{formatTimestamp(segment.startSeconds)}</span>
                      {segment.thumbnailUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={segment.thumbnailUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} />
                      )}
                    </span>
                    <span className="moment-body">
                      <span className="moment-time">{formatRange(segment.startSeconds, segment.endSeconds)}</span>
                      {segment.transcription && <span className="moment-quote">“{segment.transcription}”</span>}
                    </span>
                    <span className="moment-index">{index + 1}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="moments-empty">Nothing matched. Try other words{results.mode !== "all" ? " or search Everything" : ""}.</p>
        )
      ) : (
        <p className="moments-empty">Results appear here.</p>
      )}
      {results?.notes.map((note) => <p key={note} className="moments-note">{note}</p>)}
    </section>
  );
}
