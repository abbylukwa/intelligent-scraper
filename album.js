const utils = require('./utils');
const temp = require('./temp');
const pLimit = require('p-limit');

const ALBUM_MAP = {};

/* ══════════════════════════════════════════════════════════════
 *  v2.4 REAL IMAGE ENGINES — why "fish" returned a logo before
 *  The old searchImages() ignored the `site` argument and always
 *  hammered a fixed chain (darknaija blog → pornpics → reddit),
 *  grabbing whatever <img> tags sat on the page — usually the site
 *  LOGO. Now a real engine chain runs for every query, merged and
 *  junk-filtered:
 *    1. my_links boosts  (Bing "query site:your-domain" — finds the
 *       actual content images on YOUR sites even if they are
 *       JS-rendered, e.g. pngtree category pages)
 *    2. Bing Images      (general, any query — HTML murl parse)
 *    3. Flickr feed      (general photos, no API key)
 *    4. Wikimedia Commons(factual objects — real content images)
 *    5. Wikipedia pages  (topic lead images)
 *    6. Openclipart      (clipart/PNG, short timeout)
 *  NSFW queries keep the legacy chain (pornpics/reddit) — only ever
 *  used when the bot explicitly asks for nsfw.
 *  Every engine fails independently: one dead engine never breaks
 *  the search. Results are relevance-ranked (query word in URL
 *  first), deduped, junk-filtered and capped at 25. ═════════════ */
const ENGINE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const axios = require('axios');

/* v2.6 ADULT MODE: Bing ships SafeSearch ON for datacenter IPs — every
 * NSFW query came back empty, which is why the bot kept falling back to
 * random gifs. adlt=off (URL + cookie) disables it where the IP allows.
 * A regex fallback also catches murl when the HTML shape changes. */
async function bingImages(q, siteDomain){
    const query = siteDomain ? `${q} site:${siteDomain}` : q;
    const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1&adlt=off`;
    const r = await axios.get(url, { headers: {
        'User-Agent': ENGINE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': 'SRCHHPGUSR=SRCHLANG=en&ADLT=OFF'
    }, timeout: 15000 });
    const $ = require('cheerio').load(r.data);
    const out = [];
    $('a.iusc').each((i, el) => {
        try { const m = JSON.parse($(el).attr('m')); if (m && m.murl && !utils.isJunkImageUrl(m.murl)) out.push(m.murl); } catch (e) {}
    });
    if (!out.length) {
        const raw = String(r.data).match(/"murl":"(.*?)"/g) || [];
        for (const m of raw){
            try {
                const u = JSON.parse('"' + m.slice(8) + '"').replace(/\\u0026/g, '&').replace(/\\/g, '');
                if (u.startsWith('http') && !utils.isJunkImageUrl(u)) out.push(u);
            } catch (e) {}
        }
    }
    return out;
}

/* ═══ v2.6 NEW ENGINES — the adult-content workhorses ═══
 * Why: 5 of the 7 user slots returned 0 results (JS-walled / wrong
 * patterns / DC-blocked) and Bing SafeSearch hid NSFW — so image
 * searches degenerated into random gif fallbacks. These two booru
 * engines are STATIC HTML/XML, keyless, and return FULL-RES originals:
 *
 *  • xbooru (Gelbooru-style dapi XML): tags="ebony+ass" → file_url
 *    https://img.xbooru.com/images/... — direct, no conversion.
 *  • realbooru (REAL-porn booru, HTML browse): thumbnails convert to
 *    full via /thumbnails/XX/YY/thumbnail_HASH.jpg → /images/XX/YY/HASH.jpg
 *    (downloads need Referer: realbooru.com — media.js same-origin
 *    fallback already sends it).
 *  • reddit query JSON (best effort): old.reddit.com/search.json —
 *    datacenter IPs are often blocked, so it never breaks the chain. */

async function xbooruImages(q){
    const tags = String(q).trim().replace(/\s+/g, '+');
    const url = `https://xbooru.com/index.php?page=dapi&s=post&q=index&tags=${encodeURIComponent(tags).replace(/%2B/g, '+')}&limit=50`;
    const r = await axios.get(url, { headers: { 'User-Agent': ENGINE_UA }, timeout: 15000 });
    const out = [];
    const re = /file_url="([^"]+)"/g; let m;
    while ((m = re.exec(String(r.data))) !== null){
        if (!utils.isJunkImageUrl(m[1])) out.push(m[1]);
    }
    return out.slice(0, 40);
}

async function realbooruImages(q){
    /* v2.7 FIX: tags join with '+' (underscore made it ONE unknown tag →
     * 1 result) and the request must carry FULL browser headers — with
     * only UA+Referer realbooru serves a stripped page with no thumbs.
     * Verified: full-header fetch of tags=ebony+ass → 41 thumbs, 3/3 runs. */
    const tags = String(q).trim().replace(/\s+/g, '+');
    const url = `https://realbooru.com/index.php?page=post&s=list&tags=${encodeURIComponent(tags).replace(/%2B/g, '+')}`;
    const r = await utils.fetchPage(url);
    const thumbs = String(r).match(/https?:\/\/realbooru\.com\/thumbnails\/[0-9a-f]{2}\/[0-9a-f]{2}\/thumbnail_[0-9a-f]+\.(?:jpg|png|gif|jpeg)/gi) || [];
    const out = [];
    for (const t of thumbs){
        /* v2.7: shared converter — /thumbnails/XX/YY/thumbnail_HASH.ext
         * → /images/XX/YY/HASH.ext (download needs Referer: realbooru.com,
         * media.js same-origin fallback sends it). */
        for (const full of utils.booruFullUrls(t)){
            if (!utils.isJunkImageUrl(full)) out.push(full);
        }
        if (out.length >= 30) break;
    }
    return out;
}

async function redditQueryImages(q){
    const r = await axios.get('https://old.reddit.com/search.json', {
        params: { q: q, include_over_18: 'on', limit: 40, sort: 'relevance' },
        headers: { 'User-Agent': 'mozilla/5.0 breadbot-scraper/2.6' }, timeout: 15000 });
    const children = r.data?.data?.children || [];
    const out = [];
    for (const c of children){
        const d = c.data || {};
        const u = d.url_overridden_by_dest || '';
        if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(u)) out.push(u);
        const pv = d.preview?.images?.[0]?.source?.url || '';
        if (pv) out.push(pv.replace(/&amp;/g, '&'));
    }
    return [...new Set(out)].filter(u => !utils.isJunkImageUrl(u)).slice(0, 30);
}

async function flickrImages(q){
    const r = await axios.get('https://www.flickr.com/services/feeds/photos_public.gne', {
        params: { tags: q, format: 'json', tagmode: 'any', nojsoncallback: 1 },
        headers: { 'User-Agent': ENGINE_UA }, timeout: 15000 });
    const items = r.data && r.data.items || [];
    return items.map(x => x.media && x.media.m).filter(Boolean)
        .map(u => u.replace(/_m\.jpg$/, '_b.jpg'));   /* 500px → 1024px large when available */
}

async function commonsImages(q){
    const r = await axios.get('https://commons.wikimedia.org/w/api.php', {
        params: { action:'query', format:'json', generator:'search',
                  gsrsearch:`filetype:bitmap ${q}`, gsrlimit:15, gsrnamespace:6,
                  prop:'imageinfo', iiprop:'url|size', iiurlwidth:1024 },
        headers: { 'User-Agent': 'BreadBotScraper/2.4 (image search; contact: admin@breadbot.local)' },
        timeout: 15000 });
    const pages = r.data?.query?.pages || {};
    return Object.values(pages).map(p => p.imageinfo?.[0]?.thumburl).filter(Boolean);
}

async function wikipediaImages(q){
    const r = await axios.get('https://en.wikipedia.org/w/api.php', {
        params: { action:'query', format:'json', generator:'search', gsrsearch:q,
                  gsrlimit:8, gsrnamespace:0, prop:'pageimages',
                  piprop:'thumbnail', pithumbsize:1000 },
        headers: { 'User-Agent': 'BreadBotScraper/2.4 (image search; contact: admin@breadbot.local)' },
        timeout: 15000 });
    const pages = r.data?.query?.pages || {};
    return Object.values(pages).map(p => p.thumbnail && p.thumbnail.source).filter(Boolean);
}

async function openclipartImages(q){
    const r = await axios.get('https://openclipart.org/search/?query=' + encodeURIComponent(q),
        { headers: { 'User-Agent': ENGINE_UA }, timeout: 12000 });
    const urls = String(r.data).match(/https?:\/\/[^"'\s<>]+\/download\/[^"'\s<>]+/g) || [];
    return urls;
}

function relevantFirst(urls, q){
    const words = String(q).toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const score = u => {
        const s = String(u).toLowerCase();
        return words.some(w => s.includes(w)) ? 0 : 1;
    };
    return [...urls].sort((a, b) => score(a) - score(b));
}

async function runEngines(list, diag){
    /* v2.6.1 PRIORITY ORDER: results are bucketed PER ENGINE and merged
     * in the engine array's order — NOT in network completion order.
     * (The bot downloads images[0]; before this fix whichever engine's
     * HTTP finished first — often Flickr SFW photos — led the list
     * ahead of the actual NSFW results.) */
    const buckets = new Array(list.length).fill(null);
    await Promise.all(list.map(async (e, i) => {
        try {
            const urls = await e.f();
            const clean = (urls || []).filter(u => !utils.isJunkImageUrl(u));
            buckets[i] = clean;
            if (diag) diag[e.n] = clean.length;
        } catch (err) {
            buckets[i] = [];
            if (diag) diag[e.n] = 0;
            console.error('[engine] ' + (e.n || '?') + ' failed:', err.message);
        }
    }));
    /* v2.7 ROUND-ROBIN MERGE: plain bucket concat let xbooru (40 hits)
     * fill the whole 40-cap so realbooru never surfaced. Interleave one
     * result per engine per round (engine order = priority order) so
     * your slots lead AND the boorus MIX in the head of the list. */
    const found = [];
    const idx = new Array(list.length).fill(0);
    let added = true;
    while (found.length < 500 && added) {
        added = false;
        for (let i = 0; i < list.length; i++) {
            const b = buckets[i];
            if (b && idx[i] < b.length) { found.push(b[idx[i]++]); added = true; }
        }
    }
    return found;
}

async function searchImages(query, site = 'auto', opts = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const nsfw = !!(opts && opts.nsfw);
    const boostDomains = (opts && opts.boostDomains) || [];

    /* ── explicit legacy site (bot sends 'darknaija' etc.) ── */
    const LEGACY = {
        darknaija:    { url: `https://darknaija.com/?s=${encodeURIComponent(q)}`, extractor: extractDarkNaijaImages },
        imagefaqs:    { url: `https://www.imagefaqs.com/search?q=${encodeURIComponent(q)}`, extractor: extractImageFaqsImages },
        pornpics:     { url: `https://www.pornpics.com/search/?q=${encodeURIComponent(q)}`, extractor: extractPornPicsImages },
        pornpics_alt: { url: `https://www.pornpics.com/search/srch.php?q=${encodeURIComponent(q)}&lang=en`, extractor: extractPornPicsImages },
        reddit:       { url: `https://old.reddit.com/r/boobs/top/.json?limit=20`, extractor: extractRedditImages }
    };

    /* v2.6: engines are {n, f} pairs — runEngines records per-engine
     * counts into opts.diag so the panel can show WHICH engine saved
     * the search. Order = relevance priority, deduped at merge. */
    const diag = opts.diag || null;
    const engines = [];
    /* 1 — the user's own domains first, via Bing site: operator */
    for (const d of boostDomains.slice(0, 3)) engines.push({ n: 'bing:' + d, f: () => bingImages(q, d) });
    /* 2 — v2.6 adult workhorses: static, keyless, full-res. They run on
     * EVERY query (they simply return 0 for SFW words like "fish"). */
    engines.push({ n: 'xbooru',    f: () => xbooruImages(q) });
    engines.push({ n: 'realbooru', f: () => realbooruImages(q) });
    engines.push({ n: 'reddit',   f: () => redditQueryImages(q) });
    /* 3 — general engines */
    if (site === 'auto' || site === 'bing')     engines.push({ n: 'bing', f: () => bingImages(q) });
    if (site === 'auto' || site === 'flickr')   engines.push({ n: 'flickr', f: () => flickrImages(q) });
    if (site === 'auto' || site === 'commons')  engines.push({ n: 'commons', f: () => commonsImages(q) });
    if (site === 'auto' || site === 'wikipedia')engines.push({ n: 'wikipedia', f: () => wikipediaImages(q) });
    if (site === 'auto' || site === 'openclipart') engines.push({ n: 'openclipart', f: () => openclipartImages(q) });
    /* 4 — legacy NSFW chain (pornpics needs JS on their site — best effort) */
    if (nsfw){
        engines.push({ n: 'pornpics', f: async () => {
            const html = await utils.fetchPage(LEGACY.pornpics.url);
            return extractPornPicsImages(html, LEGACY.pornpics.url);
        }});
    }
    /* 5 — legacy SFW blog sites as last-ditch attempts */
    if (site === 'auto' || site === 'darknaija' || site === 'imagefaqs'){
        for (const key of ['darknaija', 'imagefaqs']){
            if (site !== 'auto' && site !== key) continue;
            engines.push({ n: key, f: async () => {
                const html = await utils.fetchPage(LEGACY[key].url);
                return LEGACY[key].extractor(html, LEGACY[key].url);
            }});
        }
    }

    let urls = await runEngines(engines, diag);
    urls = relevantFirst([...new Set(urls)], q).slice(0, 40);   /* v2.6: 25 → 40 */
    if (urls.length) console.log(`[search] "${q}" (site=${site}${nsfw ? ' nsfw' : ''}) → ${urls.length} images`);
    return urls;
}

async function downloadAlbum(albumUrlOrKeyword, concurrency = 3) {
    let albumUrl = albumUrlOrKeyword;
    if (albumUrlOrKeyword in ALBUM_MAP) {
        albumUrl = ALBUM_MAP[albumUrlOrKeyword];
    }
    const html = await utils.fetchPage(albumUrl);
    const imageUrls = await utils.extractImageUrls(html, albumUrl);
    if (imageUrls.length === 0) {
        throw new Error('No images found in album');
    }
    const limit = pLimit(concurrency);
    const downloadPromises = imageUrls.map(url =>
        limit(() => utils.downloadImage(url))
    );
    const results = await Promise.allSettled(downloadPromises);
    const valid = results
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);
    if (valid.length === 0) {
        throw new Error('No images could be downloaded');
    }
    const albumId = temp.saveAlbum(valid);
    return albumId;
}

/* ─── v2.4: legacy per-site extractors kept for the explicit-site
 * paths and the NSFW chain (darknaija / pornpics / reddit / imagefaqs).
 * The old fixed-order searchImages() that ran these for EVERY query
 * (and served the site logo as the first result) is gone. ─── */
async function extractDarkNaijaImages(html, url) {
    const $ = require('cheerio').load(html);
    const images = [];
    $('img').each((i, elem) => {
        const src = $(elem).attr('src');
        if (src && src.includes('darknaija')) {
            images.push(src);
        }
    });
    return images;
}

async function extractPornPicsImages(html, url) {
    const $ = require('cheerio').load(html);
    const images = [];
    $('.thumb img, .image img, img[data-src]').each((i, elem) => {
        const src = $(elem).attr('src') || $(elem).attr('data-src');
        if (src && (src.includes('pornpics.com') || src.includes('image'))) {
            images.push(src.startsWith('http') ? src : `https:${src}`);
        }
    });
    return images;
}

async function extractRedditImages(html, url) {
    try {
        const json = JSON.parse(html);
        return json.data.children
            .map(p => p.data.url)
            .filter(url => /\.(jpg|jpeg|png|gif|webp)$/i.test(url))
            .slice(0, 20);
    } catch (e) {
        return [];
    }
}

async function extractImageFaqsImages(html, url) {
    const $ = require('cheerio').load(html);
    const images = [];
    $('.post img, .content img, img.thumbnail').each((i, elem) => {
        const src = $(elem).attr('src');
        if (src && !src.startsWith('data:')) {
            images.push(src.startsWith('http') ? src : `https://www.imagefaqs.com${src}`);
        }
    });
    return images;
}

async function searchVideos(query) {
    const attempts = [
        { 
            site: 'pornhub', 
            url: `https://www.pornhub.com/search/?search=${encodeURIComponent(query)}`,
            extractor: extractPornhubVideos
        },
        { 
            site: 'xhamster', 
            url: `https://www.xhamster.com/search?keyword=${encodeURIComponent(query)}`,
            extractor: extractXhamsterVideos
        },
        { 
            site: 'spankyou', 
            url: `https://spankyou.com/search?q=${encodeURIComponent(query)}`,
            extractor: extractSpankyouVideos
        }
    ];

    for (const attempt of attempts) {
        try {
            await new Promise(resolve => setTimeout(resolve, 500)); // Rate limiting
            const html = await utils.fetchPage(attempt.url);
            let videoUrls = [];
            
            if (attempt.extractor) {
                videoUrls = await attempt.extractor(html);
            } else {
                // Fallback regex extraction
                const matches = html.match(/https?:\/\/[^"'\s<>]+\.(mp4|m3u8|webm)[^"'\s<>]*/g) || [];
                videoUrls = matches;
            }
            
            if (videoUrls.length > 0) {
                console.log(`Found ${videoUrls.length} videos from ${attempt.site}`);
                return [...new Set(videoUrls)].slice(0, 10);
            }
        } catch (e) {
            console.error(`Failed to scrape videos from ${attempt.site}:`, e.message);
            continue;
        }
    }
    return [];
}

// Video extractors
async function extractPornhubVideos(html) {
    const $ = require('cheerio').load(html);
    const videos = [];
    
    // Look for video links and embed URLs
    $('a[href*="/view_video.php"], a[href*="/video"]').each((i, elem) => {
        const href = $(elem).attr('href');
        if (href && href.includes('pornhub')) {
            videos.push(href.startsWith('http') ? href : `https://www.pornhub.com${href}`);
        }
    });
    
    // Also look for video sources in script tags
    const scriptRegex = /https?:\/\/[^"'\s]+\.(mp4|m3u8|webm)[^"'\s]*/gi;
    const scriptMatches = html.match(scriptRegex) || [];
    videos.push(...scriptMatches);
    
    return [...new Set(videos)];
}

async function extractXhamsterVideos(html) {
    const $ = require('cheerio').load(html);
    const videos = [];
    
    $('a[href*="/videos/"], video source').each((i, elem) => {
        const href = $(elem).attr('href') || $(elem).attr('src');
        if (href && (href.includes('.mp4') || href.includes('/videos/'))) {
            videos.push(href.startsWith('http') ? href : `https://xhamster.com${href}`);
        }
    });
    
    return [...new Set(videos)];
}

async function extractSpankyouVideos(html) {
    // Regex fallback for spankyou
    const regex = /https?:\/\/[^"'\s]+\.(mp4|m3u8|webm)[^"'\s]*/gi;
    return (html.match(regex) || []).filter(url => url.includes('spankyou'));
}

async function searchMusic(query) {
    const attempts = [
        { 
            site: 'y2mate', 
            url: `https://www.y2mate.com/search?q=${encodeURIComponent(query)}`,
            extractor: extractY2MateMusic
        },
        { 
            site: 'mp3juices', 
            url: `https://mp3juices.cc/search/?q=${encodeURIComponent(query)}`,
            extractor: extractMp3JuicesMusic
        },
        { 
            site: 'pagalworld', 
            url: `https://pagalworld.com/search/${encodeURIComponent(query)}`,
            extractor: extractPagalworldMusic
        }
    ];

    for (const attempt of attempts) {
        try {
            // FIX: was `invo500` — undefined variable threw inside try, so every
            // attempt failed and /search-music always returned []. Rate limit = 500ms.
            await new Promise(resolve => setTimeout(resolve, 500)); // Rate limiting
            const html = await utils.fetchPage(attempt.url);
            let musicUrls = [];
            
            if (attempt.extractor) {
                musicUrls = await attempt.extractor(html);
            } else {
                // Fallback regex
                const matches = html.match(/https?:\/\/[^"'\s]+\.(mp3|aac|ogg|wav|flac)[^"'\s]*/gi) || [];
                musicUrls = matches;
            }
            
            if (musicUrls.length > 0) {
                console.log(`Found ${musicUrls.length} music links from ${attempt.site}`);
                return [...new Set(musicUrls)].slice(0, 10);
            }
        } catch (e) {
            console.error(`Failed to scrape music from ${attempt.site}:`, e.message);
            continue;
        }
    }
    return [];
}

// Music extractors
async function extractY2MateMusic(html) {
    const $ = require('cheerio').load(html);
    const music = [];
    
    $('a[href*="download"], a[href*=".mp3"], button[data-url]').each((i, elem) => {
        const href = $(elem).attr('href') || $(elem).attr('data-url') || $(elem).attr('data-src');
        if (href && href.match(/\.(mp3|aac|ogg)$/i)) {
            music.push(href);
        }
    });
    
    return music;
}

async function extractMp3JuicesMusic(html) {
    const $ = require('cheerio').load(html);
    const music = [];
    
    $('.download-btn, .download-button, a.download').each((i, elem) => {
        const href = $(elem).attr('href');
        if (href && href.includes('download') && href.match(/\.mp3$/i)) {
            music.push(href);
        }
    });
    
    return music;
}

async function extractPagalworldMusic(html) {
    const $ = require('cheerio').load(html);
    const music = [];
    
    $('a[href*=".mp3"], a[href*="download.php"]').each((i, elem) => {
        const href = $(elem).attr('href');
        if (href && href.includes('pagalworld')) {
            music.push(href.startsWith('http') ? href : `https://pagalworld.com${href}`);
        }
    });
    
    return music;
}

async function searchLyrics(query) {
    const googleQuery = `https://www.google.com/search?q=${encodeURIComponent(query + " lyrics")}`;
    
    try {
        const html = await utils.fetchPage(googleQuery);
        const $ = require('cheerio').load(html);
        const lyricLinks = [];
        
        // Extract Google search results
        $('a[href*="azlyrics.com"], a[href*="genius.com"], a[href*="lyrics.com"]').each((i, elem) => {
            const href = $(elem).attr('href');
            if (href && href.startsWith('/url?q=')) {
                const decodedUrl = decodeURIComponent(href.split('/url?q=')[1].split('&')[0]);
                if (decodedUrl.includes('lyrics')) {
                    lyricLinks.push(decodedUrl);
                }
            }
        });
        
        // Also try direct regex for common lyric sites
        const regex = /https?:\/\/(?:www\.)?(?:azlyrics\.com|genius\.com|lyrics\.com)\/[^"'\s>]+/gi;
        const regexMatches = html.match(regex) || [];
        
        return [...new Set([...lyricLinks, ...regexMatches])].slice(0, 5);
    } catch (e) {
        console.error('Failed to search lyrics:', e.message);
        return [];
    }
}

module.exports = {
    downloadAlbum,
    searchImages,
    searchVideos,
    searchMusic,
    searchLyrics
};
