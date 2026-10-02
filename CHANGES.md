# Intelligent Scraper — CHANGES

## v4.0.0 — PLAYER-CONFIG VIDEO EXTRACTOR + 3 NEW VIDEO SITES + ALL SLOTS ON (whole-number release)

WHY: owner asked for "a full upgraded version which also downloads
videos — add 3 sites of your choice which provide scraped videos",
then "turn everything on".

1. v4.0 PLAYER-CONFIG EXTRACTOR (media.js) — tube sites hide the REAL
   file inside their player JS/JSON, not in plain <a>/<video> markup.
   Generic patterns (ZERO hostnames in code — sites live only in
   my_links.json): html5player setVideoUrlHigh/Low, JSON-LD contentUrl,
   KVS flashvars video_url (with https-recovery for "function/0/"-style
   prefixes), <source>/<video> tags, script src:/"file": slots.
2. RELATIVE video-page links — the old harvester only matched absolute
   URLs, so xnxx-style /video-xxx/… search links (and eporner, thisvid)
   were invisible. Now href/src relatives are absolutized against the
   slot URL, NAV listing pages (/search, /playlists, /categories…) are
   excluded so watch pages get the page budget, and CDN preview/thumb
   loops (5s junk mp4s) are filtered out.
3. HOTLINK-PROTECTED CDNs — video downloads now go through the
   UA+Referer fallback chain (the page that produced the URL is the
   Referer hint) before the plain capped fetch. Player-config URLs
   rank FIRST in the candidate sort (they are the real files).
4. THREE NEW VIDEO SLOTS (owner's "3 sites of your choice"), live-
   auditioned end-to-end through the real /video pipeline:
   · 15 XNXX      — PROVEN: 8.1MB real mp4 in 2s (player-config path)
   · 16 XMegaDrive — PROVEN: 10MB real mp4 (common tag listings)
   · 17 EPorner   — extraction PROVEN (contentUrl → gvideo .mp4); its
     CDN 403s datacenter IPs (residential IPs deliver fine)
   Also auditioned and rejected from this box: spankbang/xgroovy/
   xanimu (403 WAF), porntrex (CDN hang), thisvid (single-use get_file
   404), xhamster/porntn/xmilf/iceporn (JS-rendered grids, 0 links),
   motherless/tubepornclassy (dead DNS), porn555/hdzog/sunporno (0
   links). xhamster/pornhub/video stay dead from datacenter IPs.
5. OWNER TURNED EVERYTHING ON: all 17 slots enabled:true (was 5/14).
   Older WAF facts stay as warnings in the file's _HOW_TO. File order
   is kept — YonaYethuu stays first among video slots.
6. Version 3.1.1 → 4.0.0 (whole number) in server.js + package.json.
TESTS: test_v30_zerolinks 18/18 · test_v31_sites 14/14 (registry
assertions updated to the 17-slot all-on state) · live audition: XNXX
8.1MB ✓ · XMegaDrive 10MB ✓.

## v3.1.1 — LIVE SLOT AUDIT: junk-filter bug fix + registry repair

WHY: owner asked to "test if everything works and list all the new
links". The per-slot live test exposed a REAL bug and one dead slot.

1. FIXED (HIGH) — image junk filter rejected EVERY WordPress image:
   JUNK_URL_RE contained `ads?[-_/.]` which matches the `ads/` inside
   `upl**oads/**` — so every `wp-content/uploads/...jpg` thumbnail from
   WordPress sites (DarkNaija, MzansiFun, most blog CMSes) was dropped
   as "ads" and image slots returned 0 results. Now `\bads?[-_/.]`
   (word boundary): /wp-content/uploads/… passes, /ads/banner.jpg and
   ad-1.png are still rejected. 7/7 filter expectations verified;
   DarkNaija went 0 → 42 extracted images per page (only the site
   logo still filtered).
2. REGISTRY REPAIR (my_links.json):
   - slot 1 PornPics (image) → enabled:false: the site WAF-blocks
     datacenter IPs with ECONNRESET (from Render's IP too — the same
     block was observed in production). Documented in _HOW_TO.
   - slot 2 DarkNaija (image) → url switched to the query-relevant
     search form ?s={query} (the bare homepage only had recent posts;
     the ?s= form is already used by video slot 14 and returns 40
     query-matched images per page).
3. Per-slot live-test method fixed too: video slots are now tested in
   ISOLATION by hot-swapping the registry to one slot at a time (the
   old per-request method was masked — sortSlotsByFileOrder pins file
   slots ahead of request slots, so every test was answered by
   YonaYethuu).
4. version strings 3.1.0 → 3.1.1 (server.js /status + package.json).

## v3.1.0 — OWNER SLOTS + SITE PICKER: my_links.json is the ONLY source

WHY: owner supplied 14 slots ("add these sites") and asked that video
searches start on YonaYethuu by default with a way to pick another site.

1. my_links.json populated with the owner's 14 slots (file order):
   image  = PornPics (template /search/?q={query} — the bare homepage
            form was near-dead at 1 result), DarkNaija (auto ?s=),
            xvideos OFF;
   gif    = PornHub /gifs, DarkNaija Nude Pictures category, xvideos
            OFF, WetGIF ?s={query}&lang=en;
   video  = YonaYethuu (?s={query}) FIRST, then MzansiFun
            (?keyword={query}), HDPornPics.xxx (/search/{query}/),
            DarkNaija Leak Videos, PornPics /videos/, xvideos template
            OFF, DarkNaija ?s={query}.
2. /video accepts a site pick: name substring or pure slot number
   ("site:yona" / "site:2" / "#2"); numeric picks never substring-match
   URLs (a mock test caught 127.0.0.1 matching "2"). Unknown site =
   404 + the available[] list. sortSlotsByFileOrder pins FILE order
   even when the bot forwards the same URLs as env/request slots.
3. GET /video-sites: numbered, default-first list for the bot's
   !vidsites command; /status now triggers the mtime hot-reload check.
4. Gif slots also extract .mp4/.webm loops (blog "gif" posts embed
   mp4 — DarkNaija Nude Pictures class).
5. FINAL SWEEP (single-source-of-truth audit): zero media-site URLs or
   site names remain in any functional file (server.js, media.js,
   album.js, utils.js, temp.js) — the only matches are comments
   explaining the site-picker. Every search/download comes exclusively
   from my_links.json (hot-reloaded) / MYLINKS env / per-request.
6. package.json synced to 3.1.0 (was stale at 2.9.0).
7. Tests: scripts/test_v31_sites.js 13/13 (registry order, site pick,
   404+available, gif mp4 extraction, hot-reload restore);
   scripts/test_v30_zerolinks.js 17/17 (zero built-in sources, honest
   404s, per-request slots, 34.5MB video via slot, hot-reload).

## v2.9.0 — MYLINKS-ONLY: the file is the single source of truth

WHY: owner request — "use only the links in the file mylinks and
replace those links with the ones in album and other files".

1. my_links.json REWRITTEN (v2.9): the slots are now the exact URLs
   the code's own engines use, each LIVE-VERIFIED from a datacenter IP
   on 2026-10-01:
     Xbooru DAPI       50 file_url attrs / query  (full-res, direct)
     Rule34.xxx page   proven (thumbs auto-convert to full-res)
     TBIB DAPI         15 file_url attrs / query  (full-res, direct)
     Realbooru page    proven (thumbs auto-convert to full-res)
     Tenor page        16 gif links / query  (relevance-sorted)
     Giphy page        26 gif links / query  (relevance-sorted)
   DarkNaija slot DROPPED (JS-walled, 0 results in every test).
2. /search + /gif: NSFW requests (nsfw=true / site=nsfw, or env
   MYLINKS_ONLY=1) now come ONLY from the MyLinks slots — the generic
   engine chain is SKIPPED (no Bing/Wikimedia/1px junk in NSFW
   results, ever). SFW requests keep the clean Wikimedia fallback.
   EMERGENCY fallback: if MyLinks returns ZERO on an NSFW request, the
   engines run once so the bot never sends nothing.
3. /video unchanged: the built-in xnxx -> xhamster -> eporner chain
   from media.js (documented in the file's _HOW_TO).
4. Live-proven matrix (v2.9.0 instance):
   NSFW search  105 images, 105 from MyLinks, 0 foreign leads
   NSFW gif      27 gifs, all MyLinks
   SFW search   110 images (MyLinks lead + Wikimedia)
   video         xnxx 1.6-2.2MB

# Intelligent Scraper — CHANGES

## v2.8.2 — NSFW-ONLY VIDEO: every non-NSFW download fallback removed

WHY: owner request — "remove all the non-nsfw fallback on the downloads".

1. /video no longer touches YouTube AT ALL. The old flow tried
   ytSearch + ytDownload up to 4 times (20-90s of dead latency from
   datacenter IPs — search 404s / 200-empty) before reaching the NSFW
   chain. Now /video goes STRAIGHT to the verified NSFW chain:
   xnxx → xhamster → eporner.
2. The bot's exclude list (already-sent TITLES) is now honoured by
   EVERY NSFW source (xnxx slugs, xhamster slugs, eporner titles) —
   before it only filtered YouTube results, so multi-video runs could
   still repeat. makeTitleExcluder() + slugTitleOf() in media.js.
3. /music keeps YouTube as its only source (songs are not NSFW
   content) and /download still resolves whatever URL you give it —
   those are explicit requests, not fallbacks.

# intelligent-scraper

## v2.7.0 (feature, 2026-09-27) — LINK AUDIT: every slot live-verified + 2 engine bugs fixed

WHY: the user asked "verify if all my actual links work and give me new
links which actually work". Live testing through the REAL pipeline
(fetchPage → extractor → download probe) proved 5 of 7 slots were dead
(reddit 403, pornpics WAF-reset, babehub 403, darknaija 0 images,
pichunter 403) and surfaced 2 real bugs in the v2.6 engines.

1. SLOT AUDIT (each candidate tested for extraction AND download):
   • DEAD → REPLACED: reddit .json (403), pornpics (WAF), babehub (403),
     pichunter (403). Also dead: gelbooru (401), motherless (DNS),
     e621/danbooru/konachan/spankbang/fapello/mult34/imagefap (403/404),
     xnxx/xvideos (0 static), redgifs API (401).
   • NEW SLOT 1 realbooru browse — verified 20-41 thumbs → FULL-RES
     conversion (148KB JPEG probe), download requires own Referer.
   • NEW SLOT 2 xbooru dapi XML — file_url="…" full-res direct
     (20 attrs verified).
   • NEW SLOT 3 rule34.xxx browse — wimg thumbs → FULL-RES
     (194KB JPEG probe, .jpeg ext).
   • SLOT 4 tbib browse kept (15 real thumbs, small = fallback only).
   • SLOT 5 darknaija kept (blog fallback, never breaks a search).
   • SLOTS 6-7 tenor + giphy VERIFIED working (2 + 353 gifs).
2. NEW utils.booruFullUrls(): thumbnail → full-original rewrite
   (realbooru same-ext, rule34 .jpeg/.png hedge). Slot pipeline AND
   the realbooru engine share it.
3. NEW utils.extractDapiFileUrls(): file_url="…" regex — dapi XML
   slots and any XML answer now yield full-res direct URLs.
4. BUGFIX realbooruImages: tags joined with '_' made ONE unknown tag
   → 1 result; now '+' (+ full browser headers via fetchPage).
   Verified 41 thumbs 3/3 runs.
5. BUGFIX runEngines merge: bucket concat let xbooru (40 hits) fill
   the whole 40-cap so realbooru never surfaced. Now ROUND-ROBIN
   interleave in engine priority order — slots lead, boorus MIX.
6. media.js CDN_REFERER_MAP: + realbooru.com / xbooru / img.xbooru /
   rule34.xxx / wimg / tbib.org (realbooru refuses downloads without
   its own Referer).
7. Version strings → 2.7.0 (package.json, /status, /my-links, /search).

## v2.6.0 (feature, 2026-09-27) — SEARCH RELEVANCE OVERHAUL — "actually what I searched for"

WHY: panel diagnostics showed 5 of 7 user slots returning 0 results
(JS-walled reddit, JS pornpics, wrong URL patterns) and Bing shipping
SafeSearch ON for datacenter IPs — so every NSFW image search emptied
out and the bot fell back to random 5-21KB junk gifs. The user asked
for "a better version — the actual nsfw content".

1. TWO NEW FULL-RES NSFW ENGINES (static, keyless, verified live):
   • xbooru — Gelbooru-style dapi XML, multi-word tags ("ebony+ass" →
     103 posts), direct file_url originals, 40 per search.
   • realbooru — real-porn booru HTML browse; thumbnails convert to
     full via /thumbnails/XX/YY/thumbnail_HASH.jpg → /images/XX/YY/HASH.jpg
     (downloads send the same-origin Referer they require).
2. Bing Images now requests ADULT MODE (adlt=off URL param + ADLT=OFF
   cookie) + regex murl fallback when the HTML shape changes.
3. Reddit engine rebuilt: query-aware old.reddit.com/search.json
   (include_over_18=on) replaces the hardcoded r/boobs listing.
4. PRIORITY ORDER FIX: engine results now merge in priority order
   (your slots → xbooru → realbooru → reddit → bing → flickr → …),
   NOT in HTTP-completion order — Flickr used to lead because it
   answered first, so the bot downloaded a random SFW photo.
5. GIF channel MERGE-ALL: tenor + giphy + reddit all run and merge
   (deduped) instead of stopping at the first source.
6. JSON SLOTS: any my_links.json slot URL ending in .json is parsed as
   JSON — slot 1 is now old.reddit.com/search.json?q={query}
   &include_over_18=on (NSFW reddit answers datacenter IPs).
7. Slot pattern fixes: darknaija /search/{query} → /?s={query}
   (WordPress standard), pichunter /gallery/{query} → /search/{query}.
8. Per-engine diagnostics: /search and /gif responses carry
   engines:{name:count} — the bot panel shows exactly which engine
   delivered. Cap raised 25 → 40. /my-links diag text updated.

## v2.5.3 (patch, 2026-09-27) — URL DEDUPE + VERSION BUMP

1. getMyLinks() now DEDUPES identical URLs across the three sources
   (per-request links from the bot, my_links.json file slots, MYLINKS
   env). Why: the bot (v71.2) HARD-CODES the same 7 sites it forwards
   with every search — without this filter every URL was fetched TWICE
   per search. First occurrence wins: request links lead, then file,
   then env.
2. Hardcoded /status and /my-links version string bumped '2.5.2' -> '2.5.3'
   (package.json matches).
3. Bot-side companion (v71.2): the panel's "🌐 Scraper Sites" card now
   ALWAYS shows the 7 sites — the bot answers with HARD-CODED values
   when this service is offline, and live diagnostics when it is up.

## v2.5.2 (patch, 2026-09-27) — REAL LINKS SYNCED + VERSION STRING

1. my_links.json now carries the user's ACTUAL 7 live slots (synced from
   the running deployment — reddit/pornpics/babehub/darknaija/pichunter
   images + tenor/giphy gifs, all enabled) so a redeploy from GitHub can
   never overwrite the real sites with demo placeholders again.
2. /status and /my-links hardcoded version string corrected '2.5.1' -> '2.5.2'.
3. Bot-side companion (v71.2): the admin panel now has a "🌐 Scraper
   Sites" card that proxies /my-links and lists these exact values live.

## v2.5.2 — EXCLUDE + AUTO-CLEANUP + TENOR SLOT

1. POST /video accepts `exclude` (array of already-sent video ids or
   titles) and `videoId` in the response — the bot can now request 6
   DIFFERENT videos for one scheduled run instead of the same clip.
   Search widened to top-10 candidates.
2. PERIODIC TEMP SWEEP every 15 min (1 h max file age, on top of the
   existing on-add cleanup) — disk stays free even on idle days.
3. my_links.json: gif slot example switched to a working Tenor
   template (https://tenor.com/search/{query}-gifs) and ENABLED —
   three live engines out of the box: images (your links + Bing),
   gifs (Tenor slot), videos (YouTube, always on). Hot-reload intact.

package 2.5.2.

# intelligent-scraper

## v2.5.0 — YOUR SITES FIRST + HOTLINK-SAFE DOWNLOADS

### 1. Download 500 on my-link CDN images (the boss's log)
`scraper download "https://dygtyjqp7pi0m.cloudfront.net/i/66451/…jpg": 500`
media.js retried only User-Agents; hotlink-protected CDNs (pngtree via
cloudfront) require a same-site Referer. v2.5 attempt chain:
honest bot UA → browser UA → browser UA + mapped/derived
Referer+Origin+Accept; retries 403/404/418/429; the final error is
human ("CDN refused — hotlink protection; the bot tries the next
result"). The BOT also now retries up to 4 candidates.

### 2. Your links are tried FIRST (ordering bug)
/search and /gif merged my-link results LAST while the bot downloads
images[0] — your own sites could never win. v2.5: `[...myUrls, ...urls]`
+ `myLinksFirst: true` in the response.

### 3. Three ways to add your sites (all merged)
my_links.json (HOT-RELOADED — edit → next search, no restart) + MYLINKS
env (comma-separated URLs, on this service OR on the bot, which forwards
its own automatically) + per-request POST /search {"myLinks":[…]}.
Per-request links lead the slot list.

### 4. Diagnostics — SEE which slots work
GET /my-links now returns per-slot lastResult {ts, count, error}
(JW-walled pages are labeled as such — the Bing site: boost still covers
them), plus envSlots. /status gained hotReload/triedFirst/envSlots.

### 5. Hygiene
/temp self-cleanup every 30 min; version 2.5.0; my_links.demo.json
shows actual-value examples of all three URL forms.

# intelligent-scraper

## v2.4.0 — REAL IMAGE SEARCH (the logo problem is dead)

### The problem (user evidence)
"the scrapper is not doing a proper search like for example
https://pngtree.com/free-animals-png/fish — i just added the link to the
mylinks https://pngtree.com but its failing to search and download the
actual image, its downloading the logo."

Root causes found:
1. `searchImages()` IGNORED its `site` argument and ran a fixed chain
   (darknaija → pornpics → reddit r/boobs → imagefaqs) for EVERY query —
   SFW queries were being answered by adult sites' leftovers, and the
   first `<img>` on a blog page is usually the LOGO.
2. `extractImageUrls` only rejected 'icon'/'logo' substrings — sprites,
   avatars, banners, buttons, placeholders, extension-less trackers all
   passed (the 5KB-in-97ms "download.png").
3. `myLinkUrl` appended `?s=<query>` to bare domains — on pngtree that
   renders the HOMEPAGE, and a pinned category URL got wrecked too.

### The fix
- NEW multi-engine search (album.js): Bing Images (HTML murl parse),
  Flickr public feed (no key), Wikimedia Commons API, Wikipedia
  pageimages, Openclipart — merged, deduped, relevance-ranked (query
  word in URL first), junk-filtered, capped 25. Engines fail
  independently; NSFW chain (pornpics/reddit) runs ONLY on nsfw=true.
- NEW junk gate (utils.js): logo/sprite/avatar/icon/button/banner/ad/
  placeholder/emoji/tracker patterns, svg/base64, extension-less
  unknown hosts, tiny-size hints (w=32, -32x32) all rejected.
- SMART my_links: pinned category pages fetched AS-IS; bare domains
  boosted via Bing `query site:domain` so JS-rendered sites still
  return their real images; {query} templates unchanged.
- UA fallback chain (media.js): Wikimedia thumb server 403s browser
  UAs — honest bot UA tried first, browser UA as fallback; 403/429/418
  retries with the other UA.
- my_links.json: pngtree slot shipped live as the example; dummy slots
  disabled instead of enabled-by-default.

### Test evidence (live, from this repo)
- "peas" → 16-23 real images (Wikimedia + Bing + Flickr) in ~2s
- "fish png" → 13 real fish PNGs; "chess board" → 25 (Bing 35 raw)
- Downloads: NCI_peas_in_pod.jpg 62KB / Puntius fish PNG 665KB /
  flickr 181KB — all real content, zero logos
- Full HTTP round-trip on a live instance: /search → /download →
  302KB image/jpeg in one call

# Intelligent Scraper — CHANGE LOG

## v2.3.0 — MY LINKS: 7 dummy slots you replace with your own

| File | Change |
|------|--------|
| my_links.json | NEW — 7 clearly-labelled dummy slots (`https://www.replace-me-1.com/...`) + a _HOW_TO block. Replace the URLs with your own sites; keep `{query}` where the search word goes; set type `image` or `gif`; `enabled` true/false. |
| server.js | MY LINKS loader at boot (bad/missing file never crashes the scraper), `tryMyLinks()` merge into POST /search (images) and GET /gif (gifs), GET /my-links endpoint to inspect your slots, /status now reports `myLinks: {loaded, enabled}` and version 2.3.0. |
| album.js / gif.js / media.js | NOT TOUCHED — byte-identical to v2.2.1 (all built-in direct links, incl. NSFW, verified by sha256). |

### Guarantees

- A dead/dummy slot NEVER breaks a search: each slot fails independently
  (15s cap), is skipped and logged with "replace it in my_links.json".
- Your links are tried AFTER the built-in sites and merged + de-duplicated.
- The response now includes `myLinks: N` so you can see how many results
  came from your own sites.


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

## v2.8.0 — 2026-09-27 — REAL-QUERY PROOF: wrong files fixed, video rebuilt
Live end-to-end verification with actual user-style queries on every media type.

FIXED — WRONG FILES (the user complaint):
1. GIF channel: tenor/giphy pages embed related+trending sections — "ebony" led with
   ilove-mexican-food-mexican.gif, "blowjob" led with she-hulk.gif / bj-novak-thinking.gif.
   utils.relevantGifs(): dedupe by media id (same gif used to appear 3x) + slug relevance
   (on-topic slugs lead; off-topic only as filler). Applied in gif.js, tryMyLinks AND the
   final merged /gif list.
2. Images: booru posts get deleted after listing — images[0] could 404 ("big boobs").
   utils.verifyLeadingImages(): probes the first 4-8 candidates in parallel with a ranged
   GET + Referer and floats a VERIFIED-ALIVE image to the front.
3. TBIB slot shipped 4KB thumbnails (HTML listing) — switched to DAPI XML (verified 118KB
   full-res from the same post).
4. /download 404 error message was misleading — bot-side now receives honest errors.

VIDEO — REBUILT (was 100% dead):
- Resolver chain was all dead from DC IPs (innertube 400, invidious 5/5 dead, cobalt 400).
- media.js: cobalt instances upgraded to the v10 API (downloadMode replaces audioOnly —
  the old field made every modern instance reject with error.api.invalid_body); alive
  instances first (co.otomir23.me tunnel verified, api.piped.private.coffee search+streams).
- NEW NSFW fallback chain with ACTUAL search (all verified live from this build):
    xnxx     — search → page → signed xnxx-cdn mp4 (22-33MB verified)
    xhamster  — search → page → xhcdn mp4 (32MB verified)
    eporner   — public API v2 search (on-topic titles) → /dload mp4
  Shared VIDEO_RECENT list: different query / consecutive sends NEVER repeat a clip.
  Slug relevance filters sidebar junk (twerking queries used to return "youtuber-13854986").
