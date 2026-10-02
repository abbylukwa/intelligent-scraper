const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    try {
        const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': userAgent,
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
            },
            timeout: 15000,
            maxRedirects: 5
        });
        
        return response.data;
    } catch (error) {
        console.error(`Failed to fetch ${url}:`, error.message);
        throw error;
    }
}

async function downloadImage(url) {
    try {
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
            timeout: 30000
        });
        
        const filename = crypto.createHash('md5').update(url).digest('hex') + '.jpg';
        const filepath = path.join(__dirname, 'temp', filename);
        
        const writer = fs.createWriteStream(filepath);
        response.data.pipe(writer);
        
        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve({
                path: filepath,
                filename: filename,
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
        let src = $(elem).attr('src') || $(elem).attr('data-src') || $(elem).attr('data-original') || $(elem).attr('data-lazy-src');

        if (src) {
            // Convert relative URLs to absolute
            if (src.startsWith('//')) {
                src = 'https:' + src;
            } else if (src.startsWith('/')) {
                src = new URL(baseUrl).origin + src;
            } else if (!src.startsWith('http')) {
                src = baseUrl + '/' + src;
            }

            // v2.4: junk filter — the old one only checked 'icon'/'logo'
            // substrings, so site banners, sprites, avatars, default
            // placeholders and 1px trackers all passed and the bot ended
            // up downloading a 5KB logo instead of the actual image.
            if (!isJunkImageUrl(src)) {
                images.push(src);
            }
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
const JUNK_URL_RE = /(logo|sprite|sprite|favicon|avatar|button|btn[_-]|\bads?[-_/.]|pixel|tracker|spacer|blank|loading|placeholder|default\.(png|jpg|gif)|emoji|smiley|profile[_-]?pic|captcha|recaptcha|badge|flag[_-]|rating|stars?[_-]|social|share[-_]|\/ads\/|\/ad\/|doubleclick|googletagmanager|google-analytics|\/icons?\/|\/sprites?\/|_icon|_logo|-icon|-logo|icon\.|logo\.)/i;
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
    fetchPage,
    downloadImage,
    extractImageUrls,
    isJunkImageUrl,
    extractDapiFileUrls,
    verifyLeadingImages,
    relevantGifs
};
