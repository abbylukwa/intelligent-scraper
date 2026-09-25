# Intelligent Scraper v2.2.0 — CHANGE LOG

Rules followed: existing code was MODIFIED, not rewritten. Endpoints that
worked (/search, /gif, /album, /cleanup) kept their contracts.

## FILES CHANGED

| File | Change |
|------|--------|
| `album.js` | 2 crash fixes (undefined variables) |
| `server.js` | /status crash fix, 3 NEW endpoints, optional token auth, trust proxy |
| `utils.js` | download timeout fix |
| `temp.js` | saveAlbum file-path support fix |
| `media.js` | NEW — backing module for /music /video /download |
| `package.json` | version 2.0.0 → 2.2.0 |
| `.env.example` | SCRAPER_TOKEN + SCRAPER_MAX_MB documented |

## BUG FIXES (things that were broken)

1. **album.js `dic20`** — `imageUrls.slice(0, dic20)` referenced an undefined
   variable; every successful image scrape threw, was swallowed by the
   try/catch, and `/search` ALWAYS returned `[]`. Fixed to `slice(0, 20)`.
2. **album.js `invo500`** — same pattern in searchMusic's rate-limit sleep;
   `/search-music` ALWAYS returned `[]`. Fixed to `500` ms.
3. **server.js /status crash** — `stats.totalSizeMB.toFixed(2)` called .toFixed
   on a string (temp.getStats() already formats it) → TypeError → /status
   always returned 500 → the bot's `!scraperstatus` always reported DOWN.
   Fixed with `Number(stats.totalSizeMB) || 0`.
4. **utils.js timeout 13200000** — image downloads could hang for 3.6 hours.
   Fixed to 30000 ms.
5. **temp.js saveAlbum** — downloadAlbum passes `{path, filename,...}` records
   from utils.downloadImage, but saveAlbum only accepted Buffer/{buffer,ext},
   so EVERY album had 0 images and `/album/:id/next` always 404'd. Now reads
   the file from disk (and deletes the orphaned temp file).

## INTEGRATION FIXES (the bot ↔ scraper wiring)

The WhatsApp bot (whatsapp-qr-app) calls these endpoints — verified against
its `scrapperFetch()`/`scraperSearch()`/`scraperGif()`/`scraperMusic()`/
`scraperVideo()`/`scraperDownloadMedia()` functions:

| Bot call | Before | Now |
|----------|--------|-----|
| `GET /status` | 500 crash | ✅ works |
| `POST /search {query, site}` → `{images}` | ✅ existed (but returned [] due to bug 1) | ✅ works |
| `GET /gif?q=` → `{gifs}` | ✅ existed | ✅ works |
| `POST /music {query}` → `{mediaUrl, title, mimetype, sizeBytes}` | ❌ 404 — did not exist | ✅ NEW (YouTube search → audio download → temp URL) |
| `POST /video {query}` → `{mediaUrl, title, mimetype}` | ❌ 404 | ✅ NEW (YouTube → mp4 ≤ size cap) |
| `POST /download {url, kind}` → `{mediaUrl, title, mimetype, kind, sizeBytes}` | ❌ 404 | ✅ NEW (YouTube link or direct URL → temp URL) |

New `media.js` uses `@distube/ytdl-core` (already in package.json) and reuses
`temp.saveFile()` so the 1-hour auto-cleanup covers downloaded media.
`SCRAPER_MAX_MB` (default 34) hard-caps every download to match the bot's
34MB `MEDIA_MAX_BYTES`.

Also added:
- **Optional token auth** — if `SCRAPER_TOKEN` is set here, data endpoints
  require `Authorization: Bearer <token>` (the bot already sends it when
  SCRAPER_TOKEN is set in its env). If unset, everything stays open as before.
- **trust proxy** — absolute media URLs are https behind Render's proxy.

## VERIFIED LIVE (dry run)

- `GET /status` → 200 `{status:"ok", ...}` ✅
- `GET /gif?q=test` → real Tenor GIF URLs ✅
- `POST /search {query:"harare"}` → success, images returned ✅
- `POST /music` without query → clean 400 validation ✅
- `POST /music {query}` from THIS sandbox → YouTube answered 429 (rate limit
  on datacenter IPs). The error path is clean (bot replies "Err"). From Render
  this depends on YouTube's treatment of Render IPs — test after deploy.
- `node --check` passes on all 6 JS files ✅

---

# v2.2.1 — ytdl-core REMOVED (online-resolver download chain)

User report: "@distube/ytdl-core doesn't work — find other ways… just putting
the url, or how y2mate does it, or find an online downloader."

## WHAT CHANGED

| File | Change |
|------|--------|
| `media.js` | `@distube/ytdl-core` dependency REMOVED. Downloads now go through a pure-axios chain of online resolvers (y2mate-style: watch URL → direct media URL → download): **0. YouTube innertube player API (first-party, ANDROID client) → 1. Invidious instances → 2. Piped instances → 3. Cobalt instances**. First resolver with a playable direct URL wins; per-instance 10s timeout; every download still hard-capped at SCRAPER_MAX_MB (34MB) and stored via `temp.saveFile()` (1h cleanup). Search: Piped `/search` first, results-page scrape fallback. `streamToBuffer` removed (no longer needed). |
| `package.json` | version 2.2.0 → 2.2.1; `@distube/ytdl-core` removed from dependencies |
| `CHANGES.md` | this section |

Endpoints `/music`, `/video`, `/download` keep the exact same request/response
contracts the bot already calls — no bot-side change needed.

Env overrides: `PIPED_APIS`, `INVIDIOUS_APIS`, `COBALT_APIS` (comma-separated
instance lists) and `RESOLVER_TIMEOUT_MS` (default 10000).

## WHY MULTIPLE RESOLVERS

Public Invidious/Piped instances rate-limit datacenter IPs aggressively and
come and go; no single instance is reliable. The chain tries the first-party
YouTube innertube endpoint first (no third party), then fans out across
independent instance networks. If ALL fail the bot gets a clean error string
listing every resolver's failure (no crash, no hang).

## VERIFIED (dry run)

- `node --check` passes on all files ✅
- Boot + `/status` → 200 ✅
- `POST /music` from THIS sandbox → every resolver attempted, clean combined
  error (sandbox IP is blocked by YouTube + public instances: 400/403/525).
  Error path verified crash-free ✅
- `POST /download` direct-URL path verified (target server 429 from sandbox
  IP — clean error, no hang) ✅
- On your Render deployment test `!music <song>` / `!dl <yt-url>` after deploy;
  if an instance dies, add fresh ones via the env overrides.
