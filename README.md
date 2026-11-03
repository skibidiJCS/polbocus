# polbocus

Upload a video, let TwelveLabs index it, describe a visual or spoken moment, and click a result to play the video at that timestamp.

## Two modes

The same code runs in one of two modes. Hosted mode is chosen automatically on Vercel (`VERCEL` is set) or with `APP_MODE=session`; otherwise it is local library mode.

| | Local library mode | Hosted session mode |
|---|---|---|
| Where | `npm run dev` on your Mac, bound to 127.0.0.1 | Vercel |
| Who can use it | Only requests addressed to `localhost`, `127.0.0.1` or `[::1]` (enforced in `src/proxy.ts` before any page or API) | Only the owner, after signing in with `APP_PASSWORD` |
| Videos | A library you keep: files in `data/videos`, metadata in SQLite | One video at a time, temporary |
| Upload path | Browser → this server (streamed) → TwelveLabs | Browser → private Vercel Blob store → TwelveLabs fetches it |
| Upload limit | 4 GB (`MAX_UPLOAD_MB` can lower it) | 4 GB; large high-resolution files are shrunk to 720p in the browser first |
| State | `data/footage.sqlite` | Small JSON files under `state/` in the same private Blob store: sign-in attempt counters and which temporary files each session created (no footage) |
| Retention | Until you delete a video (locally and/or at TwelveLabs) | Deleted when you leave the page (best effort); otherwise deleted after 30 minutes without a heartbeat by the next cleanup run (daily scheduled job, or a later visit) |
| Background work | An in-process worker polls TwelveLabs | No worker: the open page drives progress; a daily Vercel Cron job cleans up |
| Routes | `/api/videos`, `/api/search`, `/api/setup` | `/api/session/*`, `/api/auth/*`, `/api/cron/cleanup`; the other mode's routes answer 404 |

## Run locally (library mode, macOS)

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

## Interface

A warm dark palette (bone on soot, moss for matches, ochre for work in progress, clay for problems), Hanken Grotesk for UI, IBM Plex Mono for timecodes.

- **Timeline ruler** under the player: every listed match is drawn where it occurs. Hovering a result highlights its span and vice versa; drag or click the ruler to scrub, or focus it and use ←/→ (5 s, Shift for 1 s), Home/End, Space.
- **Search** with *Everything / What's seen / What's said* modes. The best five results are listed; "Show more" reveals the rest of the same response without another request.
- Drop a file anywhere in the window.
- Motion is limited to short fades and growth on the ruler, and is turned off under `prefers-reduced-motion`.

## Hosted session mode (Vercel)

On Vercel, polbocus is a signed-in tool for one video at a time. You sign in with your password, drop a video, search it, and leave.

```
Browser ──asks for an upload token──▶ server records the session (Blob `state/`), then signs the upload
Browser ──uploads (parallel parts over 10 MB)──▶ private Vercel Blob store
Server  ──temporary 2-hour signed link──▶ TwelveLabs fetches the file → asset (named footage-session--<session>--<file>) → indexed asset
Server  ──records the asset ID itself, deletes the Blob copy once TwelveLabs has it
Browser ──plays the file from your own computer; search & click-to-seek; heartbeat every 5 minutes
Leave   ──navigator.sendBeacon / "New video" → server deletes the TwelveLabs asset and any upload
```

Why Blob: TwelveLabs' upload links reject browser uploads (checked: CORS preflight returns 403), and Vercel functions cap request bodies at 4.5 MB, so the browser uploads to a private Blob store instead.

### What is kept, and for how long

- **Your file** stays on your computer; the page plays it from there.
- **The Blob copy** exists from upload until TwelveLabs has fetched it (usually seconds), or until the session is cleaned up.
- **The TwelveLabs copy** (asset and indexed asset) exists until the session ends. Leaving the page or pressing "New video" asks the server to delete it immediately. That request is best effort: a browser can be closed or lose its connection before it is sent.
- **If that request never arrives**, the session stops sending heartbeats. After 30 minutes without one it counts as abandoned and is deleted by the next cleanup run: the daily scheduled job (on the Hobby plan Vercel runs it once a day, at a time within the scheduled hour), or any later visit to the app. A page that is still open is never treated as abandoned, however long it has been open.
- **If a deletion fails** (for example TwelveLabs is briefly unavailable), the session stays queued and is retried with backoff (1 minute, doubling, up to 6 hours apart) for up to 8 attempts. Each failure is logged (`[session-cleanup]` in Vercel's function logs), and the scheduled job's response reports counts. After the last attempt the session is logged as failed, and the scheduled sweep keeps trying to delete its tagged resources.
- **Safety net:** the scheduled job also pages through every TwelveLabs asset whose name starts with `footage-session--` and every upload under `sessions/`, and deletes those whose session has ended or been abandoned. Assets without this prefix are never touched. Progress is saved between runs, so large listings are covered over successive runs. Tagged assets from before session tracking existed (no session ID in the name) are deleted once they are a day old.
- **Session state** (`state/` in the private Blob store) holds only metadata: per-session records (state, timestamps, resource IDs), attempt counters and sweep progress. Records are deleted with their session; old attempt counters are removed by the scheduled job.

### Sign-in

A single owner password (`APP_PASSWORD`, 12+ characters). The session cookie is signed with a key derived from the password and API key (changing the password signs every browser out); it is `HttpOnly`, `Secure`, `SameSite=Lax` and lasts 12 hours. Every page and API route checks it in `src/proxy.ts`, and the hosted API routes check it again themselves.

Sign-in attempts are counted in the private Blob store (`state/login/`), so every serverless instance shares the same counters. Each update is a compare-and-swap on the file's ETag (reads bypass the CDN cache), and each attempt is counted before the password is checked, so parallel requests cannot get around the limits:

- 5 attempts per 15 minutes per client address, and 30 per 15 minutes in total across all addresses; then `429` with `Retry-After`.
- A browser that has signed in before carries a signed device cookie (90 days) and has its own budget of 10 per 15 minutes instead, so someone exhausting the shared budgets cannot lock you out of your usual browser. All limits reset on their own; nothing locks permanently.
- Request bodies over 2 KB and passwords over 256 characters are refused before they are buffered or hashed.
- If the counters cannot be read or written, sign-in is refused (503) rather than allowed without limits.

### Set-up (once, in the Vercel dashboard)

1. **Storage → Create → Blob** → access **Private** → connect it to this project (Production + Preview). Vercel adds `BLOB_STORE_ID` + `BLOB_WEBHOOK_PUBLIC_KEY` (or `BLOB_READ_WRITE_TOKEN` for token-based stores).
2. **Settings → Environment Variables** → add:
   - `TWELVELABS_API_KEY`: your key
   - `APP_PASSWORD`: the password you'll sign in with (12+ characters; a passphrase is best)
   - `CRON_SECRET`: 16+ random characters (`openssl rand -hex 32`). Vercel Cron sends it as `Authorization: Bearer …`; without it the cleanup endpoint refuses every request and only visits clean up.
   - optional `TWELVELABS_INDEX_ID`
3. **Deployments → ⋯ → Redeploy.** The cron schedule comes from `vercel.json` (`0 4 * * *`, daily at 04:00 UTC; Hobby allows one run a day and may run it any time within that hour). Check it under **Settings → Cron Jobs**, where you can also run it once by hand.

No other service is needed. Until Blob is connected, the page shows what is missing instead of the app.

Limits on Vercel's Hobby plan: Blob includes 10 GB of data transfer and 1 GB of storage per month, plus a monthly allowance of store operations; each upload counts once as transfer when TwelveLabs fetches it. Session bookkeeping uses a few dozen small reads and writes per video (heartbeats are written at most every 2 minutes), and each sign-in attempt a few more.

## How it works (local library mode)

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
- **Reliability:** jobs live in SQLite with leases (2 min, renewed every 30 s), so a job runs in one place at a time and an interrupted one is picked up again after a restart. Temporary failures (network, 429, 5xx) back off exponentially, honour `Retry-After`, and stop after 6 consecutive failures. Polling stops after 2 h (asset processing) / 12 h (indexing); Retry keeps a still-running TwelveLabs job and gives it a fresh 12-hour window (the first start time is kept in `indexing_first_started_at`). Searches are never retried automatically. Closing the browser tab does not stop indexing; only the browser→server upload needs the tab.
- **Deduplication:** identical files (same SHA-256) are not stored or uploaded twice. Retry reuses a ready TwelveLabs asset, removes a failed indexed asset, and checks for an existing indexed asset before creating one.
- **Deletion:** the dialog offers "Delete here and at TwelveLabs" (`DELETE /v1.3/assets/{id}?force=true`, which TwelveLabs documents as also removing its indexed assets) or "Delete local copy only". If the TwelveLabs call fails, nothing local is removed and the error is shown. A missing provider copy is reported as such, not as deleted.

### Limits (from the implementation and TwelveLabs docs)

- Formats: MP4, MOV, M4V, WebM, MKV, recognised from the file's bytes (not its name or browser MIME type).
- Size: up to 4 GB (TwelveLabs Marengo limit; `MAX_UPLOAD_MB` can lower it). Files over 200 MB use TwelveLabs multipart upload.
- Duration: 4 s to 4 h; resolution 360x360 to 5184x2160 (Marengo 3.0). The browser warns about duration when it can read it; TwelveLabs enforces the rest and the error is shown.
- Search quota and rate limits depend on your TwelveLabs plan (documented Free plan: 600 searches/min, 3,000/day). Each search click is one request.

### Browser playback

The original file is played as uploaded; nothing is transcoded and FFmpeg is not needed. If the browser cannot decode the codec (for example HEVC in some browsers, ProRes, or many MKVs), the player explains this. Search still works and timestamps stay valid. Use Safari, or convert to H.264 MP4 yourself and upload that copy.

## Where data lives (local library mode)

- `data/footage.sqlite`: video metadata, provider IDs, job state, stored index ID.
- `data/videos/<uuid>.<ext>`: original files under generated names (the original filename is only metadata).
- `data/tmp/`: in-progress uploads; leftovers older than 6 h are removed on start.

`DATA_DIR` changes the location (absolute or relative to the project; it must be outside `public/`). `data/` is ignored by Git. Migrations in `database/` are applied by `npm run db:init` and automatically on server start.

## Checks

```sh
npm run typecheck   # next typegen + tsc
npm run lint
npm test            # vitest (mocked TwelveLabs and Blob; no network)
npm run build
```

## Verification status

- **Mocked automated tests (no network, fake TwelveLabs):** timestamp formatting, precision and clamping; duplicate/overlap handling; search sends `index_id` + `filter {"id":[…]}` for the selected video only, and other videos' results are dropped; search modes map to the right options; a compatible existing index is adopted, otherwise one is created once and reused across restarts, and a configured index is validated; 429 → retryable with `Retry-After`; key scrubbed from errors; direct and multipart uploads (chunk sizes and ETag reporting); job recovery after a crash with an expired lease, no duplicate execution, bounded backoff, permanent-failure handling, cleanup when deleted mid-upload; deletion outcomes, including partial failure; retry reuse; streamed upload validation, size limit and dedup; HTTP Range serving (200/206/416/HEAD) through the real route handler; localhost-only checks.
- **Mocked automated tests for hosted mode (fake TwelveLabs, Blob and an in-memory store):** session tracking before upload; deletion after 30 minutes without a heartbeat with no beacon and no further upload; heartbeating sessions kept past 6+ hours; failed deletions retried with backoff until they succeed, and given up (logged) after 8 attempts; repeated cleanup is harmless; `end` racing with asset creation, and an asset whose ID was lost, are both deleted; the sweep finds stale assets and uploads beyond the first page, keeps fresh and unrelated ones, resumes from saved progress under a small budget, and retries failed listings and deletions; concurrent and cross-instance sign-in attempts share one budget, cooldowns expire, known devices keep their own budget, oversized requests are refused unhashed; the proxy and the routes refuse foreign `Host` (page, RSC and API; with matching or missing `Origin`) without touching the database, Blob or TwelveLabs; hosted-only routes answer 404 locally; the cron endpoint requires `CRON_SECRET`; compare-and-swap counters under concurrent writers.
- **Not verified against real services:** the Blob-backed state store against a real Blob store (conditional writes, uncached reads), Vercel Cron delivery, and the hosted flow end to end after these changes. Those need the set-up above and a deployment.
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

## Security notes

- **Local library mode** has no sign-in. It relies on being reachable only from this machine: the server binds to 127.0.0.1, and `src/proxy.ts` refuses any request whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` before a page renders or an API reads the library. This blocks DNS-rebinding pages, whose requests carry their own hostname. The API routes repeat the check, and state-changing requests must also come from the same origin. Do not bind it to `0.0.0.0` or put it behind a proxy that rewrites `Host`.
- **Hosted session mode** requires the owner's signed cookie for every page and API route except sign-in and the cron endpoint (which requires `CRON_SECRET`). Cross-origin state-changing requests are refused, and request bodies are size-limited.
- Not verified: the strength of the deployed password, and any protection Vercel adds in front of the app.

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
    session/{upload,start,status,search,heartbeat,end}/route.ts   Hosted session flow
    auth/{login,logout}/route.ts   Hosted sign-in
    cron/cleanup/route.ts          Scheduled cleanup (CRON_SECRET)
  proxy.ts                         Host boundary (local) and sign-in gate (hosted), before every request
  components/workspace/            Library, upload confirm/progress, player + timeline ruler, search, results, delete dialog, hosted notice
  lib/segments.ts, lib/time.ts     Result normalisation, timestamp formatting/validation
  lib/server/
    twelvelabs.ts                  TwelveLabs v1.3 REST adapter
    video-provider.ts              Provider contract + errors
    worker.ts                      Leased, resumable indexing jobs
    video-service.ts               Search, retry, delete
    upload.ts, media.ts            Streaming upload, signature sniffing, Range parsing
    db.ts, videos-repo.ts          SQLite (node:sqlite) + migrations, queries
    session.ts                     Hosted sessions: tracking, cleanup, retries, paginated sweep
    shared-store.ts                Shared state as JSON files in private Blob (ETag compare-and-swap) / in-memory store
    login-throttle.ts, login-handler.ts   Shared sign-in attempt limits
database/                          Numbered SQL migrations
tests/                             Vitest suites (mocked provider)
```
