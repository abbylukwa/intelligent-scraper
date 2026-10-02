'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');

const album = require('./album');
const temp = require('./temp');
const media = require('./media');

const app = express();
const PORT = process.env.PORT || 10000;

// ═══════════════════════════════════════════════════════════════
// v3.0 MYLINKS-ONLY — ZERO BUILT-IN SOURCES
// Every endpoint is driven EXCLUSIVELY by the slots the owner
// configures. There are NO hardcoded websites, NO fallback
// engines and NO emergency chains anywhere in this codebase.
//   1. my_links.json (HOT-RELOADED — edit the file, the very next
//      search uses it. NO restart needed.)
//   2. MYLINKS env var — "url1, url2" (set on this service OR on
//      the bot — the bot forwards its own MYLINKS with every search)
//   3. per-request: POST /search {"myLinks": ["https://..."]}
// Slot types: 'image' | 'gif' | 'video' | 'music'.
// Empty config = honest "no sources configured" answers.
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const axios = require('axios');
const utils = require('./utils');
const MY_LINKS_FILE = path.join(__dirname, 'my_links.json');

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

function getMyLinks(type, extraLinks, extraType){
    loadMyLinks(false);
    let slots = MY_LINKS.map(l => Object.assign({ source: 'file' }, l)).concat(MY_LINKS_ENV);
    if (Array.isArray(extraLinks) && extraLinks.length){
        const t = extraType || type;
        const reqSlots = extraLinks.map((l, i) => {
            if (typeof l === 'string')
                return { url: l, type: t, name: 'bot-link-' + (i + 1), source: 'request' };
            return (l && l.url) ? Object.assign({ source: 'request', type: t }, l) : null;
        }).filter(Boolean);
        slots = reqSlots.concat(slots);          /* per-request links lead */
    }
    const seenUrls = new Set();
    return slots
        .filter(l => (l.enabled !== false) && String(l.type || 'image') === type)
        .filter(l => { const u = String(l.url || ''); if (seenUrls.has(u)) return false; seenUrls.add(u); return true; });
}

// Build the real URL to fetch for a custom link + search word.
//   • a link WITH a path is a pinned CATEGORY page → fetched AS-IS
//   • a bare domain gets ?s=<query> appended
//   • {query} templates are replaced
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

const NO_SOURCES_HINT = 'No sources configured. Add your links: my_links.json (hot-reloaded, no restart) / MYLINKS env var ("url1, url2") / per-request myLinks parameter. Slot types: image, gif, video, music.';

/* v3.1: video slots must follow FILE order (owner pins the priority —
 * YonaYethuu first) even when the bot forwards the same URLs as env /
 * per-request slots (those would otherwise lead and break the order).
 * Slots that exist in the file sort by their file position; request-
 * only slots append after them in arrival order. */
function sortSlotsByFileOrder(slots, type){
    loadMyLinks(false);
    const fileOrder = new Map();
    MY_LINKS.forEach((l, i) => { if (String(l.type || 'image') === type) fileOrder.set(String(l.url), i); });
    return slots
        .map((s, i) => ({ s, rank: fileOrder.has(String(s.url)) ? fileOrder.get(String(s.url)) : 1000 + i }))
        .sort((a, b) => a.rank - b.rank)
        .map(x => x.s);
}

/* v3.1: pick one video slot by name piece, slot number or url piece.
 * "yona" / "pornpics" work as substrings; a PURE-NUMBER pick ("2")
 * matches the file slot number OR the /video-sites list position —
 * never a URL substring (IPs/ports would false-match). Returns
 * { slots, available } — available = the enabled choices for errors. */
function filterVideoSlots(slots, site){
    const available = slots.map(s => ({ slot: s.slot, name: s.name || s.url, url: s.url }));
    if (!site) return { slots, available };
    const pick = String(site).trim().toLowerCase();
    if (!pick) return { slots, available };
    if (/^\d+$/.test(pick)) {
        const num = parseInt(pick, 10);
        return { slots: slots.filter((s, i) => Number(s.slot) === num || (i + 1) === num), available };
    }
    const matched = slots.filter(s =>
        String(s.name || '').toLowerCase().includes(pick) ||
        String(s.url || '').toLowerCase().includes(pick));
    return { slots: matched, available };
}

// Try every enabled custom link of `type`; returns an array of direct
// media URLs found. A dead link NEVER breaks a search — each slot
// fails independently, is skipped and logged.
async function tryMyLinks(query, type, extraLinks) {
    const slots = getMyLinks(type, extraLinks);
    if (!slots.length) return [];
    const found = [];
    await Promise.all(slots.map(async (link) => {
        try {
            const url = myLinkUrl(link, query);
            /* JSON SLOTS: a slot pointing at a .json API endpoint is
             * PARSED as JSON — regex-on-HTML finds nothing because JSON
             * has no <img> tags. Standard search.json result shape. */
            if (/\.json(\?|#|$)/i.test(url)) {
                const r = await axios.get(url, {
                    headers: { 'User-Agent': 'mozilla/5.0 breadbot-scraper/3.0', 'Accept': 'application/json' },
                    timeout: 15000 });
                const children = r.data?.data?.children || [];
                const urls = [];
                for (const c of children){
                    const d = c.data || {};
                    const u = d.url_overridden_by_dest || '';
                    if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(u)) urls.push(u);
                    const pv = d.preview?.images?.[0]?.source?.url || '';
                    if (pv) urls.push(pv.replace(/&amp;/g, '&'));
                }
                const clean = [...new Set(urls)].filter(u => !utils.isJunkImageUrl(u)).slice(0, 30);
                diagRecord(String(link.url), clean.length, clean.length ? null : '0 media in JSON');
                if (clean.length) console.log(`MY LINKS (json): "${link.name || link.url}" → ${clean.length} ${type}(s)`);
                found.push(...clean);
                return;
            }
            const html = await Promise.race([
                utils.fetchPage(url),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
            ]);
            let urls = [];
            if (type === 'gif') {
                /* v3.1: gif slots also extract .mp4/.webm loops — blog
                 * "gif" posts embed mp4 players, not .gif files. The bot
                 * sends both as video, so nothing breaks downstream. */
                const matches = String(html).match(/https?:\/\/[^"'\s<>\\]+\.(?:gif|mp4|webm)(?:\?[^\s"'<>\\]*)?/gi) || [];
                urls = matches.filter(u => !/replace-me|example\.com/i.test(u));
                /* dedupe + rank on-topic slugs first (generic, no site logic) */
                urls = utils.relevantGifs(urls, query);
            } else if (type === 'video' || type === 'music') {
                /* list-only mode (used by /search-video & /search-music):
                 * direct media links straight off the page, no download */
                const re = type === 'video'
                    ? /https?:\/\/[^\s"'<>\\]+\.(?:mp4|webm)[^\s"'<>\\]*/gi
                    : /https?:\/\/[^\s"'<>\\]+\.(?:mp3|m4a|ogg|wav|aac)(?:\?[^\s"'<>\\]*)?/gi;
                urls = [...new Set((String(html).match(re) || []).map(u => u.replace(/&amp;/g, '&')))];
            } else {
                urls = await utils.extractImageUrls(String(html), url);
                /* DAPI XML SLOTS: gelbooru-family dapi endpoints answer
                 * static XML with full-res originals in file_url="…" —
                 * no <img> tags, cheerio finds nothing. */
                if (!urls.length) urls = utils.extractDapiFileUrls(String(html));
            }
            urls = [...new Set(urls)].slice(0, 30);
            diagRecord(String(link.url), urls.length, urls.length ? null : '0 media in static HTML (JS-walled?)');
            if (urls.length) console.log(`MY LINKS: "${link.name || link.url}" → ${urls.length} ${type}(s)`);
            else console.log(`MY LINKS: "${link.name || link.url}" → no ${type}s found (page may need JS)`);
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
    loadMyLinks(false);   /* keep the counts fresh (mtime hot-reload) */
    const stats = temp.getStats();
    res.json({
        status: 'ok',
        service: 'intelligent-scraper',
        version: '4.0.0',
        uptime: process.uptime(),
        tempFiles: stats.fileCount,
        tempSizeMB: Number(stats.totalSizeMB) || 0,
        maxDownloadMB: media.MAX_MB,
        builtInSources: 0,
        endpoints: [
            '/search',
            '/search-video',
            '/search-music',
            '/search-lyrics',
            '/album',
            '/gif',
            '/music',
            '/video',
            '/video-sites',
            '/download',
            '/cleanup',
            '/my-links'
        ],
        myLinks: {
            loaded: MY_LINKS.length,
            enabled: MY_LINKS.filter(l => l.enabled !== false).length,
            envSlots: MY_LINKS_ENV.length,
            hotReload: true,
            triedFirst: true,
            types: ['image', 'gif', 'video', 'music']
        }
    });
});

// MY LINKS status — live diagnostics for every slot you added
app.get('/my-links', (req, res) => {
    loadMyLinks(false);
    const diag = (url) => MY_LINK_DIAG.get(String(url)) || null;
    res.json({
        success: true,
        version: '4.0.0',
        howTo: 'MYLINKS-ONLY (zero built-in sites). THREE ways: (1) edit my_links.json — HOT-reloaded, next search uses it, no restart; (2) set MYLINKS env var "url1, url2" on this service OR on the bot (the bot forwards its own MYLINKS with every search); (3) POST /search {"myLinks":["https://..."]}. Types: image, gif, video, music. {query} template optional, enabled:false switches a slot off. A dead slot never breaks a search.',
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
// If SCRAPER_TOKEN is set here, data endpoints require the same token.
// If not set, everything stays open exactly as before.
const dataApi = express.Router();
dataApi.use((req, res, next) => {
    const token = process.env.SCRAPER_TOKEN;
    if (!token) return next();
    const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (provided === token) return next();
    return res.status(401).json({ error: 'Unauthorized — send Authorization: Bearer <SCRAPER_TOKEN>' });
});

// Search images — v3.0: EXCLUSIVELY from your MyLinks slots
app.post('/search', dataApi, async (req, res) => {
    try {
        const { query, q, site = 'auto' } = req.body;
        const searchQuery = query || q;

        if (!searchQuery || searchQuery.trim() === '') {
            return res.status(400).json({
                error: 'Query parameter is required',
                example: { "query": "nature" }
            });
        }

        console.log(`Searching images for: "${searchQuery}" (site=${site})`);

        // MY LINKS: your sites (file + env + request) are the ONLY source
        const myUrls = await tryMyLinks(searchQuery, 'image', req.body?.myLinks);
        if (myUrls.length) console.log(`[search] ${myUrls.length} image(s) from MY LINKS — placed FIRST`);

        const allUrls = [...new Set(myUrls)];
        /* LEAD-RESULT VERIFIER: probe the first candidates and lead with
         * a VERIFIED alive one (adds ~1-2s, only when the leader is dead). */
        const verified = allUrls.length ? await utils.verifyLeadingImages(allUrls, 4) : allUrls;
        if (verified[0] !== allUrls[0]) console.log(`[search] lead result was DEAD — promoted verified image to front`);

        res.json({
            success: true,
            query: searchQuery,
            images: verified,
            count: verified.length,
            source: site,
            myLinks: myUrls.length,
            myLinksFirst: myUrls.length > 0,
            hint: myUrls.length ? undefined : NO_SOURCES_HINT,
            version: '4.0.0'
        });
    } catch (e) {
        console.error('Image search error:', e);
        res.status(500).json({
            error: 'Failed to search images',
            message: e.message
        });
    }
});

// Search videos — v3.1: direct video links scraped from YOUR slots.
// Optional "site" picks ONE video site (name piece / slot number).
app.post('/search-video', dataApi, async (req, res) => {
    try {
        const { query, q, site } = req.body;
        const searchQuery = query || q;

        if (!searchQuery || searchQuery.trim() === '') {
            return res.status(400).json({
                error: 'Query parameter is required',
                example: { "query": "music video" }
            });
        }

        console.log(`Searching videos for: "${searchQuery}"${site ? ' (site=' + site + ')' : ''}`);
        const extraLinks = Array.isArray(req.body?.myLinks) ? req.body.myLinks
            : (req.body?.myLinks ? [req.body.myLinks] : []);
        let slots = sortSlotsByFileOrder(getMyLinks('video', extraLinks, 'video'), 'video');
        const picked = filterVideoSlots(slots, site);
        if (site && !picked.slots.length) {
            return res.status(404).json({
                error: 'site "' + site + '" not found',
                available: picked.available,
                hint: 'Send one of the available names, or a slot number.',
                version: '4.0.0'
            });
        }
        slots = picked.slots;
        const found = [];
        await Promise.all(slots.map(async (link) => {
            try {
                const url = myLinkUrl(link, searchQuery);
                const html = await Promise.race([
                    utils.fetchPage(url),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
                ]);
                const re = /https?:\/\/[^"'\s<>\\]+\.(?:mp4|webm)(?:\?[^"\s'<>\\]*)?/gi;
                const urls = [...new Set((String(html).match(re) || []).map(u => u.replace(/&amp;/g, '&')))]
                    .filter(u => !utils.isJunkImageUrl(u));
                diagRecord(String(link.url), urls.length, urls.length ? null : '0 video links in static HTML');
                found.push(...urls);
            } catch (e) {
                diagRecord(String(link.url), 0, e.message);
            }
        }));
        const videos = [...new Set(found)].slice(0, 30);

        res.json({
            success: true,
            query: searchQuery,
            videos: videos,
            count: videos.length,
            myLinks: videos.length,
            site: site || undefined,
            hint: videos.length ? undefined : NO_SOURCES_HINT,
            version: '4.0.0'
        });
    } catch (e) {
        console.error('Video search error:', e);
        res.status(500).json({
            error: 'Failed to search videos',
            message: e.message
        });
    }
});

// Search music — v3.0: direct audio links scraped from YOUR slots
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
        const extraLinks = Array.isArray(req.body?.myLinks) ? req.body.myLinks
            : (req.body?.myLinks ? [req.body.myLinks] : []);
        const music = await tryMyLinks(searchQuery, 'music', extraLinks);

        res.json({
            success: true,
            query: searchQuery,
            music: music,
            count: music.length,
            myLinks: music.length,
            hint: music.length ? undefined : NO_SOURCES_HINT,
            version: '4.0.0'
        });
    } catch (e) {
        console.error('Music search error:', e);
        res.status(500).json({
            error: 'Failed to search music',
            message: e.message
        });
    }
});

// Search lyrics — v3.0: no built-in sources; kept for compatibility
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
        res.json({
            success: true,
            query: searchQuery,
            lyrics: [],
            count: 0,
            hint: NO_SOURCES_HINT,
            version: '4.0.0'
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

// GIF search — v3.0: EXCLUSIVELY from your gif-type MyLinks slots
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

        // MY LINKS: your GIF sites (hot-reloaded file + env + request)
        const extraGifLinks = String(req.query.myLinks || '')
            .split(/[\n,]+/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s));
        const myGifs = await tryMyLinks(q, 'gif', extraGifLinks);

        let allGifs = [...new Set(myGifs)];
        /* FINAL RELEVANCE PASS: floats on-topic slugs to the very front */
        const relevant = utils.relevantGifs(allGifs, q);
        if (relevant.length && relevant[0] !== allGifs[0]) {
            console.log(`[gif] relevance pass reordered — on-topic gif promoted to front`);
            allGifs = relevant;
        }

        res.json({
            success: true,
            query: q,
            gifs: allGifs,
            count: allGifs.length,
            myLinks: myGifs.length,
            myLinksFirst: myGifs.length > 0,
            hint: myGifs.length ? undefined : NO_SOURCES_HINT,
            version: '4.0.0'
        });
    } catch (e) {
        console.error('GIF search error:', e);
        res.status(500).json({
            error: 'Failed to search GIFs',
            message: e.message
        });
    }
});

// ─── POST /music — BreadBot integration ─────────────────────
// Bot: POST /music {query} -> expects { mediaUrl, title, mimetype, sizeBytes }
// v3.0: driven EXCLUSIVELY by your music-type slots (my_links.json /
// MYLINKS env / per-request myLinks). No slots = honest 404 + hint.
app.post('/music', dataApi, async (req, res) => {
    try {
        const { query, q } = req.body || {};
        const searchQuery = query || q;
        if (!searchQuery || String(searchQuery).trim() === '') {
            return res.status(400).json({ error: 'Query parameter is required', example: { "query": "Winky D" } });
        }
        const slots = getMyLinks('music', Array.isArray(req.body?.myLinks) ? req.body.myLinks
            : (req.body?.myLinks ? [req.body.myLinks] : []), 'music')
            .map(l => ({ name: l.name || l.url, url: myLinkUrl(l, searchQuery) }));
        if (!slots.length) {
            return res.status(404).json({ error: 'No sources', message: NO_SOURCES_HINT, hint: NO_SOURCES_HINT, version: '4.0.0' });
        }
        console.log(`[music] ${slots.length} music slot(s) for: "${searchQuery}"`);
        const baseUrl = req.protocol + '://' + req.get('host');
        const out = await media.myLinksMusic(slots, searchQuery, baseUrl, {
            exclude: req.body?.exclude
        });
        console.log(`[music] OK: ${out.title} (${(out.sizeBytes / 1048576).toFixed(1)}MB)`);
        return res.json({ success: true, mediaUrl: out.mediaUrl, title: out.title, mimetype: out.mimetype, kind: 'audio', sizeBytes: out.sizeBytes });
    } catch (e) {
        console.error('Music error:', e);
        res.status(404).json({ error: 'No results', message: e.message, hint: NO_SOURCES_HINT, version: '4.0.0' });
    }
});

// ─── POST /video — BreadBot integration ──────────────────────
// Bot: POST /video {query} -> expects { mediaUrl, title, mimetype, sizeBytes }
// v3.1: driven EXCLUSIVELY by your video-type slots, tried in FILE
// order (YonaYethuu first). A slot's search page is scraped for direct
// .mp4/.webm links and for video-page links (each page opened, its mp4
// candidates pulled, quality-ranked). The winner is downloaded under
// the SCRAPER_MAX_MB cap (default 40MB — 34MB videos download fine)
// and served from /temp. The bot's exclude list (already-sent TITLES)
// is honoured. Optional "site" (name piece / slot number) forces ONE
// site — unknown picks return 404 + the available list.
app.post('/video', dataApi, async (req, res) => {
    try {
        const { query, q, exclude, site } = req.body || {};
        const searchQuery = query || q;
        if (!searchQuery || String(searchQuery).trim() === '') {
            return res.status(400).json({ error: 'Query parameter is required', example: { "query": "funny video" } });
        }
        const excl = (Array.isArray(exclude) ? exclude : []).map(x => String(x).toLowerCase().trim()).filter(Boolean);
        if (excl.length) console.log(`[video] exclude list: ${excl.length} already-sent title(s)`);
        let slots = sortSlotsByFileOrder(getMyLinks('video', Array.isArray(req.body?.myLinks) ? req.body.myLinks
            : (req.body?.myLinks ? [req.body.myLinks] : []), 'video'), 'video');
        const picked = filterVideoSlots(slots, site);
        if (site && !picked.slots.length) {
            console.log(`[video] site "${site}" not found — ${picked.available.length} available`);
            return res.status(404).json({
                error: 'site "' + site + '" not found',
                available: picked.available,
                hint: 'Send one of the available names, or a slot number. !vidsites lists them.',
                version: '4.0.0'
            });
        }
        slots = picked.slots.map(l => ({ slot: l.slot, name: l.name || l.url, url: myLinkUrl(l, searchQuery) }));
        if (!slots.length) {
            return res.status(404).json({ error: 'No sources', message: NO_SOURCES_HINT, hint: NO_SOURCES_HINT, version: '4.0.0' });
        }
        console.log(`[video] ${slots.length} video slot(s) for: "${searchQuery}"${site ? ' (site=' + site + ')' : ''} — order: ${slots.map(s => s.name).join(' → ')}`);
        const baseUrl = req.protocol + '://' + req.get('host');
        const out = await media.myLinksVideo(slots, searchQuery, baseUrl, { exclude: excl });
        console.log(`[video] OK: ${out.title} (${(out.sizeBytes / 1048576).toFixed(1)}MB)`);
        return res.json({ success: true, mediaUrl: out.mediaUrl, title: out.title, source: out.source, site: site || undefined, mimetype: out.mimetype, kind: 'video', sizeBytes: out.sizeBytes });
    } catch (e) {
        console.error('Video error:', e);
        res.status(404).json({ error: 'No results', message: e.message, hint: NO_SOURCES_HINT, version: '4.0.0' });
    }
});

// ─── GET /video-sites — the list users can pick from ───────────
// Powers the bot's !vidsites command: numbered, enabled-first.
app.get('/video-sites', dataApi, (req, res) => {
    loadMyLinks(false);
    const slots = sortSlotsByFileOrder(getMyLinks('video', [], 'video'), 'video');
    res.json({
        success: true,
        defaultFirst: slots.length ? slots[0].name : null,
        sites: slots.map((s, i) => ({ pick: i + 1, slot: s.slot, name: s.name || s.url, url: s.url })),
        version: '4.0.0'
    });
});

// ─── POST /download — BreadBot integration ───────────────────
// Bot: POST /download {url, kind} -> expects { mediaUrl, title, mimetype, kind, sizeBytes }
// v3.0: generic direct-URL download only (no site-specific resolvers).
app.post('/download', dataApi, async (req, res) => {
    try {
        const { url, kind = 'auto' } = req.body || {};
        if (!url || String(url).trim() === '') {
            return res.status(400).json({ error: 'URL parameter is required', example: { "url": "https://..." } });
        }
        const baseUrl = req.protocol + '://' + req.get('host');
        console.log(`[download] Direct ${kind}: ${String(url).slice(0, 120)}`);
        const out = await media.genericDownload(url, kind, baseUrl);
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

// ─── PERIODIC TEMP SWEEP — disk stays clean even on idle days ───
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

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Intelligent Scraper running on port ${PORT}`);
    console.log(`📁 Temp directory: ${temp.TEMP_DIR}`);
    console.log(`🔗 MYLINKS-ONLY mode: media comes ONLY from your slots (my_links.json / MYLINKS env / per-request)`);
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});
