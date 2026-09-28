'use strict';

/* ============================================================
 *  media.js — /music, /video, /download backing for BreadBot
 *
 *  WHY THIS EXISTS (integration fix):
 *  whatsapp-qr-app/server.js calls:
 *      POST /music   { query }        -> { mediaUrl, title, mimetype, sizeBytes }
 *      POST /video   { query }        -> { mediaUrl, title, mimetype, sizeBytes }
 *      POST /download{ url, kind }    -> { mediaUrl, title, mimetype, kind, sizeBytes }
 *  None of these endpoints existed, so every !dl / !music / song
 *  request from the bot hit a 404. This module implements them.
 *
 *  v2.2.1 — ytdl-core REMOVED (user request: "ytdl-core doesn't work,
 *  find other ways… how y2mate does it / an online downloader"):
 *  - Search: results-page scrape (unchanged) + Piped API fallback.
 *  - Download: pure-axios chain of online resolver APIs, same idea as
 *    y2mate — resolve watch URL -> direct media URL, then download:
 *      1. Invidious instances  /api/v1/videos/<id>
 *      2. Piped instances      /streams/<id>
 *      3. Cobalt instances     POST /  (tunnel)
 *    First resolver that returns a playable URL wins. No ytdl
 *    dependency at all — plain HTTP with the same 34MB hard cap.
 *  - Storage: reuses temp.saveFile() so the 1h auto-cleanup applies.
 * ============================================================ */

const axios = require('axios');
const temp = require('./temp');

/* Online resolver instances (override via env, comma-separated).
 * Every one of them does exactly what y2mate does: hand back a direct
 * googlevideo/CDN URL for a watch URL — we just download that URL. */
const PIPED_APIS = (process.env.PIPED_APIS ||
  'https://api.piped.private.coffee,https://pipedapi.kavin.rocks,https://pipedapi.adminforge.de,https://pipedapi.drgns.space').split(',').map(s => s.trim()).filter(Boolean);
const INVIDIOUS_APIS = (process.env.INVIDIOUS_APIS ||
  'https://invidious.f5.si,https://inv.nadeko.net,https://invidious.nerdvpn.de,https://yewtu.be,https://iv.melmac.space').split(',').map(s => s.trim()).filter(Boolean);
const COBALT_APIS = (process.env.COBALT_APIS ||
  'https://co.otomir23.me,https://capi.3kh0.net,https://cobalt-backend.canine.tools').split(',').map(s => s.trim()).filter(Boolean);
const RESOLVER_TIMEOUT_MS = Math.max(4000, parseInt(process.env.RESOLVER_TIMEOUT_MS || '10000', 10));

const MAX_MB = Math.max(1, parseInt(process.env.SCRAPER_MAX_MB || '34', 10));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function ytId(urlOrId) {
    const m = String(urlOrId || '').match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

/* ── YouTube search: scrape results page, fall back to Piped API ── */
async function ytSearch(query, limit = 5) {
    // 1) Piped search (proper API, no scraping) — instance rotation
    for (const base of PIPED_APIS) {
        try {
            const r = await axios.get(base + '/search?q=' + encodeURIComponent(query) + '&filter=videos',
                { timeout: RESOLVER_TIMEOUT_MS, headers: { 'User-Agent': UA } });
            const vids = (r.data && Array.isArray(r.data.items) ? r.data.items : [])
                .filter(v => v && (v.url || v.id))
                .slice(0, limit)
                .map(v => ({ id: (v.url || '').split('v=')[1] || v.id, title: v.title || 'YouTube video' }))
                .filter(v => v.id && v.id.length === 11);
            if (vids.length) return vids;
        } catch (e) { /* try next instance */ }
    }
    // 2) scrape the results page for videoId/title pairs
    try {
        const r = await axios.get('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), {
            headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
            timeout: 20000
        });
        const html = typeof r.data === 'string' ? r.data : '';
        const out = [];
        const seen = new Set();
        const re = /"videoId":"([A-Za-z0-9_-]{11})".*?"title":\{"runs":\[\{"text":"(.*?)"\}/g;
        let m;
        while ((m = re.exec(html)) !== null && out.length < limit) {
            if (!seen.has(m[1])) {
                seen.add(m[1]);
                out.push({ id: m[1], title: m[2].replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\n/g, ' ') });
            }
        }
        if (!out.length) {
            for (const mm of html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)) {
                if (!seen.has(mm[1])) { seen.add(mm[1]); out.push({ id: mm[1], title: 'YouTube video' }); }
                if (out.length >= limit) break;
            }
        }
        return out;
    } catch (e) {
        console.error('yt scrape failed:', e.message);
        return [];
    }
}

/* ── Capped download of a direct media URL (shared by all resolvers) ── */
async function fetchCapped(url) {
    const cap = MAX_MB * 1024 * 1024;
    const r = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: cap + 1,
        maxBodyLength: cap + 1,
        validateStatus: s => s >= 200 && s < 400,
        headers: { 'User-Agent': UA, 'Referer': 'https://www.youtube.com/' }
    });
    const buf = Buffer.from(r.data);
    if (!buf.length) throw new Error('Downloaded file is empty');
    if (buf.length > cap) throw new Error(`Media exceeds ${MAX_MB}MB cap`);
    return buf;
}

/* ── Resolver 0: YouTube innertube player API (first-party — the same
 *    trick y2mate-class sites use). No key needed; ANDROID client.
 *    Skips formats that only ship a signatureCipher (can't decrypt
 *    without deps); uses entries that carry a literal url. ── */
async function resolveInnertube(vid, kind) {
    const body = {
        context: { client: { clientName: 'ANDROID', clientVersion: '19.09.37',
                             androidSdkVersion: 30, hl: 'en' } },
        videoId: vid, contentCheckOk: true, racyCheckOk: true
    };
    const r = await axios.post('https://www.youtube.com/youtubei/v1/player', body, {
        timeout: RESOLVER_TIMEOUT_MS,
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
            'X-YouTube-Client-Name': '3',
            'X-YouTube-Client-Version': '19.09.37'
        }
    });
    const d = r.data || {};
    if (d.playabilityStatus && d.playabilityStatus.status !== 'OK') {
        throw new Error('innertube: ' + (d.playabilityStatus.reason || d.playabilityStatus.status));
    }
    const sd = d.streamingData || {};
    const all = (sd.formats || []).concat(sd.adaptiveFormats || []);
    let pick = null;
    if (kind === 'audio') {
        pick = all.filter(f => f.url && String(f.mimeType || '').startsWith('audio'))
                  .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    } else {
        pick = all.filter(f => f.url && String(f.mimeType || '').startsWith('video')
                              && String(f.mimeType || '').includes('mp4')
                              && (f.height || 0) <= 720 && (f.height || 0) > 0)
                  .sort((a, b) => (b.height || 0) - (a.height || 0))[0]
            || all.filter(f => f.url && String(f.mimeType || '').startsWith('video'))
                  .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    }
    if (!pick || !pick.url) throw new Error('innertube: no direct-url format');
    return {
        url: pick.url,
        title: (d.videoDetails && d.videoDetails.title) || ('YouTube ' + kind),
        mimetype: String(pick.mimeType || '').split(';')[0].trim()
    };
}

/* ── Resolver 1: Invidious — /api/v1/videos/<id> ── */
async function resolveInvidious(vid, kind) {
    for (const base of INVIDIOUS_APIS) {
        try {
            const r = await axios.get(base + '/api/v1/videos/' + vid,
                { timeout: RESOLVER_TIMEOUT_MS, headers: { 'User-Agent': UA } });
            const d = r.data;
            if (!d || (!d.adaptiveFormats && !d.formatStreams)) continue;
            let pick = null, mime = '';
            if (kind === 'audio') {
                const auds = (d.adaptiveFormats || [])
                    .filter(f => String(f.type || '').startsWith('audio'))
                    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                pick = auds[0];
            } else {
                // progressive streams carry both video+audio (like y2mate's mp4)
                const vids = (d.formatStreams || [])
                    .filter(f => String(f.type || '').includes('mp4'))
                    .sort((a, b) => parseInt(b.resolution || 0) - parseInt(a.resolution || 0));
                pick = vids.find(f => parseInt(f.resolution || 0) <= 720) || vids[0];
            }
            if (!pick || !pick.url) continue;
            mime = String(pick.type || '').split(';')[0].trim();
            return { url: pick.url, title: d.title || ('YouTube ' + kind), mimetype: mime };
        } catch (e) { /* try next instance */ }
    }
    throw new Error('Invidious: no resolver had the video');
}

/* ── Resolver 2: Piped — /streams/<id> ── */
async function resolvePiped(vid, kind) {
    for (const base of PIPED_APIS) {
        try {
            const r = await axios.get(base + '/streams/' + vid,
                { timeout: RESOLVER_TIMEOUT_MS, headers: { 'User-Agent': UA } });
            const d = r.data;
            if (!d) continue;
            let pick = null, mime = '';
            if (kind === 'audio') {
                const auds = (d.audioStreams || [])
                    .filter(s => s && s.url)
                    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                pick = auds.find(s => String(s.mimeType || s.format || '').includes('mpeg')) || auds.find(s => String(s.mimeType || s.format || '').includes('mp4')) || auds[0];
            } else {
                // videoOnly streams lack audio; prefer combined (videoOnly=false)
                const vs = (d.videoStreams || []).filter(s => s && s.url && !s.videoOnly)
                    .sort((a, b) => (b.height || 0) - (a.height || 0));
                pick = vs.find(s => (s.height || 0) <= 720) || vs[0];
            }
            if (!pick || !pick.url) continue;
            mime = String(pick.mimeType || pick.format || '').split(';')[0].trim();
            return { url: pick.url, title: d.title || ('YouTube ' + kind), mimetype: mime };
        } catch (e) { /* try next instance */ }
    }
    throw new Error('Piped: no resolver had the video');
}

/* ── Resolver 3: Cobalt — POST / with the watch URL (y2mate-style tunnel) ──
 *    v2.8: instances upgraded to the Cobalt v10 API — the old v9 body
 *    field `audioOnly` makes every modern instance reject the request
 *    with error.api.invalid_body. v10 wants downloadMode:
 *      'auto' | 'audio' | 'mute'.  Verified live 2026-09-27:
 *      co.otomir23.me -> tunnel + direct URL for video AND audio mp3. ── */
async function resolveCobalt(idOrUrl, kind) {
    const watch = String(idOrUrl).length === 11
        ? 'https://www.youtube.com/watch?v=' + idOrUrl
        : String(idOrUrl);
    for (const base of COBALT_APIS) {
        try {
            const r = await axios.post(base + '/',
                { url: watch, downloadMode: kind === 'audio' ? 'audio' : 'auto', videoQuality: '720' },
                { timeout: RESOLVER_TIMEOUT_MS, headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA } });
            const d = r.data || {};
            if ((d.status === 'tunnel' || d.status === 'stream' || d.status === 'redirect') && d.url) {
                return { url: d.url, title: d.filename || ('YouTube ' + kind), mimetype: kind === 'audio' ? 'audio/mpeg' : 'video/mp4' };
            }
        } catch (e) { /* try next instance */ }
    }
    throw new Error('Cobalt: no resolver had the video');
}

/* ── Download a YouTube id/url as audio or video via the resolver
 *    chain, store in temp. ──
 *    v2.8 ORDER (live-probed 2026-09-27): innertube first (fails fast
 *    on 400 when YouTube refuses DC IPs — zero cost), then Cobalt
 *    (co.otomir23.me — the ONLY verified-alive tunnel), then Piped
 *    (api.piped.private.coffee — verified alive for search+streams),
 *    Invidious LAST (all 5 hardcoded instances were dead: timeouts,
 *    403s, or 200-with-no-URLs). The old order burned ~30s on dead
 *    Invidious/Piped instances before ever reaching a live one. */
async function ytDownload(idOrUrl, kind, baseUrl) {
    const vid = ytId(idOrUrl) || idOrUrl;
    if (!vid || vid.length !== 11) throw new Error('Invalid YouTube id');
    if (kind !== 'audio' && kind !== 'video') kind = 'video';

    const resolvers = [resolveInnertube, resolveCobalt, resolvePiped, resolveInvidious];
    const errors = [];
    let resolved = null;
    for (const fn of resolvers) {
        try { resolved = await fn(vid, kind); break; }
        catch (e) { errors.push(e.message); }
    }
    if (!resolved) throw new Error('All online resolvers failed: ' + errors.join(' | '));

    const buf = await fetchCapped(resolved.url);
    let mimetype = (resolved.mimetype || '').toLowerCase();
    if (!mimetype.startsWith('audio') && !mimetype.startsWith('video')) {
        mimetype = kind === 'audio' ? 'audio/mp4' : 'video/mp4';
    }
    const ext = mimetype.includes('webm') ? '.webm'
              : mimetype.includes('mpeg') ? '.mp3'
              : (kind === 'audio' ? '.m4a' : '.mp4');
    const id = temp.saveFile(buf, ext);
    return { mediaUrl: baseUrl + '/temp/' + id + ext, title: resolved.title, mimetype, kind, sizeBytes: buf.length };
}

/* ── Generic direct-URL download (mp3 sites, image CDNs, etc.) ──
 * v2.4: UA fallback chain — some CDNs (Wikimedia thumb server) 403
 * browser-style UAs and REQUIRE an honest bot UA, while most other
 * sites are the opposite. Try one, on 403/429 retry with the other.
 * v2.5: REFERER fallback — the real fix for the 500 on your own-site
 * images: hotlink-protected CDNs (pngtree via cloudfront
 * dygtyjqp7pi0m.cloudfront.net, some wp/CDN hosts) reject ANY request
 * without a same-site Referer. We now try: plain bot UA → plain
 * browser UA → browser UA + mapped/derived Referer. A refused CDN now
 * also produces an HUMAN error instead of a bare axios 500. */
const FETCH_UAS = [
    'BreadBotScraper/2.5 (media fetcher; contact: admin@breadbot.local)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
];
/* known CDN → the site that must appear as Referer */
const CDN_REFERER_MAP = [
    { test: /cloudfront\.net\/i\/\d+\//i, referer: 'https://pngtree.com/' },
    { test: /pngtree\.com|pngtree-/i,     referer: 'https://pngtree.com/' },
    { test: /freepik\.|static\.freepik/i, referer: 'https://www.freepik.com/' },
    { test: /cleanpng/i,                  referer: 'https://www.cleanpng.com/' },
    { test: /wallpapercave/i,             referer: 'https://wallpapercave.com/' },
    /* v2.7 booru hosts — realbooru REFUSES downloads without its own
     * Referer (verified live); the others get the same courtesy. */
    { test: /(^|\.)realbooru\.com/i,       referer: 'https://realbooru.com/' },
    { test: /(^|\.)(img\.)?xbooru\.com/i,  referer: 'https://xbooru.com/' },
    { test: /(^|\.)(wimg\.)?rule34\.xxx/i, referer: 'https://rule34.xxx/' },
    { test: /(^|\.)tbib\.org/i,            referer: 'https://tbib.org/' }
];
function refererCandidates(u){
    const out = [];
    for (const m of CDN_REFERER_MAP){ if (m.test.test(u)) out.push(m.referer); }
    try {
        const pu = new URL(u);
        /* pngtree-style path pattern (/i/<numeric-id>/…) on any host */
        if (/^\/i\/\d+\//.test(pu.pathname)) out.push('https://pngtree.com/');
        out.push(pu.protocol + '//' + pu.hostname + '/');   /* same-origin — the common case */
    } catch (e) {}
    return [...new Set(out)];
}
const RETRY_STATUSES = new Set([403, 404, 418, 429]);   /* 404: some CDNs fake-404 without referer */
const BLOCKED_CT_RE = /text\/html|application\/json|text\/plain/i;
function respLen(r){ try { return r.data ? (r.data.byteLength ?? r.data.length ?? 0) : 0; } catch (e) { return 0; } }
async function fetchWithUaFallback(url, opts) {
    let lastErr = null;
    const attempts = [];
    attempts.push({ ua: FETCH_UAS[0], referer: null });   /* honest bot UA — Wikimedia needs this */
    attempts.push({ ua: FETCH_UAS[1], referer: null });   /* plain browser UA */
    for (const ref of refererCandidates(url)){
        attempts.push({ ua: FETCH_UAS[1], referer: ref }); /* browser UA + Referer — hotlink CDNs need this */
    }
    for (const a of attempts){
        try {
            const headers = Object.assign({}, (opts && opts.headers) || {}, { 'User-Agent': a.ua });
            if (a.referer){
                headers['Referer'] = a.referer;
                headers['Origin']  = a.referer.replace(/\/$/, '');
                headers['Accept']  = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';
            }
            const r = await axios.get(url, Object.assign({}, opts, { headers }));
            /* v2.7 BLOCKED-PAGE GATE: a 200 that answers a tiny HTML/JSON
             * body is a hotlink block page, NOT the media — realbooru does
             * exactly this (22B text/html). Treat it as a refusal and fall
             * through to the next UA+Referer attempt. */
            const ct = String((r.headers && r.headers['content-type']) || '');
            const len = respLen(r);
            if (BLOCKED_CT_RE.test(ct) || (len > 0 && len < 512 && !/application\/(pdf|octet-stream)/i.test(ct))) {
                lastErr = new Error('HTTP 200 but blocked page (' + len + 'B ' + (ct.split(';')[0] || '?') + ')');
                continue;
            }
            return r;
        } catch (e) {
            lastErr = e;
            const st = e.response && e.response.status;
            if (!RETRY_STATUSES.has(st)) throw e;   /* non-UA/referer problem — do not retry */
        }
    }
    const st = lastErr && lastErr.response && lastErr.response.status;
    throw new Error('CDN refused the download (last status ' + (st || 'n/a') +
        ') — hotlink protection. The bot automatically tries the next result.');
}
async function genericDownload(url, kind, baseUrl) {
    const cap = MAX_MB * 1024 * 1024;
    const r = await fetchWithUaFallback(url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: cap + 1,
        maxBodyLength: cap + 1,
        validateStatus: s => s >= 200 && s < 400
    });
    const buf = Buffer.from(r.data);
    if (!buf.length) throw new Error('Empty file');
    let mimetype = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const extMap = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
        'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
        'audio/ogg': '.ogg', 'audio/wav': '.wav', 'application/pdf': '.pdf'
    };
    const ext = extMap[mimetype] || '.bin';
    const id = temp.saveFile(buf, ext);
    const resolvedKind = kind && kind !== 'auto'
        ? kind
        : mimetype.startsWith('audio') ? 'audio'
        : mimetype.startsWith('video') ? 'video'
        : mimetype.startsWith('image') ? 'image' : 'file';
    return {
        mediaUrl: baseUrl + '/temp/' + id + ext,
        title: 'download' + ext,
        mimetype: mimetype || 'application/octet-stream',
        kind: resolvedKind,
        sizeBytes: buf.length
    };
}

/* ── v2.8: XHAMSTER FALLBACK — real NSFW video with ACTUAL search ──
 * Why: YouTube refuses NSFW-ish queries from datacenter IPs — live
 * proof 2026-09-27: "big booty twerking" → 0 search results, "ebony
 * twerk" → resolved URL returned a 200-with-0-bytes stream from the
 * only-alive cobalt tunnel. xhamster search HTML parses fine from DC
 * IPs and its video pages embed DIRECT xhcdn mp4 URLs — VERIFIED
 * download: 200 video/mp4.
 * Strategy: search → collect video-page links → per page pull the
 * mp4 candidates (prefer 720/h264 URLs) → download the first that
 * yields a real file (>300KB, under MAX_MB) → serve from /temp.   */
/* recently served video pages (shared across sources) — so consecutive
 * queries return DIFFERENT clips ("different query different video") */
const VIDEO_RECENT = [];

/* slug-vs-query relevance: prefer pages whose URL carries query words */
function videoSlugScore(url, words) {
    const slug = String(url).toLowerCase();
    if (!words.length) return 0;
    return words.filter(w => slug.includes(w)).length > 0 ? 0 : 1;
}

/* ── v2.8: XNXX VIDEO — verified end-to-end 2026-09-27 ──────────
 * search xnxx.com/search/{q} → /video-{id}/{slug} paths → page embeds
 * signed mp4-cdn*.xnxx-cdn.com URLs → VERIFIED download: 200, 22.1MB
 * video/mp4. On-topic slugs come straight from the search results.  */
async function xnxxVideo(query, baseUrl) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const s = await axios.get('https://www.xnxx.com/search/' + encodeURIComponent(String(query).trim().replace(/\s+/g, '+')) + '/',
        { timeout: 20000, headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    const paths = [...new Set((String(s.data).match(/\/video-[a-z0-9]+\/[^"'\s<>]+/gi) || []))];
    if (!paths.length) throw new Error('xnxx: 0 video pages for "' + query + '"');
    const scored = paths
        .map(p => 'https://www.xnxx.com' + p.replace(/"/g, ''))
        .filter(u => !VIDEO_RECENT.includes(u))
        .sort((a, b) => videoSlugScore(a, words) - videoSlugScore(b, words));
    for (const vp of scored.slice(0, 4)) {
        try {
            const p = await axios.get(vp, { timeout: 20000, headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
            const cands = [...new Set((String(p.data).match(/https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*/g) || [])
                .filter(u => /xnxx-cdn|mp4-cdn/.test(u)))];
            if (!cands.length) continue;
            /* prefer explicit quality markers (720 > 480 > 360), then longer signed url */
            cands.sort((a, b) => {
                const q = u => (/720p/.test(u) ? 3 : /480p/.test(u) ? 2 : /360p/.test(u) ? 1 : 0);
                return (q(b) - q(a)) || (b.length - a.length);
            });
            const slugTitle = decodeURIComponent((vp.match(/\/video-[a-z0-9]+\/([^"'/]+)/i) || [])[1] || 'video')
                .replace(/_/g, ' ').trim();
            for (const cu of cands.slice(0, 3)) {
                try {
                    const buf = await fetchCapped(cu);
                    if (buf.length < 300 * 1024) continue;
                    const id = temp.saveFile(buf, '.mp4');
                    VIDEO_RECENT.push(vp); if (VIDEO_RECENT.length > 15) VIDEO_RECENT.shift();
                    return { mediaUrl: baseUrl + '/temp/' + id + '.mp4', title: slugTitle.slice(0, 120), mimetype: 'video/mp4', kind: 'video', sizeBytes: buf.length };
                } catch (e) { /* next candidate */ }
            }
        } catch (e) { /* next page */ }
    }
    throw new Error('xnxx: no downloadable mp4 for "' + query + '"');
}

/* ── v2.8: EPORNER VIDEO — public API v2 search (titles are ON TOPIC),
 * video page exposes /dload/{vid}/{q}/{file}-{q}p.mp4 paths. NOTE:
 * gvideo.eporner.com 403s datacenter IPs; the dload host resolved
 * unreachable from the build sandbox — works from some networks, so
 * it ships LAST in the chain: if it can't download it just skips.  */
async function epornerVideo(query, baseUrl) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const r = await axios.get('https://www.eporner.com/api/v2/video/search/?query=' + encodeURIComponent(query) +
        '&per_page=10&thumbsize=big&order=latest&gay=0&lq=1&format=json',
        { timeout: 20000, headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    const vids = (r.data && r.data.videos) || [];
    const fresh = vids.filter(v => v && v.id && !VIDEO_RECENT.includes('ep:' + v.id));
    if (!fresh.length) throw new Error('eporner: 0 fresh results for "' + query + '"');
    for (const v of fresh.slice(0, 3)) {
        try {
            const page = v.url || ('https://www.eporner.com/video-' + v.id + '/');
            const p = await axios.get(page, { timeout: 20000, headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
            const dloads = [...new Set((String(p.data).match(/\/dload\/[a-zA-Z0-9]+\/\d+\/[a-zA-Z0-9-]+\.mp4/g) || []))];
            if (!dloads.length) continue;
            const best = dloads.find(u => /\/720\//.test(u)) || dloads.find(u => /\/480\//.test(u)) || dloads[dloads.length - 1];
            const buf = await fetchCapped('https://www.eporner.com' + best);
            if (buf.length < 300 * 1024) continue;
            const id = temp.saveFile(buf, '.mp4');
            VIDEO_RECENT.push('ep:' + v.id); if (VIDEO_RECENT.length > 15) VIDEO_RECENT.shift();
            return { mediaUrl: baseUrl + '/temp/' + id + '.mp4', title: String(v.title || 'eporner video').slice(0, 120), mimetype: 'video/mp4', kind: 'video', sizeBytes: buf.length };
        } catch (e) { /* next video */ }
    }
    throw new Error('eporner: no downloadable mp4 for "' + query + '"');
}

async function xhVideo(query, baseUrl) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const s = await axios.get('https://www.xhamster.com/search?keyword=' + encodeURIComponent(query),
        { timeout: 20000, headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    const pages = [...new Set(String(s.data).match(/https?:\/\/[^"'\s<>\\]*xhamster\.com\/videos\/[^"'\s<>\\]*?-\d+/g) || [])]
        .filter(u => !VIDEO_RECENT.includes(u));
    if (!pages.length) throw new Error('xhamster: 0 fresh video pages for "' + query + '"');
    /* v2.8.1 SLUG RELEVANCE: search pages embed sidebar/related junk —
     * live proof: "twerking" queries returned a sidebar clip called
     * "youtuber-13854986". Prefer pages whose slug carries query words. */
    const score = (u) => {
        const slug = String(u).toLowerCase();
        const hits = words.filter(w => slug.includes(w)).length;
        return words.length ? (hits > 0 ? 0 : 1) : 0;
    };
    pages.sort((a, b) => score(a) - score(b));
    const onTopic = pages.filter((u) => score(u) === 0);
    const ordered = onTopic.length ? onTopic : pages;
    for (const vp of ordered.slice(0, 4)) {
        try {
            const p = await axios.get(vp, { timeout: 20000, headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
            const html = String(p.data);
            const cands = [...new Set((html.match(/https?:\/\/[^"'\s\\]+?\.mp4[^"'\s\\]*/g) || [])
                .map(u => u.replace(/\\u002F/g, '/')).filter(u => /xhcdn/.test(u)))];
            if (!cands.length) continue;
            /* prefer explicit quality markers, then longer (higher-bitrate) urls */
            cands.sort((a, b) => {
                const q = u => (/720/.test(u) ? 2 : /480|540|640/.test(u) ? 1 : 0);
                return (q(b) - q(a)) || (b.length - a.length);
            });
            const title = ((html.match(/<title>([^<]+)<\/title>/) || [])[1] || '')
                .replace(/\s*[-|]\s*(xhamster\.com|xhamster|xnxx\.com|pornhub\.com)\s*$/i, '')
                || decodeURIComponent((vp.match(/videos\/([^.]+)/) || [])[1] || 'xhamster video').replace(/-/g, ' ');
            for (const cu of cands.slice(0, 4)) {
                try {
                    const buf = await fetchCapped(cu);
                    if (buf.length < 300 * 1024) continue;   /* skip preview-size fragments */
                    const id = temp.saveFile(buf, '.mp4');
                    VIDEO_RECENT.push(vp); if (VIDEO_RECENT.length > 15) VIDEO_RECENT.shift();
                    return { mediaUrl: baseUrl + '/temp/' + id + '.mp4', title: title.trim().slice(0, 120), mimetype: 'video/mp4', kind: 'video', sizeBytes: buf.length };
                } catch (e) { /* next candidate */ }
            }
        } catch (e) { /* next page */ }
    }
    throw new Error('xhamster: no downloadable mp4 for "' + query + '"');
}

module.exports = { ytSearch, ytDownload, xnxxVideo, xhVideo, epornerVideo, genericDownload, ytId, MAX_MB };
