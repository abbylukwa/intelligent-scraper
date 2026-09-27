'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');

const album = require('./album');
const gif = require('./gif');
const temp = require('./temp');
const media = require('./media');

const app = express();
const PORT = process.env.PORT || 10000;

// ═══════════════════════════════════════════════════════════════
// MY LINKS — 7 easy-to-replace slots (edit my_links.json)
// Put YOUR own website links in my_links.json — the 7 dummy ones in
// there are placeholders. Nothing else in this file needs to change.
// Built-in sites (darknaija, pornpics, reddit, imagefaqs, tenor,
// giphy ...) were NOT touched.
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const utils = require('./utils');
const MY_LINKS_FILE = path.join(__dirname, 'my_links.json');

/* ═══════════════════════════════════════════════════════════════
 * v2.5 MY LINKS — three ways to add YOUR sites, all merged:
 *   1. my_links.json (HOT-RELOADED — edit the file, the very next
 *      search uses it. NO restart needed anymore.)
 *   2. MYLINKS env var — "url1, url2, url3" (set in Render env,
 *      no file editing at all)
 *   3. per-request: POST /search {"myLinks": ["https://..."]}
 *      — the whatsapp bot forwards its own MYLINKS env
 *        automatically with EVERY search.
 *
 * v2.5 ORDERING FIX: your links are tried FIRST and their results
 * are placed FIRST in the returned array — the bot downloads
 * images[0], so previously engine results buried your own sites.
 * A dead/JS-walled slot never breaks a search — it is skipped,
 * logged, and recorded in the /my-links diagnostics.
 * ═══════════════════════════════════════════════════════════ */
let MY_LINKS = [];
let MY_LINKS_MTIME = -1;
function loadMyLinks(force){
    try {
        const st = fs.existsSync(MY_LINKS_FILE) ? fs.statSync(MY_LINKS_FILE) : null;
        const mtime = st ? st.mtimeMs : 0;
        if (!force && mtime === MY_LINKS_MTIME) return;
        MY_LINKS_MTIME = mtime;
        if (!st){ MY_LINKS = []; return; }
        const raw = JSON.parse(fs.readFileSync(MY_LINKS_FILE, 'utf8'));
        MY_LINKS = Array.isArray(raw.links) ? raw.links.filter(l => l && l.url) : [];
        console.log(`MY LINKS: loaded ${MY_LINKS.length} slot(s) from my_links.json (hot-reload on)`);
    } catch (e) {
        console.error('MY LINKS: could not parse my_links.json —', e.message);
    }
}
loadMyLinks(true);

const MY_LINKS_ENV = String(process.env.MYLINKS || '')
    .split(/[\n,]+/).map(s => s.trim())
    .filter(s => /^https?:\/\//i.test(s))
    .filter((s, i, a) => a.indexOf(s) === i)
    .map((s, i) => ({ slot: 'env-' + (i + 1), name: 'env slot ' + (i + 1), url: s,
                      type: /\.gif(\?|$)/i.test(s) ? 'gif' : 'image', enabled: true, source: 'env' }));
if (MY_LINKS_ENV.length) console.log(`MY LINKS: +${MY_LINKS_ENV.length} slot(s) from MYLINKS env`);

/* per-slot diagnostics — open /my-links to SEE which of your sites
 * really return media and which are JS-walled (0 results) */
const MY_LINK_DIAG = new Map();
function diagRecord(key, count, error){
    MY_LINK_DIAG.set(key, { ts: new Date().toISOString(), count: count || 0, error: error || null });
}

function getMyLinks(type, extraLinks){
    loadMyLinks(false);
    let slots = MY_LINKS.map(l => Object.assign({ source: 'file' }, l)).concat(MY_LINKS_ENV);
    if (Array.isArray(extraLinks) && extraLinks.length){
        const reqSlots = extraLinks.map((l, i) => {
            if (typeof l === 'string')
                return { url: l, type: /\.gif(\?|$)/i.test(l) ? 'gif' : 'image', name: 'bot-link-' + (i + 1), source: 'request' };
            return (l && l.url) ? Object.assign({ source: 'request' }, l) : null;
        }).filter(Boolean);
        slots = reqSlots.concat(slots);          /* per-request links lead */
    }
    /* v2.5.3 DEDUPE: the bot now HARD-CODES the same 7 sites as
     * my_links.json and forwards them with every search — without this
     * filter every URL was fetched TWICE per search (request + file).
     * First occurrence wins: request links lead, then file, then env. */
    const seenUrls = new Set();
    return slots
        .filter(l => (l.enabled !== false) && String(l.type || 'image') === type)
        .filter(l => { const u = String(l.url || ''); if (seenUrls.has(u)) return false; seenUrls.add(u); return true; });
}

// Build the real URL to fetch for a custom link + search word.
// v2.4 FIX — why pngtree.com downloaded the logo:
//   • a link WITH a path (https://pngtree.com/free-animals-png/fish) is a
//     pinned CATEGORY page → fetched AS-IS (its own path already says
//     what to grab — appending ?s= turned it back into the homepage)
//   • a bare domain (https://pngtree.com) is useless with ?s= on modern
//     JS sites → the domain is ALSO searched via Bing "query site:domain"
//     in /search (boostDomains), which finds the site's real images
//   • {query} templates work exactly as before
function myLinkUrl(link, query) {
    const q = encodeURIComponent(query || '');
    const u = String(link.url || '');
    if (u.includes('{query}')) return u.replace(/\{query\}/g, q);
    try {
        const pu = new URL(u);
        const segs = pu.pathname.split('/').filter(Boolean);
        /* pinned category page: keep it as-is (search word already in path) */
        if (segs.length >= 1 && !/[?&]s=$/.test(u)) return u;
    } catch (e) {}
    return u + (u.includes('?') ? '&' : '?') + 's=' + q;
}

/* v2.4: unique hostnames from your enabled image links — used to boost
 * searches with Bing site: so your sites return REAL content images. */
function myLinkDomains(type){
    const out = new Set();
    for (const l of getMyLinks(type)){
        try { out.add(new URL(l.url).hostname.replace(/^www\./, '')); } catch (e) {}
    }
    return [...out];
}

// Try every enabled custom link of `type`; returns an array of direct
// media URLs found. A dead/dummy link NEVER breaks a search — each slot
// fails independently, is skipped and logged.
async function tryMyLinks(query, type, extraLinks) {
    const slots = getMyLinks(type, extraLinks);
    if (!slots.length) return [];
    const found = [];
    await Promise.all(slots.map(async (link) => {
        try {
            const url = myLinkUrl(link, query);
            const html = await Promise.race([
                utils.fetchPage(url),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
            ]);
            let urls = [];
            if (type === 'gif') {
                const matches = String(html).match(/https?:\/\/[^"'\s<>\\]+\.gif/gi) || [];
                urls = matches.filter(u => !/replace-me|example\.com/i.test(u));
            } else {
                urls = await utils.extractImageUrls(String(html), url);
            }
            urls = [...new Set(urls)].slice(0, 30);
            diagRecord(String(link.url), urls.length, urls.length ? null : '0 media in static HTML (JS-walled? the Bing site: boost still covers this domain)');
            if (urls.length) console.log(`MY LINKS: "${link.name || link.url}" → ${urls.length} ${type}(s)`);
            else console.log(`MY LINKS: "${link.name || link.url}" → no ${type}s found (page may need JS — Bing site: boost still covers this domain)`);
            found.push(...urls);
        } catch (e) {
            diagRecord(String(link.url), 0, e.message);
            console.log(`MY LINKS: "${link.name || link.url}" skipped (${e.message}) — check /my-links diagnostics`);
        }
    }));
    return found;
}

// FIX: trust proxy so req.protocol is https behind Render's proxy
// (media URLs returned to the bot must be absolute https links)
app.set('trust proxy', true);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files
app.use('/temp', express.static(temp.TEMP_DIR));

// Health check endpoints
app.get('/status', (req, res) => {
    const stats = temp.getStats();
    res.json({
        status: 'ok',
        service: 'intelligent-scraper',
        version: '2.5.3',
        uptime: process.uptime(),
        tempFiles: stats.fileCount,
        // FIX: getStats() already returns totalSizeMB as a string (toFixed applied
        // inside temp.js) — calling .toFixed() on it again threw TypeError, so
        // /status always returned 500 and the bot's !scraperstatus always said DOWN.
        tempSizeMB: Number(stats.totalSizeMB) || 0,
        endpoints: [
            '/search',
            '/search-video', 
            '/search-music',
            '/search-lyrics',
            '/album',
            '/gif',
            '/music',
            '/video',
            '/download',
            '/cleanup',
            '/my-links'
        ],
        myLinks: {
            loaded: MY_LINKS.length,
            enabled: MY_LINKS.filter(l => l.enabled !== false).length,
            envSlots: MY_LINKS_ENV.length,
            hotReload: true,
            triedFirst: true
        }
    });
});

// MY LINKS status — live diagnostics for every slot you added
app.get('/my-links', (req, res) => {
    loadMyLinks(false);
    const diag = (url) => MY_LINK_DIAG.get(String(url)) || null;
    res.json({
        success: true,
        version: '2.5.3',
        howTo: 'THREE ways: (1) edit my_links.json — HOT-reloaded, next search uses it, no restart; (2) set MYLINKS env var "url1, url2" on this service OR on the bot (the bot forwards its own MYLINKS with every search); (3) POST /search {"myLinks":["https://..."]}. Your links are tried FIRST and their results lead the list (the bot downloads images[0]). Type "image" or "gif", {query} template optional, enabled:false switches a slot off.',
        loaded: MY_LINKS.length,
        enabled: MY_LINKS.filter(l => l.enabled !== false).length,
        envSlots: MY_LINKS_ENV.map(l => l.url),
        links: MY_LINKS.map(l => Object.assign({}, l, { lastResult: diag(l.url) })),
        envLinkDiag: MY_LINKS_ENV.map(l => Object.assign({}, l, { lastResult: diag(l.url) }))
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        ok: true, 
        timestamp: new Date().toISOString(),
        service: 'intelligent-scraper'
    });
});

// ─── Optional token auth ──────────────────────────────────────
// INTEGRATION FIX: whatsapp-qr-app sends `Authorization: Bearer <SCRAPER_TOKEN>`
// when SCRAPER_TOKEN is set in its env. The scraper ignored it. Now: if
// SCRAPER_TOKEN is set here, data endpoints require the same token. If not set,
// everything stays open exactly as before (zero behavior change).
const dataApi = express.Router();
dataApi.use((req, res, next) => {
    const token = process.env.SCRAPER_TOKEN;
    if (!token) return next();
    const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (provided === token) return next();
    return res.status(401).json({ error: 'Unauthorized — send Authorization: Bearer <SCRAPER_TOKEN>' });
});

// Search images — v2.4 multi-engine (Bing / Flickr / Wikimedia / Wikipedia /
// Openclipart + your my_links domains boosted via site: operator)
app.post('/search', dataApi, async (req, res) => {
    try {
        const { query, q, site = 'auto', nsfw = false } = req.body;
        const searchQuery = query || q;
        
        if (!searchQuery || searchQuery.trim() === '') {
            return res.status(400).json({ 
                error: 'Query parameter is required',
                example: { "query": "nature" }
            });
        }
        
        console.log(`Searching images for: "${searchQuery}" (site=${site}, nsfw=${!!nsfw})`);
        const urls = await album.searchImages(searchQuery, site, { nsfw: nsfw === true, boostDomains: myLinkDomains('image') });

        // MY LINKS: your sites (file + env + request) are tried FIRST
        const myUrls = await tryMyLinks(searchQuery, 'image', req.body?.myLinks);
        if (myUrls.length) console.log(`[search] ${myUrls.length} image(s) from MY LINKS — placed FIRST`);
        /* v2.5 ORDERING FIX: your links LEAD the array — the bot
         * downloads images[0], so engine results used to bury them. */
        const allUrls = [...new Set([...myUrls, ...urls])];
        
        res.json({ 
            success: true,
            query: searchQuery,
            images: allUrls, 
            count: allUrls.length,
            source: site,
            myLinks: myUrls.length,
            myLinksFirst: myUrls.length > 0
        });
    } catch (e) {
        console.error('Image search error:', e);
        res.status(500).json({ 
            error: 'Failed to search images',
            message: e.message 
        });
    }
});

// Search videos
app.post('/search-video', dataApi, async (req, res) => {
    try {
        const { query, q } = req.body;
        const searchQuery = query || q;
        
        if (!searchQuery || searchQuery.trim() === '') {
            return res.status(400).json({ 
                error: 'Query parameter is required',
                example: { "query": "music video" }
            });
        }
        
        console.log(`Searching videos for: "${searchQuery}"`);
        const videos = await album.searchVideos(searchQuery);
        
        res.json({ 
            success: true,
            query: searchQuery,
            videos: videos, 
            count: videos.length,
            sources: ['pornhub', 'xhamster', 'spankyou']
        });
    } catch (e) {
        console.error('Video search error:', e);
        res.status(500).json({ 
            error: 'Failed to search videos',
            message: e.message 
        });
    }
});

// Search music
app.post('/search-music', dataApi, async (req, res) => {
    try {
        const { query, q } = req.body;
        const searchQuery = query || q;
        
        if (!searchQuery || searchQuery.trim() === '') {
            return res.status(400).json({ 
                error: 'Query parameter is required',
                example: { "query": "pop song" }
            });
        }
        
        console.log(`Searching music for: "${searchQuery}"`);
        const music = await album.searchMusic(searchQuery);
        
        res.json({ 
            success: true,
            query: searchQuery,
            music: music, 
            count: music.length,
            sources: ['y2mate', 'mp3juices', 'pagalworld']
        });
    } catch (e) {
        console.error('Music search error:', e);
        res.status(500).json({ 
            error: 'Failed to search music',
            message: e.message 
        });
    }
});

// Search lyrics
app.post('/search-lyrics', dataApi, async (req, res) => {
    try {
        const { query, q } = req.body;
        const searchQuery = query || q;
        
        if (!searchQuery || searchQuery.trim() === '') {
            return res.status(400).json({ 
                error: 'Query parameter is required',
                example: { "query": "Bohemian Rhapsody" }
            });
        }
        
        console.log(`Searching lyrics for: "${searchQuery}"`);
        const lyrics = await album.searchLyrics(searchQuery);
        
        res.json({ 
            success: true,
            query: searchQuery,
            lyrics: lyrics, 
            count: lyrics.length,
            note: 'These are links to lyric pages. You may need to scrape each page to get actual lyrics.'
        });
    } catch (e) {
        console.error('Lyrics search error:', e);
        res.status(500).json({ 
            error: 'Failed to search lyrics',
            message: e.message 
        });
    }
});

// Album download
app.post('/album', dataApi, async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url || url.trim() === '') {
            return res.status(400).json({ 
                error: 'URL parameter is required',
                example: { "url": "https://example.com/album" }
            });
        }
        
        console.log(`Downloading album from: ${url}`);
        const albumId = await album.downloadAlbum(url);
        
        res.json({ 
            success: true,
            albumId: albumId,
            message: 'Album downloaded successfully',
            nextImageEndpoint: `/album/${albumId}/next`
        });
    } catch (e) {
        console.error('Album download error:', e);
        res.status(500).json({ 
            error: 'Failed to download album',
            message: e.message 
        });
    }
});

// Get next image from album
app.get('/album/:albumId/next', async (req, res) => {
    try {
        const { albumId } = req.params;
        const image = temp.getNextImage(albumId);
        
        if (!image) {
            return res.status(404).json({ 
                error: 'No more images or album not found',
                albumId: albumId
            });
        }
        
        // Use actual hostname for URL generation
        const host = req.get('host') || 'localhost:10000';
        const imageUrl = `http://${host}/temp/${path.basename(image.path)}`;
        
        res.json({
            success: true,
            albumId: albumId,
            imageId: image.id,
            url: imageUrl,
            index: image.index,
            total: image.total,
            filename: path.basename(image.path)
        });
    } catch (e) {
        console.error('Get next image error:', e);
        res.status(500).json({ 
            error: 'Failed to get next image',
            message: e.message 
        });
    }
});

// GIF search
app.get('/gif', dataApi, async (req, res) => {
    try {
        const { q } = req.query;
        
        if (!q || q.trim() === '') {
            return res.status(400).json({ 
                error: 'Query parameter q is required',
                example: '/gif?q=funny+cat'
            });
        }
        
        console.log(`Searching GIFs for: "${q}"`);
        const gifUrls = await gif.search(q);

        // MY LINKS: your GIF sites first (hot-reloaded file + env)
        // v2.5.1: the bot can also forward ITS OWN MYLINKS env per request
        const extraGifLinks = String(req.query.myLinks || '')
            .split(/[\n,]+/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s));
        const myGifs = await tryMyLinks(q, 'gif', extraGifLinks);
        /* v2.5: same ordering fix as /search — your GIFs lead */
        const allGifs = [...new Set([...myGifs, ...gifUrls])];
        
        res.json({ 
            success: true,
            query: q,
            gifs: allGifs, 
            count: allGifs.length,
            myLinks: myGifs.length,
            myLinksFirst: myGifs.length > 0
        });
    } catch (e) {
        console.error('GIF search error:', e);
        res.status(500).json({ 
            error: 'Failed to search GIFs',
            message: e.message 
        });
    }
});

// ─── POST /music — BreadBot integration (scraperMusic) ──────
// Bot: POST /music {query} -> expects { mediaUrl, title, mimetype, sizeBytes }
app.post('/music', dataApi, async (req, res) => {
    try {
        const { query, q } = req.body || {};
        const searchQuery = query || q;
        if (!searchQuery || String(searchQuery).trim() === '') {
            return res.status(400).json({ error: 'Query parameter is required', example: { "query": "Winky D" } });
        }
        console.log(`[music] Searching YouTube for: "${searchQuery}"`);
        const vids = await media.ytSearch(searchQuery, 5);
        if (!vids.length) return res.status(404).json({ error: 'No results', message: 'No YouTube results for "' + searchQuery + '"' });
        const baseUrl = req.protocol + '://' + req.get('host');
        let lastErr = null;
        for (const v of vids) {
            try {
                const out = await media.ytDownload(v.id, 'audio', baseUrl);
                console.log(`[music] OK: ${out.title} (${(out.sizeBytes / 1048576).toFixed(1)}MB)`);
                return res.json({ success: true, mediaUrl: out.mediaUrl, title: out.title, mimetype: out.mimetype, kind: 'audio', sizeBytes: out.sizeBytes });
            } catch (e) { lastErr = e; console.error('[music] attempt failed:', e.message); }
        }
        throw lastErr || new Error('All download attempts failed');
    } catch (e) {
        console.error('Music error:', e);
        res.status(500).json({ error: 'Failed to fetch music', message: e.message });
    }
});

// ─── POST /video — BreadBot integration (scraperVideo) ───────
// Bot: POST /video {query} -> expects { mediaUrl, title, mimetype, sizeBytes }
app.post('/video', dataApi, async (req, res) => {
    try {
        const { query, q, exclude } = req.body || {};
        const searchQuery = query || q;
        if (!searchQuery || String(searchQuery).trim() === '') {
            return res.status(400).json({ error: 'Query parameter is required', example: { "query": "funny video" } });
        }
        console.log(`[video] Searching YouTube for: "${searchQuery}"`);
        /* v2.5.2 EXCLUDE: the bot passes already-sent video ids/titles so a
         * "send 6 videos of horse racing" run drops SIX DIFFERENT clips
         * instead of the same top result over and over. */
        const excl = new Set((Array.isArray(exclude) ? exclude : []).map(x => String(x).toLowerCase().trim()).filter(Boolean));
        const found = await media.ytSearch(searchQuery, 10);
        if (!found.length) return res.status(404).json({ error: 'No results', message: 'No YouTube results for "' + searchQuery + '"' });
        const fresh = found.filter(v => !excl.has(String(v.id).toLowerCase()) && !excl.has(String(v.title || '').toLowerCase().trim()));
        const vids = fresh.length ? fresh : found;   /* all already sent? fall back to full list */
        if (excl.size) console.log(`[video] ${found.length} found, ${fresh.length} after excluding ${excl.size} already-sent`);
        const baseUrl = req.protocol + '://' + req.get('host');
        let lastErr = null;
        for (const v of vids) {
            try {
                const out = await media.ytDownload(v.id, 'video', baseUrl);
                console.log(`[video] OK: ${out.title} (${(out.sizeBytes / 1048576).toFixed(1)}MB)`);
                return res.json({ success: true, mediaUrl: out.mediaUrl, title: out.title, videoId: v.id, mimetype: out.mimetype || 'video/mp4', kind: 'video', sizeBytes: out.sizeBytes, results: found.slice(0, 5).map(x => ({ id: x.id, title: x.title })) });
            } catch (e) { lastErr = e; console.error('[video] attempt failed:', e.message); }
        }
        throw lastErr || new Error('All download attempts failed');
    } catch (e) {
        console.error('Video error:', e);
        res.status(500).json({ error: 'Failed to fetch video', message: e.message });
    }
});

// ─── POST /download — BreadBot integration (scraperDownloadMedia) ───
// Bot: POST /download {url, kind} -> expects { mediaUrl, title, mimetype, kind, sizeBytes }
app.post('/download', dataApi, async (req, res) => {
    try {
        const { url, kind = 'auto' } = req.body || {};
        if (!url || String(url).trim() === '') {
            return res.status(400).json({ error: 'URL parameter is required', example: { "url": "https://..." } });
        }
        const baseUrl = req.protocol + '://' + req.get('host');
        let out;
        if (media.ytId(url)) {
            console.log(`[download] YouTube ${kind}: ${url}`);
            out = await media.ytDownload(url, kind === 'video' ? 'video' : 'audio', baseUrl);
        } else {
            console.log(`[download] Direct ${kind}: ${String(url).slice(0, 120)}`);
            out = await media.genericDownload(url, kind, baseUrl);
        }
        return res.json({ success: true, mediaUrl: out.mediaUrl, title: out.title, mimetype: out.mimetype, kind: out.kind, sizeBytes: out.sizeBytes });
    } catch (e) {
        console.error('Download error:', e);
        res.status(500).json({ error: 'Failed to download media', message: e.message });
    }
});

// Cleanup endpoint
app.post('/cleanup', dataApi, (req, res) => {
    try {
        const result = temp.cleanup();
        res.json({ 
            success: true,
            message: 'Cleanup triggered successfully',
            deletedFiles: result.deletedCount || 0,
            freedSpaceMB: result.freedSpaceMB || 0
        });
    } catch (e) {
        console.error('Cleanup error:', e);
        res.status(500).json({ 
            error: 'Cleanup failed',
            message: e.message 
        });
    }
});

// ─── v2.5.2 PERIODIC TEMP SWEEP — disk stays clean even on idle days ───
setInterval(() => {
    try {
        const r = temp.cleanup();
        if (r && r.deletedCount) console.log(`[temp] sweep: ${r.deletedCount} file(s), ${(r.freedSpaceMB || 0).toFixed(1)}MB freed`);
    } catch (e) {}
}, 15 * 60 * 1000).unref?.();

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        availableEndpoints: [
            'POST /search',
            'POST /search-video',
            'POST /search-music', 
            'POST /search-lyrics',
            'POST /album',
            'GET /album/:id/next',
            'GET /gif',
            'POST /music',
            'POST /video',
            'POST /download',
            'POST /cleanup',
            'GET /status',
            'GET /health'
        ]
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

/* v2.5: periodic temp hygiene on long runs — /temp self-clears every
 * 30 min (files older than the temp TTL go first) so a busy bot never
 * fills the Render disk. */
setInterval(function(){
    try {
        const r = temp.cleanup();
        if (r && r.deletedCount) console.log('[cleanup] removed ' + r.deletedCount + ' old temp file(s), freed ' + (r.freedSpaceMB || 0) + 'MB');
    } catch (e) { console.error('[cleanup] failed:', e.message); }
}, 30 * 60 * 1000).unref();

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Intelligent Scraper running on port ${PORT}`);
    console.log(`📁 Temp directory: ${temp.TEMP_DIR}`);
    console.log(`🔍 Available search types: images, videos, music, lyrics`);
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});
