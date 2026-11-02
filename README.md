# Footage Search

Local, single-user web app: upload a video, let TwelveLabs index it, describe a visual or spoken moment, and click a result to play the video at that timestamp.

## Run on macOS

Requires Node.js 24 (`.nvmrc`). With nvm: `nvm install && nvm use`.

```sh
cd "/Users/jiacai/Documents/Codex/2026-11-01/what/outputs/footage-search"
npm install
cp -n .env.example .env.local   # -n: never overwrites an existing .env.local
npm run db:init
npm run dev
```

Open http://127.0.0.1:3000. Stop with Control-C. Later launches only need `npm run dev`.
For a production build: `npm run build && npm start` (also bound to 127.0.0.1).

### TwelveLabs API key

1. Sign in at https://playground.twelvelabs.io/ and open **API Keys**; copy a key.
2. Put it in `.env.local` as `TWELVELABS_API_KEY=...` (no quotes, no `NEXT_PUBLIC_` prefix).
3. Restart `npm run dev`.

The key is read only by server code. It is never sent to the browser, never logged, and `.env*` (except `.env.example`) is ignored by Git.

**Index:** leave `TWELVELABS_INDEX_ID` empty and, on the first upload, the app reuses a compatible index already in your account (a Marengo model with `visual` + `audio`, preferring one with the `thumbnail` add-on). Only if none exists does it create one (`marengo3.0`, `visual` + `audio`, `thumbnail`). The chosen ID is stored in SQLite (`app_settings`, key `twelvelabs.index_id`) and reused; the app never creates one per start. To reuse an existing index instead, set `TWELVELABS_INDEX_ID`; it must contain a Marengo model with the `visual` option (add `audio` for sound/spoken-word search). Index model options cannot be changed after creation.

To check the key and index without spending search quota: http://127.0.0.1:3000/api/setup?check=1 (one GET to TwelveLabs).

## How it works

```
Browser ──XHR (real progress)──▶ POST /api/videos ─▶ stream to data/tmp, SHA-256, size + signature check
                                                    └▶ data/videos/<uuid>.<ext> + SQLite row + job (status: queued)
Background worker (in the Next.js server process, started from src/instrumentation.ts):
  queued ─▶ uploading: POST /v1.3/assets (≤200 MB) or multipart upload (>200 MB); poll GET /assets/{id}
         ─▶ indexing:  POST /v1.3/indexes/{index}/indexed-assets; poll GET …/indexed-assets/{id}
         ─▶ ready | failed
Search: POST /api/search ─▶ POST /v1.3/search with filter {"id":[<this video's ID>]}
Player: GET /api/videos/:id/media (HTTP Range, 206) ─▶ click a result → seek to its start
```

- **TwelveLabs workflow** (verified on docs.twelvelabs.io, API v1.3, 2026-11-02): assets + indexed assets. The older `POST /tasks` upload is marked by TwelveLabs as "will be removed in a future version" and is not used. Raw REST via `fetch` (no SDK); endpoint list is at the top of `src/lib/server/twelvelabs.ts`.
- **Search modes:** *Everything* sends `visual`, plus `transcription` (spoken words) and `audio` (non-speech sound) when the index has the `audio` model option, combined with `operator=or`. *Visuals* sends only `visual`; *Spoken words* sends only `transcription`. Live testing showed that in *Everything* mode visual matches outrank speech (see below), so for something someone said, *Spoken words* gives far better results. If an index rejects `transcription`, *Everything* falls back once to the other options and remembers that.
- **Results:** start/end seconds at the provider's precision, TwelveLabs `rank` (1 = most relevant; shown as "Rank N", never as a percentage), the thumbnail URL when the index has thumbnails (TwelveLabs says these URLs expire after an hour; a timestamp tile is the fallback), and the transcription text when TwelveLabs returns one. Exact duplicates and segments ≥80% covered by a better-ranked one are merged. Results for any other video are discarded even if returned.
- **Status:** TwelveLabs exposes states, not percentages, so the UI shows the state (`pending`, `validating`, `indexing`, …) with elapsed time. Only the browser→server upload shows a percentage, from real XHR progress.
- **Reliability:** jobs live in SQLite with leases (2 min, renewed every 30 s), so a job runs in one place at a time and an interrupted one is picked up again after a restart. Temporary failures (network, 429, 5xx) back off exponentially, honour `Retry-After`, and stop after 6 consecutive failures. Polling stops after 2 h (asset processing) / 12 h (indexing). Searches are never retried automatically. Closing the browser tab does not stop indexing; only the browser→server upload needs the tab.
- **Deduplication:** identical files (same SHA-256) are not stored or uploaded twice. Retry reuses a ready TwelveLabs asset, removes a failed indexed asset, and checks for an existing indexed asset before creating one.
- **Deletion:** the dialog offers "Delete here and at TwelveLabs" (`DELETE /v1.3/assets/{id}?force=true`, which TwelveLabs documents as also removing its indexed assets) or "Delete local copy only". If the TwelveLabs call fails, nothing local is removed and the error is shown. A missing provider copy is reported as such, not as deleted.

### Limits (from the implementation and TwelveLabs docs)

- Formats: MP4, MOV, M4V, WebM, MKV, recognised from the file's bytes (not its name or browser MIME type).
- Size: up to 4 GB (TwelveLabs Marengo limit; `MAX_UPLOAD_MB` can lower it). Files over 200 MB use TwelveLabs multipart upload.
- Duration: 4 s to 4 h; resolution 360x360 to 5184x2160 (Marengo 3.0). The browser warns about duration when it can read it; TwelveLabs enforces the rest and the error is shown.
- Search quota and rate limits depend on your TwelveLabs plan (documented Free plan: 600 searches/min, 3,000/day). Each search click is one request.

### Browser playback

The original file is played as uploaded; nothing is transcoded and FFmpeg is not needed. If the browser cannot decode the codec (for example HEVC in some browsers, ProRes, or many MKVs), the player explains this. Search still works and timestamps stay valid. Use Safari, or convert to H.264 MP4 yourself and upload that copy.

## Where data lives

- `data/footage.sqlite`: video metadata, provider IDs, job state, stored index ID.
- `data/videos/<uuid>.<ext>`: original files under generated names (the original filename is only metadata).
- `data/tmp/`: in-progress uploads; leftovers older than 6 h are removed on start.

`DATA_DIR` changes the location (absolute or relative to the project; it must be outside `public/`). `data/` is ignored by Git. Migrations in `database/` are applied by `npm run db:init` and automatically on server start.

## Checks

```sh
npm run typecheck   # next typegen + tsc
npm run lint
npm test            # vitest, 52 tests (mocked TwelveLabs)
npm run build
```

## Verification status

- **Mocked automated tests (no network, fake TwelveLabs):** timestamp formatting, precision and clamping; duplicate/overlap handling; search sends `index_id` + `filter {"id":[…]}` for the selected video only, and other videos' results are dropped; search modes map to the right options; a compatible existing index is adopted, otherwise one is created once and reused across restarts, and a configured index is validated; 429 → retryable with `Retry-After`; key scrubbed from errors; direct and multipart uploads (chunk sizes and ETag reporting); job recovery after a crash with an expired lease, no duplicate execution, bounded backoff, permanent-failure handling, cleanup when deleted mid-upload; deletion outcomes, including partial failure; retry reuse; streamed upload validation, size limit and dedup; HTTP Range serving (200/206/416/HEAD) through the real route handler; localhost-only checks.
- **Manual checks against the running dev server (no API key):** page renders on desktop and mobile widths; `/api/setup`, `/api/videos`; upload refused with a clear message without a key; cross-origin POST and non-localhost Host rejected.
- **Live TwelveLabs integration:** verified with a real key on 2026-11-02, see below.

## Live verification

Run on 2026-11-02 against the real TwelveLabs API (v1.3), with a key in `.env.local`. The video was a synthetic 24 s, 1280x720 H.264 MP4 made locally (day scene with a walking figure 0–8 s, night scene 8–16 s, indoor red ball 16–24 s, plus the sentence "The project deadline is this Friday at noon" spoken by macOS `say` at 17 s).

Verified:
- Key accepted (`GET /indexes` → 200).
- Upload → asset → indexed asset → `ready`: the app showed `pending` → `queued` → `ready`, about 20 s for this small clip. TwelveLabs reported the duration as 24 s.
- After a dev-server restart, the state was intact and the stored index was reused (`/api/setup?check=1` → connected; search options `visual, transcription, audio`).
- `filter {"id":[<indexed-asset _id>]}` works: the search `video_id` **equals** the indexed-asset `_id`, and no results were hidden. The raw result fields were `rank, start, end, video_id, thumbnail_url, transcription`, with no score or confidence.
- `transcription` is accepted on a `marengo3.0` visual+audio index.
- Visual queries ranked the correct scene first ("a red ball bouncing on the floor" → 15.93–24.0 s; "an outdoor scene at night" → 7.93–15.93 s; "a person walking across a field" → 0–7.93 s). Segment boundaries matched the scene cuts.
- Spoken query in *Spoken words* mode ("when someone mentions the deadline") returned exactly one result, 15.93–24.0 s, rank 1, with the transcript and a thumbnail.
- In the browser: the library persisted across reloads; clicking the result seeked to 15.93 s and played (17.8 s two seconds later); the card was highlighted and the segment bar appeared; *Replay segment* returned from 22.5 s to the start.
- Browser upload of a renamed copy of the same bytes: the confirm card appeared, the file was recognised as a duplicate, and nothing was stored or sent again.
- Delete "here and at TwelveLabs": afterwards, `GET /assets/{id}` and `GET …/indexed-assets/{id}` both returned 404, and the local file and rows were removed.

Findings:
- In *Everything* mode (`visual`+`transcription`+`audio`, `operator=or`), the spoken query ranked the speech segment **third**, behind two visual segments. With only `transcription` it was the only result. Hence the search-mode control.
- TwelveLabs gives no relevance score with Marengo 3.0, only `rank`. In visual mode every segment of a short video is returned, ranked, even when weakly related; the empty state appears only when TwelveLabs returns nothing.
- Thumbnails are taken at the segment start, which can be the last frame of the previous scene.
- The live not-found error code is `resource_not_exists` (the docs say `resource_not_exist`); both are handled.

Not yet verified live: files over 200 MB (multipart upload path; covered by mocked tests only), your own real footage, rate-limit (429) handling, indexing failures, and long videos.

## Before exposing beyond localhost

There is no authentication. Add access control, CSRF protection beyond the Origin check, upload rate limits and quotas, HTTPS, a separate job runner (the worker lives in the web process), and storage outside the app server. Do not bind to `0.0.0.0` as-is.

## Structure

```text
src/
  instrumentation.ts               Starts the background worker on server boot
  app/api/
    videos/route.ts                GET library, POST streamed upload
    videos/[id]/route.ts           GET one, DELETE (local and/or TwelveLabs)
    videos/[id]/retry/route.ts     POST retry a failed video
    videos/[id]/media/route.ts     GET/HEAD original file with Range support
    search/route.ts                POST search within one video
    setup/route.ts                 Readiness (no secrets); ?check=1 validates key/index
  components/workspace/            Library, upload confirm/progress, player, search, results, delete dialog
  lib/segments.ts, lib/time.ts     Result normalisation, timestamp formatting/validation
  lib/server/
    twelvelabs.ts                  TwelveLabs v1.3 REST adapter
    video-provider.ts              Provider contract + errors
    worker.ts                      Leased, resumable indexing jobs
    video-service.ts               Search, retry, delete
    upload.ts, media.ts            Streaming upload, signature sniffing, Range parsing
    db.ts, videos-repo.ts          SQLite (node:sqlite) + migrations, queries
database/                          Numbered SQL migrations
tests/                             Vitest suites (mocked provider)
```
