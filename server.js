'use strict';

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

app.use('/temp', express.static(temp.TEMP_DIR));

app.get('/status', (req, res) => {
    const stats = temp.getStats();
    res.json({
        status: 'ok',
        service: 'intelligent-scraper',
        version: '2.1.0',
        uptime: process.uptime(),
        tempFiles: stats.fileCount,
        tempSizeMB: stats.totalSizeMB
    });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
});

// ─── Modified Search Images (Now 5 sources) ──────────────────
app.post('/search', async (req, res) => {
    try {
        const { query, q, site = 'darknaija' } = req.body;
        const searchQuery = query || q;
        if (!searchQuery) return res.status(400).json({ error: 'query required' });
        const urls = await album.searchImages(searchQuery, site);
        res.json({ images: urls, count: urls.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── NEW: Search Videos ──────────────────────────────────────
app.post('/search-video', async (req, res) => {
    try {
        const { query, q } = req.body;
        const searchQuery = query || q;
        if (!searchQuery) return res.status(400).json({ error: 'query required' });
        const videos = await album.searchVideos(searchQuery);
        res.json({ videos, count: videos.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── NEW: Search Music ──────────────────────────────────────
app.post('/search-music', async (req, res) => {
    try {
        const { query, q } = req.body;
        const searchQuery = query || q;
        if (!searchQuery) return res.status(400).json({ error: 'query required' });
        const music = await album.searchMusic(searchQuery);
        res.json({ music, count: music.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── NEW: Search Lyrics ─────────────────────────────────────
app.post('/search-lyrics', async (req, res) => {
    try {
        const { query, q } = req.body;
        const searchQuery = query || q;
        if (!searchQuery) return res.status(400).json({ error: 'query required' });
        const lyrics = await album.searchLyrics(searchQuery);
        res.json({ lyrics, count: lyrics.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/album', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'url required' });
        const albumId = await album.downloadAlbum(url);
        res.json({ albumId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/album/:albumId/next', async (req, res) => {
    try {
        const { albumId } = req.params;
        const image = temp.getNextImage(albumId);
        if (!image) return res.status(404).json({ error: 'No more images or album not found' });
        const imageUrl = `https://your-render-url.com/temp/${path.basename(image.path)}`;
        res.json({
            imageId: image.id,
            url: imageUrl,
            index: image.index,
            total: image.total
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/gif', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ error: 'q required' });
        const gifUrls = await gif.search(q);
        res.json({ gifs: gifUrls, count: gifUrls.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/cleanup', (req, res) => {
    try {
        temp.cleanup();
        res.json({ success: true, message: 'Cleanup triggered' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`Intelligent Scraper running on port ${PORT}`);
});
