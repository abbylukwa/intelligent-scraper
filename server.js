'use strict';

// ================================================================
// INTELLIGENT SCRAPER — Pure Scraper API (No AI)
// Image search | Album download | GIF search | Temp storage
// ================================================================

const express = require('express');
const cors = require('cors');
const path = require('path');

const album = require('./album');
const gif = require('./gif');
const temp = require('./temp');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve temp files
app.use('/temp', express.static(temp.TEMP_DIR));

// ─── Health / Status ──────────────────────────────────────
app.get('/status', (req, res) => {
    const stats = temp.getStats();
    res.json({
        status: 'ok',
        service: 'intelligent-scraper',
        version: '2.0.0',
        uptime: process.uptime(),
        tempFiles: stats.fileCount,
        tempSizeMB: stats.totalSizeMB
    });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
});

// ─── Search images ────────────────────────────────────────
app.post('/search', async (req, res) => {
    try {
        const { query, q, site = 'pornpics' } = req.body;
        const searchQuery = query || q;
        if (!searchQuery) return res.status(400).json({ error: 'query required' });
        console.log(`[SEARCH] "${searchQuery}" on ${site}`);
        const urls = await album.searchImages(searchQuery, site);
        console.log(`[SEARCH] Found ${urls.length} images`);
        res.json({ images: urls, count: urls.length });
    } catch (e) {
        console.error(`[SEARCH] Error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// ─── Download an album ────────────────────────────────────
app.post('/album', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'url required' });
        console.log(`[ALBUM] Downloading ${url}`);
        const albumId = await album.downloadAlbum(url);
        console.log(`[ALBUM] Created: ${albumId}`);
        res.json({ albumId });
    } catch (e) {
        console.error(`[ALBUM] Error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// ─── Get next image from album ────────────────────────────
app.get('/album/:albumId/next', (req, res) => {
    try {
        const { albumId } = req.params;
        const image = temp.getNextImage(albumId);
        if (!image) {
            return res.status(404).json({ error: 'Album empty or not found' });
        }
        const imageUrl = `/temp/${path.basename(image.path)}`;
        console.log(`[ALBUM] Next image ${image.index}/${image.total} for ${albumId}`);
        res.json({
            imageId: image.id,
            url: imageUrl,
            index: image.index,
            total: image.total
        });
    } catch (e) {
        console.error(`[ALBUM] Error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// ─── Search GIF ──────────────────────────────────────────
app.get('/gif', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ error: 'q required' });
        console.log(`[GIF] Searching "${q}"`);
        const gifUrls = await gif.search(q);
        console.log(`[GIF] Found ${gifUrls.length} GIFs`);
        res.json({ gifs: gifUrls, count: gifUrls.length });
    } catch (e) {
        console.error(`[GIF] Error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// ─── Cleanup ─────────────────────────────────────────────
app.post('/cleanup', (req, res) => {
    temp.cleanup();
    console.log('[CLEANUP] Manual trigger');
    res.json({ status: 'cleaned' });
});

// ─── Start server ────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🖼️  Intelligent Scraper running on port ${PORT}`);
    console.log(`   Endpoints:`);
    console.log(`     GET  /status`);
    console.log(`     GET  /health`);
    console.log(`     POST /search   { query, site }`);
    console.log(`     POST /album    { url }`);
    console.log(`     GET  /album/:albumId/next`);
    console.log(`     GET  /gif?q=...`);
    console.log(`     POST /cleanup`);
    setInterval(temp.cleanup, 300000);
});
