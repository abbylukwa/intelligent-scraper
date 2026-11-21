const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ─── v4.1 SSRF GUARD ─────────────────────────────────────────
 * Every user-supplied URL (my_links slots, /download, /album) passes
 * through here before any fetch. Blocks non-HTTP schemes and any
 * host that resolves to loopback / private / link-local ranges, so a
 * crafted slot can never probe Render's metadata endpoint, the
 * container's own /temp folder or the internal network. */
const BLOCKED_HOST_RE = /^(localhost$|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?::ffff:127\.)/i;
function safeUrl(u) {
    let parsed;
    try { parsed = new URL(String(u)); } catch (e) { throw new Error('invalid url'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('scheme not allowed: ' + parsed.protocol);
    }
    const host = (parsed.hostname || '').toLowerCase();
    if (BLOCKED_HOST_RE.test(host)) throw new Error('blocked host: ' + host);
    return parsed.href;
}

// User agents for rotation — an honest bot UA FIRST (some CDNs 403
// browser-style UAs); browser UAs follow for the sites that want them.
// downloadImage retries naturally via the album download loop.
const USER_AGENTS = [
    'BreadBotScraper/2.4 (media fetcher; contact: admin@breadbot.local)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

async function fetchPage(url) {
    return fetchHTMLHardened(url);
}

/* ─── v4.7 ANTI-BLOCK LADDER ──────────────────────────────────────────
 * The boss: "the sites are denying the boys." Diagnosis: Render's
 * datacenter IP range is PRE-FLAGGED by Cloudflare (tested from a clean
 * sandbox IP — identical code cleared every site). Modern workaround
 * ladder, every layer optional + graceful:
 *   L0  axios with cached CF-clearance cookies (fast path)
 *   L1  cycletls — Chrome TLS(JA3)+HTTP2 fingerprint impersonation
 *   L2  FlareSolverr sidecar (FLARESOLVERR_URL) — real Chrome solves
 *       the JS challenge; clearance cookies cached + replayed
 *   L2.5 the BOT's stealth Chrome (STEALTH_FETCH_URL → its
 *       /stealth-fetch endpoint) — yona-yethuu's "One moment, please"
 *       challenge needs a real browser; the bot already ships one
 *   L3  PROXY_URL (residential/mobile proxy) shifts the exit IP;
 *       applied to cycletls + FlareSolverr, axios is skipped first
 *       when a proxy is configured.
 * Nothing costs money until the owner sets PROXY_URL / FLARESOLVERR_URL.
 * cycletls missing? layer silently skips (scraper works as v4.6). */
const CHROME_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHROME_JA3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,4588-29-23-24,0';
const CHROME_H2  = '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p';
/* v4.7.1: challenge shells that LOOK like HTML but are interstitials
 * must never pass as a page — yona-yethuu served 11.9KB of
 * "setTimeout(window.location.reload, 5000)" shell and the old
 * signature list waved it through (that is how "404 most sites"
 * looked from the bot). Also reject transport junk (cycletls returns
 * Go error strings like "stream error: stream ID 1; PROTOCOL_ERROR"
 * as a 200 body). */
const BLOCKED_HTML_RE = /just a moment|one moment, please|cf-challenge|challenge-platform|__cf_chl|cf-browser-verification|attention required|access denied|checking your browser|perimeterx|px-captcha|queue-it\.net|window\.location\.reload\(\)|setTimeout\(function\(\)\{\s*window\.location\.reload|testcookie|ddos-guard|stream error:/i;

/* A page is only GOOD when the status is OK, no blocked signature,
 * and it carries a real payload (>300 chars). */
function goodPage(status, html){
    if (status >= 400) return false;
    const h = String(html || '');
    if (h.trim().length < 300) return false;
    return !looksBlocked(status, h);
}

let _cyclePromise = null;
let _cycleDead = false;
async function cycleClient(){
    if (_cycleDead || process.env.DISABLE_IMPERSONATION) return null;
    try {
        if (!_cyclePromise){
            const mod = require('cycletls');
            _cyclePromise = mod().catch((e) => { _cyclePromise = null; throw e; });
        }
        return await _cyclePromise;
    } catch (e) {
        _cycleDead = true;                       // never spam-retry a broken install
        console.error('ANTI-BLOCK: cycletls unavailable, ladder without L1:', e.message);
        return null;
    }
}

/* CF-clearance cookie cache per host — FlareSolverr wins it once, every
 * later axios/cycletls request to that host replays it (fast path L0). */
const CLEARANCE_TTL_MS = 6 * 60 * 60 * 1000;     // cf_clearance lives hours
const clearanceByHost = new Map();               // host -> { cookie, ua, at }
function storeClearance(host, cookies, ua){
    try {
        const jar = (cookies || []).map(c => `${c.name}=${c.value}`).filter(s => !s.endsWith('='));
        if (!jar.length) return;
        clearanceByHost.set(String(host).toLowerCase(), {
            cookie: jar.join('; '), ua: ua || CHROME_UA, at: Date.now()
        });
        if (clearanceByHost.size > 60){          // bound the cache
            const k = clearanceByHost.keys().next().value;
            clearanceByHost.delete(k);
        }
    } catch (_e) { /* never break a fetch over cookie bookkeeping */ }
}
function clearanceFor(host){
    const c = clearanceByHost.get(String(host || '').toLowerCase());
    if (!c || Date.now() - c.at > CLEARANCE_TTL_MS) return null;
    return c;
}

function looksBlocked(status, html){
    if (status === 403 || status === 429 || status === 503) return true;
    return BLOCKED_HTML_RE.test(String(html || '').slice(0, 6000));
}

async function fetchViaCycleTLS(url, extraHeaders = {}){
    const client = await cycleClient();
    if (!client) throw new Error('impersonation unavailable');
    const u = new URL(url);
    const clear = clearanceFor(u.host);
    const ua = (clear && clear.ua) || CHROME_UA;
    const resp = await client(url, {
        ja3: CHROME_JA3,
        http2Fingerprint: CHROME_H2,
        userAgent: ua,
        headerOrder: ['host','connection','user-agent','accept','accept-language','accept-encoding','sec-ch-ua','sec-ch-ua-mobile','sec-ch-ua-platform','sec-fetch-dest','sec-fetch-mode','sec-fetch-site','sec-fetch-user','upgrade-insecure-requests','cookie','referer'],
        headers: Object.assign({
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'none',
            'sec-fetch-user': '?1',
            'upgrade-insecure-requests': '1'
        }, (clear && clear.cookie) ? { 'cookie': clear.cookie } : {}, extraHeaders),
        timeout: 25,
        ...(process.env.PROXY_URL ? { proxy: process.env.PROXY_URL } : {})
    }, 'get');
    const html = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
    return { status: resp.status, html };
}

/* L2.5 — the bot's stealth Chrome. Same trust model as the owner's
 * /admin routes (URL kept private) with an optional shared secret
 * (STEALTH_FETCH_TOKEN here ↔ STEALTH_TOKEN on the bot). */
async function fetchViaStealthService(url){
    /* v4.7.4: DEFAULT = the bot's /stealth-fetch endpoint — the bot is
     * our own service and its stealth Chrome already solves the
     * yona-yethuu challenge live (148KB real HTML). STEALTH_FETCH_URL
     * overrides; STEALTH_FETCH_TOKEN pairs with STEALTH_TOKEN on the
     * bot when the owner wants the shared secret on. TWO attempts:
     * the first pass may lose the challenge-round race from a cold
     * browser; the second rides a warm one with the clearance cookie. */
    const base = process.env.STEALTH_FETCH_URL || 'https://whatsapp-qr-app-1.onrender.com/stealth-fetch';
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++){
        try {
            const r = await axios.post(String(base).replace(/\/+$/, ''), {
                url: url
            }, {
                timeout: 150000,
                validateStatus: () => true,
                ...(process.env.STEALTH_FETCH_TOKEN ? { headers: { 'x-bb-token': process.env.STEALTH_FETCH_TOKEN } } : {})
            });
            const body = r.data || {};
            if (!body.ok || typeof body.html !== 'string'){
                throw new Error('stealth service failed: ' + (body.error || ('http ' + r.status)));
            }
            return { status: 200, html: body.html };
        } catch (e) { lastErr = e; }
    }
    throw (lastErr || new Error('stealth service failed'));
}

async function fetchViaFlareSolverr(url){
    const base = process.env.FLARESOLVERR_URL;
    if (!base) throw new Error('flaresolverr not configured');
    const r = await axios.post(String(base).replace(/\/+$/, '') + '/v1', {
        cmd: 'request.get',
        url: url,
        maxTimeout: 60000,
        ...(process.env.PROXY_URL ? { proxy: { url: process.env.PROXY_URL } } : {})
    }, { timeout: 75000, validateStatus: () => true });
    const sol = r.data && r.data.solution;
    if (!sol || typeof sol.response !== 'string'){
        throw new Error('flaresolverr failed: ' + ((r.data && (r.data.message || r.data.status)) || ('http ' + r.status)));
    }
    try { storeClearance(new URL(url).host, sol.cookies || [], sol.userAgent); } catch (_e) {}
    return { status: sol.status || 200, html: sol.response };
}

/* THE LADDER. Returns the HTML string or throws with a layer report. */
async function fetchHTMLHardened(url) {
    url = safeUrl(url);
    const report = [];
    const useProxy = !!process.env.PROXY_URL;

    /* L3 shift: with a proxy configured the direct axios call from the
     * flagged Render IP is wasted time — impersonation through the
     * proxy goes first. */
    if (useProxy){
        try {
            const r = await fetchViaCycleTLS(url);
            if (goodPage(r.status, r.html)) return r.html;
            report.push('cycletls ' + r.status);
        } catch (e) { report.push('cycletls ' + e.message); }
        try {
            const r = await fetchViaFlareSolverr(url);
            if (goodPage(r.status, r.html)) return r.html;
            report.push('flare ' + r.status);
        } catch (e) { report.push('flare ' + e.message); }
        try {
            const r = await fetchViaStealthService(url);
            if (goodPage(r.status, r.html)) return r.html;
            report.push('stealth ' + r.status);
        } catch (e) { report.push('stealth ' + e.message); }
    }

    /* L0 — axios fast path (with any cached clearance cookie). */
    try {
        const u = new URL(url);
        const clear = clearanceFor(u.host);
        const response = await axios.get(url, {
            headers: Object.assign({
                'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'max-age=0'
            }, (clear && clear.cookie) ? { 'Cookie': clear.cookie } : {}),
            timeout: 15000,
            maxRedirects: 5,
            maxContentLength: 25 * 1024 * 1024,   // v4.1: cap HTML pages at 25MB
            validateStatus: () => true
        });
        const html = typeof response.data === 'string' ? response.data : '';
        if (goodPage(response.status, html)) return html;
        report.push('axios ' + response.status);
    } catch (error) { report.push('axios ' + error.message); }

    /* L1 — Chrome TLS/HTTP2 fingerprint. */
    try {
        const r = await fetchViaCycleTLS(url);
        if (goodPage(r.status, r.html)) return r.html;
        report.push('cycletls ' + r.status);
    } catch (e) { report.push('cycletls ' + e.message); }

    /* L2 — real Chrome challenge solve (only when configured). */
    try {
        const r = await fetchViaFlareSolverr(url);
        if (goodPage(r.status, r.html)) return r.html;
        report.push('flare ' + r.status);
    } catch (e) { report.push('flare ' + e.message); }

    /* L2.5 — the bot's stealth Chrome (yona-yethuu class). */
    try {
        const r = await fetchViaStealthService(url);
        if (goodPage(r.status, r.html)) return r.html;
        report.push('stealth ' + r.status);
    } catch (e) { report.push('stealth ' + e.message); }

    const err = new Error('all fetch layers blocked — ' + report.join(' | '));
    err.layers = report;
    throw err;
}

const EXT_BY_MIME = {
    'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
    'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp',
    'image/avif': '.avif'
};

async function downloadImage(url) {
    try {
        url = safeUrl(url);                       // v4.1 SSRF guard
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            headers: {
                'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                'Referer': new URL(url).origin
            },
            // FIX: was timeout: 13200000 (3.6 hours!) — downloads hung for hours
            // before. 30s is enough for a single image.
            timeout: 30000,
            maxContentLength: 40 * 1024 * 1024    // v4.1: never pull >40MB "images"
        });
        
        // v4.1 FIX: was hardcoded '.jpg' — a PNG/GIF saved as .jpg broke
        // WhatsApp preview MIME and /album/:id/next downloads. Derive the
        // extension from Content-Type, falling back to the URL, then .jpg.
        const ctype = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        let ext = EXT_BY_MIME[ctype];
        if (!ext) {
            const m = /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.exec(url);
            ext = m ? ('.' + m[1].toLowerCase().replace('jpeg', 'jpg')) : '.jpg';
        }
        const filename = crypto.createHash('md5').update(url).digest('hex') + ext;
        const filepath = path.join(__dirname, 'temp', filename);
        
        const writer = fs.createWriteStream(filepath);
        response.data.pipe(writer);
        
        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve({
                path: filepath,
                filename: filename,
                ext: ext,
                url: url,
                size: fs.statSync(filepath).size
            }));
            writer.on('error', reject);
        });
    } catch (error) {
        console.error(`Failed to download image ${url}:`, error.message);
        return null;
    }
}

function extractImageUrls(html, baseUrl) {
    const $ = require('cheerio').load(html);
    const images = [];

    $('img').each((i, elem) => {
        /* v4.5 LAZY-LOAD FIX: pornpics (and most gallery sites) ship
         * <img src="…/1px.png" data-src="full.jpg"> — the OLD priority
         * took src FIRST, so every gallery image collapsed to the same
         * 1px spacer and the whole pornpics slot contributed NOTHING.
         * Now the first candidate that passes the junk gate wins:
         * lazy attrs (which hold the real file) beat src. */
        const cands = [$(elem).attr('data-src'), $(elem).attr('data-original'),
                       $(elem).attr('data-lazy-src'), $(elem).attr('src')];
        for (const raw of cands){
            if (!raw) continue;
            let src = raw;
            // Convert relative URLs to absolute
            if (src.startsWith('//')) {
                src = 'https:' + src;
            } else if (src.startsWith('/')) {
                src = new URL(baseUrl).origin + src;
            } else if (!src.startsWith('http')) {
                src = baseUrl + '/' + src;
            }
            // v2.4 junk gate; v4.5 also kills 1px/style spacer URLs
            if (!isJunkImageUrl(src)) { images.push(src); break; }
        }
    });

    return [...new Set(images)]; // Remove duplicates
}

/* ─── v2.4: real-image quality gate ─────────────────────────────
 * Kills the "scraper downloads the logo" class of failures at the
 * URL level: sprites, avatars, icons, buttons, banners, ads, place-
 * holders, trackers, base64 blobs, svg chrome and extension-less
 * mystery links are all rejected. Anything not matching a known
 * image extension must come from a recognised image CDN to pass. */
const JUNK_URL_RE = /(logo|sprite|favicon|avatar|ava_(male|female|gen)|button|btn[_-]|\bads?[-_/.]|pixel|tracker|spacer|blank|loading|placeholder|default\.(png|jpg|gif)|emoji|smiley|profile[_-]?pic|captcha|recaptcha|badge|flag[_-]|\/flag|ico_|rating|stars?[_-]|social|share[-_]|\/ads\/|\/ad\/|doubleclick|googletagmanager|google-analytics|\/icons?\/|\/sprites?\/|_icon|_logo|-icon|-logo|icon\.|logo\.|1px\.png|\/style\/img\/)/i;
const IMG_EXT_RE  = /\.(png|jpe?g|webp|gif)(\?|#|$)/i;

function isJunkImageUrl(u) {
    if (!u || typeof u !== 'string') return true;
    if (u.startsWith('data:')) return true;
    if (/\.svg(\?|#|$)/i.test(u)) return true;               // chrome graphics
    if (JUNK_URL_RE.test(u)) return true;
    /* no image extension → not worth downloading (v3.0: no site
     * allowlist anymore — every slot URL is owner-supplied) */
    if (!IMG_EXT_RE.test(u)) return true;
    /* tiny-size query hints (w=32, 16x16, 50px…) */
    if (/[?&](w|width|size)=(1[0-9]?|[2-9][0-9]|[12][0-9]{2})\b/i.test(u) && !/[?&](w|width)=(6|7|8|9)[0-9]{2,}/i.test(u)) {
        const m = /[?&](w|width|size)=(\d+)/i.exec(u);
        if (m && parseInt(m[2], 10) < 260) return true;
    }
    if (/-([0-9]{1,2})x([0-9]{1,2})\.(png|jpe?g|webp)/i.test(u)) return true;  // -32x32 sprite thumbs
    return false;
}

/* ─── DAPI XML file_url extractor (generic — any Gelbooru-family API) ──
 * Gelbooru-family dapi endpoints answer static XML with FULL-RES
 * originals in file_url="…" attributes. No <img> tags exist, so the
 * cheerio extractor finds nothing — this regex does. Works with any
 * dapi endpoint your slots point at.                                */
function extractDapiFileUrls(text){
    const out = [];
    const re = /file_url="([^"]+\.(?:jpe?g|png|gif|webp)(?:\?[^"]*)?)"/gi;
    let m;
    while ((m = re.exec(String(text))) !== null){
        if (!isJunkImageUrl(m[1])) out.push(m[1]);
        if (out.length >= 40) break;
    }
    return out;
}

/* ─── LEAD-RESULT VERIFIER — never let the bot lead with a dead image ──
 * The bot downloads images[0]. Listings can contain deleted posts, so
 * the first URL can 404 while 100+ live images sit right behind it.
 * This probes the first few candidates in parallel with a 1KB ranged
 * GET + proper Referer and floats the first ALIVE one to the front.
 * Nothing is reordered when every probe fails. */
function refererFor(url){
    try { const h = new URL(url).hostname; return 'https://' + h + '/'; } catch (e) { return undefined; }
}
function probeAlive(url, timeoutMs = 5000){
    return new Promise((resolve) => {
        try {
            const u = new URL(url);
            const lib = u.protocol === 'http:' ? require('http') : require('https');
            const rq = lib.request({
                hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
                path: u.pathname + u.search, method: 'GET', timeout: timeoutMs,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.37',
                    'Referer': refererFor(url),
                    'Range': 'bytes=0-1023'
                }
            }, (res) => {
                let n = 0;
                res.on('data', (c) => { n += c.length; if (n > 2048) rq.destroy(); });
                res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300 && n > 0));
                res.on('error', () => resolve(false));
            });
            rq.on('timeout', () => { rq.destroy(); resolve(false); });
            rq.on('error', () => resolve(false));
            rq.end();
        } catch (e) { resolve(false); }
    });
}
async function verifyLeadingImages(urls, count = 4){
    const list = (urls || []).filter(Boolean);
    if (list.length < 2) return list;
    /* v2.8: WALK batches until the first ALIVE url is found — some
     * slots return PAIRS (.jpeg+.png of the same post), so one deleted
     * post can eat the whole first batch. Probe 4 at a time,
     * up to 8 candidates total, ~2s per batch. */
    for (let start = 0; start < Math.min(8, list.length); start += count) {
        const head = list.slice(start, start + count);
        const verdicts = await Promise.all(head.map((u) => probeAlive(u)));
        const idx = verdicts.indexOf(true);
        if (idx !== -1) {
            const winner = head[idx];
            if (start === 0 && idx === 0) return list;   /* leader already alive */
            return [winner, ...list.filter((u) => u !== winner)];
        }
    }
    return list;   /* nothing verified — leave order untouched */
}

/* ─── GIF RELEVANCE — kills the "wrong gif" class of failures ──
 * Media pages embed EVERY gif on the page: the real search results
 * AND the related/trending sections, often the same gif in several
 * size variants. Generic (site-agnostic) filter:
 *   1. dedupes by media id: the second path segment of the URL
 *   2. ranks by SLUG: a gif whose URL contains a query word leads;
 *      off-topic slugs only survive when on-topic results are few. */
function relevantGifs(urls, query){
    const words = String(query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const seen = new Set();
    const onTopic = [], offTopic = [];
    for (const raw of (urls || [])) {
        const u = String(raw);
        const segs = u.split(/[\/?]/).filter(Boolean);
        const id = (segs.slice(-2)[0] || u).toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        const s = u.toLowerCase();
        const topic = words.length > 0 && words.some(w => s.includes(w));
        (topic ? onTopic : offTopic).push(u);
    }
    const keep = onTopic.length >= 6 ? onTopic : onTopic.concat(offTopic);
    return keep.slice(0, 30);
}

module.exports = {
    safeUrl,
    fetchPage,
    fetchHTMLHardened,
    fetchViaCycleTLS,
    fetchViaFlareSolverr,
    fetchViaStealthService,
    looksBlocked,
    goodPage,
    storeClearance,
    clearanceFor,
    CHROME_UA,
    downloadImage,
    extractImageUrls,
    isJunkImageUrl,
    extractDapiFileUrls,
    verifyLeadingImages,
    relevantGifs
};
