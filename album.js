const utils = require('./utils');
const temp = require('./temp');
const pLimit = require('p-limit');

const ALBUM_MAP = {};

/* ══════════════════════════════════════════════════════════════
 * v2.8.3 PRIORITY SOURCE ENFORCEMENT
 * MyLinks first (PornPics, DarkNaija, etc.)
 * Then: Custom extractors (PornPics, DarkNaija, Booru, Reddit)
 * Removed: Generic Bing, Flickr, Commons, Wikipedia, OpenClipart
 * ═════════════════════════════════════════════════════════════ */
const ENGINE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const axios = require('axios');

/* ─── MyLinks image sources (prioritized) ───────────────────── */
async function searchMyLinksImages(query, myLinks) {
    const images = [];
    if (!myLinks || !Array.isArray(myLinks)) return images;
    for (const link of myLinks) {
        if (link.type !== 'image' || !link.enabled) continue;
        try {
            const url = link.url.includes('{query}') 
                ? link.url.replace('{query}', encodeURIComponent(query))
                : link.url;
            const html = await utils.fetchPage(url);
            const found = utils.extractImageUrls(html, url)
                .filter(u => /\.(jpg|jpeg|png|webp|gif)$/i.test(u))
                .filter(u => !utils.isJunkImageUrl(u));
            if (found.length > 0) {
                images.push(...found.slice(0, 8));
            }
        } catch (e) {
            console.error(`[ALBUM] MyLinks "${link.name}" error:`, e.message);
        }
    }
    return images;
}

/* ─── PornPics image scraper ─────────────────────────────────── */
async function searchPornPicsImages(query) {
    const url = `https://www.pornpics.com/search/?q=${encodeURIComponent(query)}`;
    try {
        const html = await utils.fetchPage(url);
        const images = utils.extractImageUrls(html, url)
            .filter(u => /\.(jpg|jpeg|png|webp)$/i.test(u))
            .filter(u => !utils.isJunkImageUrl(u));
        return images.slice(0, 12);
    } catch (e) {
        console.error('[ALBUM] PornPics search error:', e.message);
        return [];
    }
}

/* ─── DarkNaija image scraper ────────────────────────────────── */
async function searchDarkNaijaImages(query) {
    const url = `https://www.darknaija.com/?s=${encodeURIComponent(query)}`;
    try {
        const html = await utils.fetchPage(url);
        const images = utils.extractImageUrls(html, url)
            .filter(u => /\.(jpg|jpeg|png|webp)$/i.test(u))
            .filter(u => !utils.isJunkImageUrl(u));
        return images.slice(0, 12);
    } catch (e) {
        console.error('[ALBUM] DarkNaija search error:', e.message);
        return [];
    }
}

/* ─── XBooru (Gelbooru-style DAPI XML) ───────────────────────── */
async function xbooruImages(q) {
    const tags = String(q).trim().replace(/\s+/g, '+');
    const url = `https://xbooru.com/index.php?page=dapi&s=post&q=index&tags=${encodeURIComponent(tags).replace(/%2B/g, '+')}&limit=50`;
    try {
        const r = await axios.get(url, { headers: { 'User-Agent': ENGINE_UA }, timeout: 15000 });
        const out = [];
        const re = /file_url="([^"]+)"/g; let m;
        while ((m = re.exec(String(r.data))) !== null) {
            if (!utils.isJunkImageUrl(m[1])) out.push(m[1]);
        }
        return out.slice(0, 40);
    } catch (e) {
        console.error('[ALBUM] XBooru error:', e.message);
        return [];
    }
}

/* ─── RealBooru (HTML browse + thumbnail conversion) ────────── */
async function realbooruImages(q) {
    const tags = String(q).trim().replace(/\s+/g, '+');
    const url = `https://realbooru.com/index.php?page=post&s=list&tags=${encodeURIComponent(tags).replace(/%2B/g, '+')}`;
    try {
        const r = await utils.fetchPage(url);
        const thumbs = String(r).match(/https?:\/\/realbooru\.com\/thumbnails\/[0-9a-f]{2}\/[0-9a-f]{2}\/thumbnail_[0-9a-f]+\.(?:jpg|png|gif|jpeg)/gi) || [];
        const out = [];
        for (const t of thumbs) {
            for (const full of utils.booruFullUrls(t)) {
                if (!utils.isJunkImageUrl(full)) out.push(full);
            }
            if (out.length >= 30) break;
        }
        return out;
    } catch (e) {
        console.error('[ALBUM] RealBooru error:', e.message);
        return [];
    }
}

/* ─── Reddit images (JSON fallback) ──────────────────────────── */
async function redditQueryImages(q) {
    try {
        const r = await axios.get('https://old.reddit.com/search.json', {
            params: { q: q, include_over_18: 'on', limit: 40, sort: 'relevance' },
            headers: { 'User-Agent': 'mozilla/5.0 breadbot-scraper/2.8' },
            timeout: 15000
        });
        const children = r.data?.data?.children || [];
        const out = [];
        for (const c of children) {
            const d = c.data || {};
            const u = d.url_overridden_by_dest || '';
            if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(u)) out.push(u);
            const pv = d.preview?.images?.[0]?.source?.url || '';
            if (pv) out.push(pv.replace(/&amp;/g, '&'));
        }
        return [...new Set(out)].filter(u => !utils.isJunkImageUrl(u)).slice(0, 30);
    } catch (e) {
        console.error('[ALBUM] Reddit error:', e.message);
        return [];
    }
}

/* ─── Relevance ranking ────────────────────────────────────────── */
function relevantFirst(urls, q) {
    const words = String(q).toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const score = u => {
        const s = String(u).toLowerCase();
        return words.some(w => s.includes(w)) ? 0 : 1;
    };
    return [...urls].sort((a, b) => score(a) - score(b));
}

/* ─── Engine orchestration ────────────────────────────────────── */
async function runEngines(list, diag) {
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
            console.error('[ALBUM] Engine ' + (e.n || '?') + ' failed:', err.message);
        }
    }));
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

/* ─── Main search function (v2.8.3) ──────────────────────────── */
async function searchImages(query, site = 'auto', opts = {}) {
    const q = String(query || '').trim();
    if (!q) return [];

    const nsfw = opts.nsfw !== false;
    const myLinks = opts.myLinks || [];
    const diag = opts.diag || {};
    const engines = [];

    console.log(`[ALBUM] Searching images "${q}"${nsfw ? ' (nsfw)' : ''}`);

    // 1. MyLinks FIRST (prioritized)
    let myLinksResults = [];
    if (myLinks.length > 0) {
        try {
            myLinksResults = await searchMyLinksImages(q, myLinks);
            if (diag) diag.mylinks_images = myLinksResults.length;
        } catch (e) {
            if (diag) diag.mylinks_images = 0;
        }
    }

    // 2. Always-on custom NSFW engines (no query filtering)
    engines.push({ n: 'pornpics', f: () => searchPornPicsImages(q) });
    engines.push({ n: 'darknaija', f: () => searchDarkNaijaImages(q) });
    
    // 3. Booru sources (keyless, full-res)
    if (nsfw) {
        engines.push({ n: 'xbooru', f: () => xbooruImages(q) });
        engines.push({ n: 'realbooru', f: () => realbooruImages(q) });
    }

    // 4. Reddit fallback (NSFW only)
    if (nsfw) {
        engines.push({ n: 'reddit', f: () => redditQueryImages(q) });
    }

    // Run all engines in parallel
    const engineResults = await runEngines(engines, diag);

    // Merge: MyLinks first, then engine results
    const all = [...myLinksResults, ...engineResults];
    const merged = [...new Set(all)];
    const final = relevantFirst(merged, q);

    console.log(`[ALBUM] "${q}" → ${merged.length} raw → ${final.length} image(s)`);
    return final;
}

/* ─── Album download ────────────────────────────────────────── */
async function downloadAlbum(albumUrlOrKeyword, concurrency = 3) {
    const images = await searchImages(albumUrlOrKeyword);
    if (!images.length) {
        throw new Error('No images found for download');
    }
    const limit = pLimit(concurrency);
    const downloadPromises = images.map(url =>
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

/* ─── Legacy extractors (fallback support) ──────────────────── */
async function extractDarkNaijaImages(html, url) {
    return utils.extractImageUrls(html, url)
        .filter(u => /\.(jpg|jpeg|png|webp)$/i.test(u))
        .filter(u => !utils.isJunkImageUrl(u))
        .slice(0, 15);
}

async function extractPornPicsImages(html, url) {
    return utils.extractImageUrls(html, url)
        .filter(u => /\.(jpg|jpeg|png|webp)$/i.test(u))
        .filter(u => !utils.isJunkImageUrl(u))
        .slice(0, 15);
}

async function extractRedditImages(html, url) {
    try {
        const data = JSON.parse(html);
        const posts = data?.data?.children || [];
        return posts
            .map(p => p.data.url)
            .filter(u => /\.(jpg|jpeg|png|webp)$/i.test(u))
            .filter(u => !utils.isJunkImageUrl(u))
            .slice(0, 10);
    } catch (e) {
        return [];
    }
}

async function extractImageFaqsImages(html, url) {
    return utils.extractImageUrls(html, url)
        .filter(u => /\.(jpg|jpeg|png|webp)$/i.test(u))
        .slice(0, 10);
}

/* ─── Video search (stub for compatibility) ────────────────── */
async function searchVideos(query) {
    console.log(`[ALBUM] Video search not implemented: "${query}"`);
    return [];
}

async function extractPornhubVideos(html) {
    return [];
}

async function extractXhamsterVideos(html) {
    return [];
}

async function extractSpankyouVideos(html) {
    return [];
}

/* ─── Music search (stub for compatibility) ────────────────── */
async function searchMusic(query) {
    console.log(`[ALBUM] Music search not implemented: "${query}"`);
    return [];
}

async function extractY2MateMusic(html) {
    return [];
}

async function extractMp3JuicesMusic(html) {
    return [];
}

async function extractPagalworldMusic(html) {
    return [];
}

/* ─── Lyrics search (stub for compatibility) ────────────────── */
async function searchLyrics(query) {
    console.log(`[ALBUM] Lyrics search not implemented: "${query}"`);
    return [];
}

module.exports = {
    searchImages,
    downloadAlbum,
    extractDarkNaijaImages,
    extractPornPicsImages,
    extractRedditImages,
    extractImageFaqsImages,
    searchVideos,
    extractPornhubVideos,
    extractXhamsterVideos,
    extractSpankyouVideos,
    searchMusic,
    extractY2MateMusic,
    extractMp3JuicesMusic,
    extractPagalworldMusic,
    searchLyrics
};
