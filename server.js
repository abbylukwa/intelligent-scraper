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
let MY_LINKS = [];
try {
    if (fs.existsSync(MY_LINKS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(MY_LINKS_FILE, 'utf8'));
        MY_LINKS = Array.isArray(raw.links) ? raw.links.filter(l => l && l.url) : [];
        console.log(`MY LINKS: loaded ${MY_LINKS.length} slot(s) from my_links.json`);
    } else {
        console.log('MY LINKS: my_links.json not found — running on built-in sites only');
    }
} catch (e) {
    console.error('MY LINKS: could not parse my_links.json —', e.message);
}

// Build the real URL to fetch for a custom link + search word.
// {query} in the url is replaced; without it we append ?s=<query> (or &s=).
function myLinkUrl(link, query) {
    const q = encodeURIComponent(query || '');
    const u = String(link.url || '');
    if (u.includes('{query}')) return u.replace(/\{query\}/g, q);
    return u + (u.includes('?') ? '&' : '?') + 's=' + q;
}

// Try every enabled custom link of `type`; returns an array of direct
// media URLs found. A dead/dummy link NEVER breaks a search — each slot
// fails independently, is skipped and logged.
async function tryMyLinks(query, type) {
    const slots = MY_LINKS.filter(l => (l.enabled !== false) && String(l.type || 'image') === type);
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
            if (urls.length) console.log(`MY LINKS: "${link.name || link.url}" → ${urls.length} ${type}(s)`);
            else console.log(`MY LINKS: "${link.name || link.url}" → no ${type}s found (dummy link? replace it in my_links.json)`);
            found.push(...urls);
        } catch (e) {
            console.log(`MY LINKS: "${link.name || link.url}" skipped (${e.message}) — replace it in my_links.json`);
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
        version: '2.3.0',
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
            enabled: MY_LINKS.filter(l => l.enabled !== false).length
        }
    });
});

// MY LINKS status — see your 7 slots and whether they are loaded
app.get('/my-links', (req, res) => {
    res.json({
        success: true,
        file: 'my_links.json',
        howTo: 'Edit my_links.json → put your own URL in "url", keep {query} where the search word goes, set type "image" or "gif", enabled true/false. Restart the service. Built-in sites were not touched.',
        loaded: MY_LINKS.length,
        enabled: MY_LINKS.filter(l => l.enabled !== false).length,
        links: MY_LINKS
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

// Search images (5 sources)
app.post('/search', dataApi, async (req, res) => {
    try {
        const { query, q, site = 'darknaija' } = req.body;
        const searchQuery = query || q;
        
        if (!searchQuery || searchQuery.trim() === '') {
            return res.status(400).json({ 
                error: 'Query parameter is required',
                example: { "query": "nature" }
            });
        }
        
        console.log(`Searching images for: "${searchQuery}"`);
        const urls = await album.searchImages(searchQuery, site);

        // MY LINKS: merge results from your own sites (my_links.json)
        const myUrls = await tryMyLinks(searchQuery, 'image');
        const allUrls = [...new Set([...urls, ...myUrls])];
        
        res.json({ 
            success: true,
            query: searchQuery,
            images: allUrls, 
            count: allUrls.length,
            source: site,
            myLinks: myUrls.length
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

        // MY LINKS: merge GIFs from your own sites (my_links.json)
        const myGifs = await tryMyLinks(q, 'gif');
        const allGifs = [...new Set([...gifUrls, ...myGifs])];
        
        res.json({ 
            success: true,
            query: q,
            gifs: allGifs, 
            count: allGifs.length,
            myLinks: myGifs.length
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
        const { query, q } = req.body || {};
        const searchQuery = query || q;
        if (!searchQuery || String(searchQuery).trim() === '') {
            return res.status(400).json({ error: 'Query parameter is required', example: { "query": "funny video" } });
        }
        console.log(`[video] Searching YouTube for: "${searchQuery}"`);
        const vids = await media.ytSearch(searchQuery, 5);
        if (!vids.length) return res.status(404).json({ error: 'No results', message: 'No YouTube results for "' + searchQuery + '"' });
        const baseUrl = req.protocol + '://' + req.get('host');
        let lastErr = null;
        for (const v of vids) {
            try {
                const out = await media.ytDownload(v.id, 'video', baseUrl);
                console.log(`[video] OK: ${out.title} (${(out.sizeBytes / 1048576).toFixed(1)}MB)`);
                return res.json({ success: true, mediaUrl: out.mediaUrl, title: out.title, mimetype: out.mimetype || 'video/mp4', kind: 'video', sizeBytes: out.sizeBytes });
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
    console.log(`🔍 Available search types: images, videos, music, lyrics`);
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});
