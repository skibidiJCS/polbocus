"use client";

import type { Ref } from "react";
import { formatRange, formatTimestamp } from "@/lib/time";
import type { SearchSegment } from "@/types/video";
import type { SearchMode } from "./client-api";

export const searchModes: { value: SearchMode; label: string; hint: string }[] = [
  { value: "all", label: "everything", hint: "What is seen, heard, and said" },
  { value: "visual", label: "what’s seen", hint: "Only what appears on screen" },
  { value: "speech", label: "what’s said", hint: "Only spoken words" },
];
const examples = ["someone drops their phone", "a person walks through a doorway", "outdoors, at night", "someone mentions the deadline"];

export interface Results {
  id: number;
  query: string;
  mode: SearchMode;
  segments: SearchSegment[];
  notes: string[];
}

export function SearchForm({ inputRef, canSearch, searching, query, onQuery, mode, onMode, onSubmit, status, error }: {
  inputRef: Ref<HTMLInputElement>;
  canSearch: boolean;
  searching: boolean;
  query: string;
  onQuery: (value: string) => void;
  mode: SearchMode;
  onMode: (mode: SearchMode) => void;
  onSubmit: (event: React.FormEvent) => void;
  status: string;
  error: string | null;
}) {
  return (
    <form className={`query ${canSearch ? "" : "is-disabled"} ${searching ? "is-searching" : ""}`} onSubmit={onSubmit} role="search">
      <div className="query-line">
        <label htmlFor="moment-query" className="query-lead">Find the moment</label>
        <input
          ref={inputRef}
          id="moment-query"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
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
            <button key={option.value} type="button" role="radio" aria-checked={mode === option.value} title={option.hint} className={mode === option.value ? "is-on" : ""} onClick={() => onMode(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
        <p className="query-status">{status}</p>
      </div>
      {canSearch && (
        <div className="examples">
          <span className="faint">Examples</span>
          {examples.map((text) => (
            <button type="button" key={text} onClick={() => onQuery(text)}>{text}</button>
          ))}
        </div>
      )}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </form>
  );
}

export function MomentsPanel({ results, searching, ready, activeIndex, hoverIndex, onHover, onPlay }: {
  results: Results | null;
  searching: boolean;
  ready: boolean;
  activeIndex: number | null;
  hoverIndex: number | null;
  onHover: (index: number | null) => void;
  onPlay: (index: number) => void;
}) {
  return (
    <section className={`moments ${searching ? "is-loading" : ""}`} aria-label="Matching moments" aria-busy={searching}>
      <header className="moments-head">
        <h2>Moments</h2>
        {results && <span className="mono faint">{results.segments.length}</span>}
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
            <p className="serif">Nothing matched “{results.query}”.</p>
            <p>Try describing what’s visible or said in other words{results.mode !== "all" ? ", or search everything" : ""}.</p>
          </div>
        )
      ) : (
        <div className="moments-empty">
          <p className="serif">{ready ? "Moments you find will gather here." : "Nothing to search yet."}</p>
          {ready && <p>Click one to play it from that point.</p>}
        </div>
      )}
      {results?.notes.map((note) => <p key={note} className="moments-note">{note}</p>)}
      {results && results.segments.length > 0 && (
        <p className="moments-foot">Ordered by TwelveLabs relevance rank, most relevant first. Ranks are not confidence scores.</p>
      )}
    </section>
  );
}
