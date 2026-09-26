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

async function bingImages(q, siteDomain){
    const query = siteDomain ? `${q} site:${siteDomain}` : q;
    const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`;
    const r = await axios.get(url, { headers: {
        'User-Agent': ENGINE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': 'SRCHHPGUSR=SRCHLANG=en'
    }, timeout: 15000 });
    const $ = require('cheerio').load(r.data);
    const out = [];
    $('a.iusc').each((i, el) => {
        try { const m = JSON.parse($(el).attr('m')); if (m && m.murl && !utils.isJunkImageUrl(m.murl)) out.push(m.murl); } catch (e) {}
    });
    return out;
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

async function runEngines(list){
    const found = [];
    await Promise.all(list.map(async (fn) => {
        try {
            const urls = await fn();
            const clean = (urls || []).filter(u => !utils.isJunkImageUrl(u));
            if (clean.length) found.push(...clean);
        } catch (e) {
            console.error('[engine] failed:', e.message);
        }
    }));
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

    const engines = [];
    /* 1 — the user's own domains first, via Bing site: operator */
    for (const d of boostDomains.slice(0, 3)) engines.push(() => bingImages(q, d));
    /* 2 — general engines */
    if (site === 'auto' || site === 'bing')     engines.push(() => bingImages(q));
    if (site === 'auto' || site === 'flickr')   engines.push(() => flickrImages(q));
    if (site === 'auto' || site === 'commons')  engines.push(() => commonsImages(q));
    if (site === 'auto' || site === 'wikipedia')engines.push(() => wikipediaImages(q));
    if (site === 'auto' || site === 'openclipart') engines.push(() => openclipartImages(q));
    /* 3 — NSFW chain only when explicitly asked */
    if (nsfw){
        engines.push(async () => {
            const html = await utils.fetchPage(LEGACY.pornpics.url);
            return extractPornPicsImages(html, LEGACY.pornpics.url);
        });
        engines.push(async () => {
            const html = await utils.fetchPage(LEGACY.reddit.url);
            return extractRedditImages(html, LEGACY.reddit.url);
        });
    }
    /* 4 — legacy SFW blog sites as last-ditch attempts */
    if (site === 'auto' || site === 'darknaija' || site === 'imagefaqs'){
        for (const key of ['darknaija', 'imagefaqs']){
            if (site !== 'auto' && site !== key) continue;
            engines.push(async () => {
                const html = await utils.fetchPage(LEGACY[key].url);
                return LEGACY[key].extractor(html, LEGACY[key].url);
            });
        }
    }

    let urls = await runEngines(engines);
    urls = relevantFirst([...new Set(urls)], q).slice(0, 25);
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
