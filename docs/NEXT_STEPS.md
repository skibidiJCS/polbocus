# Implementation handoff

## Done

The end-to-end path is implemented: streamed upload with validation and dedup, TwelveLabs v1.3 asset → indexed-asset indexing in a leased background worker, status and recovery persisted in SQLite, search filtered to the selected video, Range-capable playback with result seeking, retry, and deletion (local and/or TwelveLabs). See README for the architecture and verification status.

## Open items

1. Live-verified on 2026-11-02 with a synthetic clip (see README). Still to exercise live: a >200 MB file (multipart upload), real footage, a 429, and an indexing failure.
2. Evaluate result quality on known moments before refining the UI.
3. Optional: explicit, user-triggered FFmpeg conversion to an H.264 preview for files the browser cannot decode (keep the original; timestamps align because the timeline is unchanged).
4. Optional: pagination of search results (`GET /v1.3/search/{page-token}`, which TwelveLabs says is not charged).

## Constraints (unchanged)

- Node runtime and persistent local disk; no edge runtime or static-only hosting.
- API keys are server-only. A configured key is not proof of a working connection.
- Uploading for indexing sends footage to TwelveLabs; the UI asks for confirmation first.
- No automatic reindexing, no automatic search retries, no fake progress percentages.
- Keep the server bound to localhost. Authentication is required before exposing private footage on a network.
