'use strict';

/* ============================================================
 *  media.js — /music, /video, /download backing for BreadBot
 *
 *  v3.0 — ZERO BUILT-IN SOURCES (owner request: every link removed):
 *  - The old online resolver stack is GONE — no instance lists anywhere.
 *  - The built-in NSFW video chain is GONE — no site code anywhere.
 *  - /video and /music are driven EXCLUSIVELY by the slots the
 *    owner configures (my_links.json / MYLINKS env / per-request):
 *      type:'video'  search pages -> direct .mp4/.webm links AND
 *                    video-page links (each page opened, its mp4
 *                    candidates pulled, quality-ranked)
 *      type:'music'  search pages -> direct .mp3/.m4a/.ogg/.wav links
 *  - What remains is generic DOWNLOAD machinery: capped fetch with
 *    UA/Referer fallback, direct-URL /download, and the two slot
 *    engines above. SCRAPER_MAX_MB caps every download (default
 *    40MB — 34MB videos download fine).
 *  - Storage: reuses temp.saveFile() so the 1h auto-cleanup applies.
 * ============================================================ */

const axios = require('axios');
const temp = require('./temp');

const MAX_MB = Math.max(1, parseInt(process.env.SCRAPER_MAX_MB || '40', 10));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ── Capped download of a direct media URL (shared by everything) ── */
async function fetchCapped(url) {
    const cap = MAX_MB * 1024 * 1024;
    const r = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: cap + 1,
        maxBodyLength: cap + 1,
        validateStatus: s => s >= 200 && s < 400,
        headers: { 'User-Agent': UA }
    });
    const buf = Buffer.from(r.data);
    if (!buf.length) throw new Error('Downloaded file is empty');
    if (buf.length > cap) throw new Error(`Media exceeds ${MAX_MB}MB cap`);
    return buf;
}

/* ── Generic direct-URL download (any media the caller points at) ──
 * UA fallback chain: some CDNs 403 browser-style UAs and REQUIRE an
 * honest bot UA, while most other sites are the opposite. Try one, on
 * 403/429 retry with the other. Referer fallback: hotlink-protected
 * CDNs reject ANY request without a same-site Referer — we try: plain
 * bot UA → plain browser UA → browser UA + same-origin Referer.      */
const FETCH_UAS = [
    'BreadBotScraper/3.0 (media fetcher; contact: admin@breadbot.local)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
];
function refererCandidates(u, extra){
    const out = [];
    for (const e of (Array.isArray(extra) ? extra : [])){
        try { const eu = new URL(e); out.push(eu.protocol + '//' + eu.hostname + '/'); } catch (err) {}
    }
    try {
        const pu = new URL(u);
        out.push(pu.protocol + '//' + pu.hostname + '/');   /* same-origin — the common case */
    } catch (e) {}
    return [...new Set(out)];
}
const RETRY_STATUSES = new Set([403, 404, 418, 429]);   /* 404: some CDNs fake-404 without referer */
const BLOCKED_CT_RE = /text\/html|application\/json|text\/plain/i;
function respLen(r){ try { return r.data ? (r.data.byteLength ?? r.data.length ?? 0) : 0; } catch (e) { return 0; } }
async function fetchWithUaFallback(url, opts, extraReferers) {
    let lastErr = null;
    const attempts = [];
    attempts.push({ ua: FETCH_UAS[0], referer: null });   /* honest bot UA first */
    attempts.push({ ua: FETCH_UAS[1], referer: null });   /* plain browser UA */
    for (const ref of refererCandidates(url, extraReferers)){
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
            /* BLOCKED-PAGE GATE: a 200 that answers a tiny HTML/JSON
             * body is a hotlink block page, NOT the media. Treat it as
             * a refusal and fall through to the next UA+Referer attempt. */
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

/* ══════════════════════════════════════════════════════════════
 *  v3.0 GENERIC SLOT ENGINES — video & music from YOUR slots.
 *  server.js resolves each slot's search URL (template/{query},
 *  bare page or .json) and hands us [{ name, url }] — we scrape
 *  media links out of the pages and download the best candidate.
 *  No site names, no per-site logic: pure pattern extraction. ═══ */

/* recently served video pages (shared across slots) — so consecutive
 * queries return DIFFERENT clips ("different query different video") */
const VIDEO_RECENT = [];
const MUSIC_RECENT = [];

/* v2.8.2 carry-over: honour the bot's exclude list (already-sent
 * TITLES) — a candidate whose slug contains an excluded title is a
 * repeat and gets skipped. */
function makeTitleExcluder(exclude) {
    const excl = (Array.isArray(exclude) ? exclude : [])
        .map(x => String(x).toLowerCase().trim()).filter(Boolean);
    return (title) => {
        const t = String(title || '').toLowerCase();
        if (!t || !excl.length) return false;
        return excl.some(x => t.includes(x));
    };
}

/* Generic slug title from a URL: last meaningful path segment,
 * extension stripped, dashes/underscores → spaces. */
function slugTitleOf(url) {
    try {
        const pu = new URL(url);
        const segs = pu.pathname.split('/').filter(Boolean);
        const last = (segs[segs.length - 1] || '').replace(/\.[a-z0-9]{2,5}$/i, '');
        return decodeURIComponent(last || pu.hostname).replace(/[-_]+/g, ' ').trim().slice(0, 120);
    } catch (e) { return ''; }
}

/* query-vs-URL relevance: candidates carrying query words rank first */
function relevanceScore(url, words) {
    if (!words.length) return 0;
    const s = String(url).toLowerCase();
    return words.some(w => s.includes(w)) ? 0 : 1;
}
function qualityScore(u) {
    return (/720/.test(u) ? 3 : /480|540|640/.test(u) ? 2 : /360/.test(u) ? 1 : 0);
}

const VIDEO_URL_RE  = /https?:\/\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*/gi;
const VIDEO_URL2_RE = /https?:\/\/[^\s"'<>\\]+\.webm[^\s"'<>\\]*/gi;
/* generic video-page link: same host, path hints at a watch page */
const VIDEO_PAGE_HINT = /(video|watch|clip|embed|play|media|movie)/i;
/* v4.0: site NAV pages — they match the hint (best-videos, playlists,
 * search…) but are listing pages, not watch pages; their player configs
 * point at the site root or at other listings. Exclude them so real
 * watch pages get the page budget. */
const NAV_PAGE_RE = /\/(search|playlists?|embed|best|top|new|creators?|categories?|tags?|channels?|users?|profile|login|signup|register|hide_viewed)[a-z0-9_-]*(\/|$)/i;
/* v4.0: CDN preview-loop junk — search pages embed tiny 5s mp4 previews
 * (thumb CDNs); they download "fine" but are not the real video. */
const VIDEO_JUNK_RE = /preview|thumb|trailer|teaser|sample/i;
const MUSIC_URL_RE = /https?:\/\/[^\s"'<>\\]+\.(?:mp3|m4a|ogg|wav|aac)(?:\?[^\s"'<>\\]*)?/gi;

/* ── v4.0 PLAYER EXTRACTOR — video URLs that live in JS player configs
 * rather than plain <a>/<video> markup. These patterns are generic
 * (no hostnames): html5player (setVideoUrlHigh/Low), JSON-LD
 * contentUrl, KVS flashvars (video_url), HTML5 <source>/<video> tags
 * and generic src:/"file": script slots. Between them they cover the
 * player styles every major tube backend ships, so ANY slot in
 * my_links.json gets real files — not only sites with static mp4s. */
const PLAYER_URL_RES = [
    /setVideoUrl(?:High|Low)\(\s*'(https?:[^']+?)'/gi,
    /"contentUrl"\s*:\s*"(https?:[^"]+?\.(?:mp4|webm)[^"]*)"/gi,
    /video_url['"]?\s*[:=]\s*['"]([^'"]+?\.(?:mp4|webm)[^'"]*)['"]/gi,
    /<source[^>]+src=["'](https?:[^"']+?\.(?:mp4|webm)[^"']*)["']/gi,
    /<video[^>]+src=["'](https?:[^"']+?\.(?:mp4|webm)[^"']*)["']/gi,
    /["']?file["']?\s*:\s*["'](https?:[^"']+?\.(?:mp4|webm)[^"']*)["']/gi,
    /src\s*:\s*'(https?:[^']+?\.(?:mp4|webm)[^']*)'/gi
];
function extractPlayerVideos(html) {
    const out = [];
    const s = String(html || '');
    for (const re of PLAYER_URL_RES) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(s))){
            /* KVS flashvars sometimes prefix the real url ("function/0/https://…")
             * — recover the actual https url from the captured text. */
            const u = String(m[1]).replace(/^.*?(https?:\/\+)/, '$1')
                .replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
            if (/^https?:\/\/.+/i.test(u)) out.push(u);
        }
        if (out.length >= 8) break;   // enough signals from one page
    }
    return [...new Set(out)];
}

function extractDirectVideos(html) {
    const out = [];
    for (const re of [VIDEO_URL_RE, VIDEO_URL2_RE]) {
        const m = String(html).match(re) || [];
        for (const u of m) out.push(u.replace(/\\u002F/gi, '/').replace(/&amp;/g, '&'));
    }
    return [...new Set(out)].filter(u => !VIDEO_JUNK_RE.test(u));
}
function extractVideoPages(html, baseUrl) {
    try {
        const host = new URL(baseUrl).hostname.replace(/^www\./, '');
        const seen = new Set();
        const hits = [];
        const push = (u) => {
            try {
                const pu = new URL(u.replace(/&amp;/g, '&'), baseUrl);
                if (pu.protocol !== 'http:' && pu.protocol !== 'https:') return;
                if (!pu.hostname.replace(/^www\./, '').endsWith(host)) return;
                if (!VIDEO_PAGE_HINT.test(pu.pathname)) return;
                if (NAV_PAGE_RE.test(pu.pathname)) return;
                if (/\.(jpe?g|png|gif|webp|css|js|ico)(\?|$)/i.test(pu.pathname)) return;
                const abs = pu.href.split('#')[0];
                if (!seen.has(abs)){ seen.add(abs); hits.push(abs); }
            } catch (e) { /* bad url */ }
        };
        /* absolute urls anywhere in the page */
        for (const u of (String(html).match(/https?:\/\/[^\s"'<>\\]+/gi) || [])) push(u);
        /* v4.0: RELATIVE links — search pages mostly link /video-xxx/…
         * (tube search pages) and the old absolute-only harvester never saw them. */
        const relRe = /(?:href|src)=["']([^"'#]+)["']/gi;
        let m;
        while ((m = relRe.exec(String(html)))){
            if (/^(https?:)?\/\//i.test(m[1])) continue;   // already covered above
            push(m[1]);
        }
        return hits;
    } catch (e) { return []; }
}

async function downloadVideoCandidate(cu, ext, refererHint) {
    /* v4.0: video CDNs are the MOST hotlink-protected media there is —
     * route video downloads through the UA+Referer fallback chain (the
     * page that produced the url is the best Referer hint), then fall
     * back to the plain capped fetch like before. */
    const cap = MAX_MB * 1024 * 1024;
    let buf = null;
    try {
        const r = await fetchWithUaFallback(cu, {
            responseType: 'arraybuffer',
            timeout: 120000,
            maxContentLength: cap + 1,
            maxBodyLength: cap + 1,
            validateStatus: s => s >= 200 && s < 400
        }, refererHint ? [refererHint] : []);
        buf = Buffer.from(r.data);
    } catch (e) {
        buf = await fetchCapped(cu);   /* old behavior as the last resort */
    }
    if (buf.length < 300 * 1024) throw new Error('fragment too small (' + (buf.length / 1024).toFixed(0) + 'KB)');
    const id = temp.saveFile(buf, ext);
    return { buf, id, ext };
}

/* ── VIDEO from your slots ───────────────────────────────────────
 * For every slot URL: fetch the page → collect direct .mp4/.webm
 * links AND same-host video-page links → open up to 4 pages per slot
 * for their mp4 candidates → rank (on-topic slug, quality marker,
 * freshness) → download the first that yields a real file >300KB
 * under the SCRAPER_MAX_MB cap → serve from /temp.                  */
async function myLinksVideo(slots, query, baseUrl, opts = {}) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const titleExcluded = makeTitleExcluder(opts.exclude);
    const diag = opts.diag || {};
    const errors = [];

    for (const slot of (slots || [])) {
        const slotName = slot.name || slot.url;
        try {
            const s = await axios.get(slot.url, {
                timeout: 20000,
                headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
            });
            let cands = extractDirectVideos(s.data);
            const hintOf = new Map();         /* v4.0: url -> best Referer hint */
            for (const u of cands) hintOf.set(u, slot.url);
            let strong = new Set();          /* v4.0: player-config urls rank first */
            let pageHits = [];
            /* no direct mp4s on the search page → open video-page links */
            if (!cands.length) {
                pageHits = extractVideoPages(s.data, slot.url)
                    .filter(u => !VIDEO_RECENT.includes(u))
                    .sort((a, b) => relevanceScore(a, words) - relevanceScore(b, words))
                    .slice(0, 6);
                for (const vp of pageHits) {
                    try {
                        const p = await axios.get(vp, {
                            timeout: 20000,
                            headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
                        });
                        /* v4.0: player-config urls first (real files), markup mp4s second */
                        const pv = extractPlayerVideos(p.data);
                        pv.forEach(u => { strong.add(u); hintOf.set(u, vp); });
                        const dv = extractDirectVideos(p.data);
                        dv.forEach(u => hintOf.set(u, vp));
                        cands.push(...pv, ...dv);
                    } catch (e) { /* next page */ }
                }
            }
            /* rank: player-config urls first, then on-topic, quality, length */
            cands = [...new Set(cands)]
                .filter(u => !titleExcluded(slugTitleOf(u)))
                .sort((a, b) =>
                    ((strong.has(b) ? 1 : 0) - (strong.has(a) ? 1 : 0)) ||
                    (relevanceScore(a, words) - relevanceScore(b, words)) ||
                    (qualityScore(b) - qualityScore(a)) ||
                    (b.length - a.length));
            if (!cands.length) {
                diag[slotName] = 0;
                errors.push(slotName + ': 0 video links');
                continue;
            }
            for (const cu of cands.slice(0, 6)) {
                const ext = /\.webm(\?|$)/i.test(cu) ? '.webm' : '.mp4';
                try {
                    const dl = await downloadVideoCandidate(cu, ext, hintOf.get(cu) || slot.url);
                    VIDEO_RECENT.push(cu); if (VIDEO_RECENT.length > 15) VIDEO_RECENT.shift();
                    diag[slotName] = cands.length;
                    console.log(`[video-slot] OK via "${slotName}": ${slugTitleOf(cu)} (${(dl.buf.length / 1048576).toFixed(1)}MB)`);
                    return {
                        mediaUrl: baseUrl + '/temp/' + dl.id + dl.ext,
                        title: (slugTitleOf(cu) || 'video'),
                        mimetype: ext === '.webm' ? 'video/webm' : 'video/mp4',
                        kind: 'video',
                        sizeBytes: dl.buf.length,
                        source: slotName
                    };
                } catch (e) { /* next candidate */ }
            }
            diag[slotName] = 0;
            errors.push(slotName + ': no downloadable file under the cap');
        } catch (e) {
            diag[slotName] = 0;
            errors.push(slotName + ': ' + e.message);
            console.log(`[video-slot] "${slotName}" skipped (${e.message})`);
        }
    }
    throw new Error('No video from your slots — ' + (errors.join(' | ') || 'no video slots configured'));
}

/* ── MUSIC from your slots ───────────────────────────────────────
 * For every slot URL: fetch the page → collect direct audio links →
 * rank on-topic → download the first real file (>100KB) → /temp.   */
async function myLinksMusic(slots, query, baseUrl, opts = {}) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const titleExcluded = makeTitleExcluder(opts.exclude);
    const diag = opts.diag || {};
    const errors = [];

    for (const slot of (slots || [])) {
        const slotName = slot.name || slot.url;
        try {
            const s = await axios.get(slot.url, {
                timeout: 20000,
                headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
            });
            let cands = [...new Set((String(s.data).match(MUSIC_URL_RE) || [])
                .map(u => u.replace(/&amp;/g, '&')))]
                .filter(u => !titleExcluded(slugTitleOf(u)))
                .sort((a, b) => relevanceScore(a, words) - relevanceScore(b, words));
            if (!cands.length) {
                diag[slotName] = 0;
                errors.push(slotName + ': 0 audio links');
                continue;
            }
            for (const cu of cands.slice(0, 5)) {
                try {
                    const buf = await fetchCapped(cu);
                    if (buf.length < 100 * 1024) continue;
                    const ext = (cu.match(/\.(mp3|m4a|ogg|wav|aac)(?:\?|$)/i) || [])[1] || '.mp3';
                    const id = temp.saveFile(buf, '.' + ext);
                    MUSIC_RECENT.push(cu); if (MUSIC_RECENT.length > 15) MUSIC_RECENT.shift();
                    diag[slotName] = cands.length;
                    console.log(`[music-slot] OK via "${slotName}": ${slugTitleOf(cu)} (${(buf.length / 1048576).toFixed(1)}MB)`);
                    return {
                        mediaUrl: baseUrl + '/temp/' + id + '.' + ext,
                        title: (slugTitleOf(cu) || 'audio'),
                        mimetype: ext === 'mp3' ? 'audio/mpeg' : 'audio/' + ext,
                        kind: 'audio',
                        sizeBytes: buf.length,
                        source: slotName
                    };
                } catch (e) { /* next candidate */ }
            }
            diag[slotName] = 0;
            errors.push(slotName + ': no downloadable audio');
        } catch (e) {
            diag[slotName] = 0;
            errors.push(slotName + ': ' + e.message);
            console.log(`[music-slot] "${slotName}" skipped (${e.message})`);
        }
    }
    throw new Error('No music from your slots — ' + (errors.join(' | ') || 'no music slots configured'));
}

module.exports = { genericDownload, myLinksVideo, myLinksMusic, fetchCapped, MAX_MB, extractPlayerVideos, extractDirectVideos, extractVideoPages, downloadVideoCandidate };
