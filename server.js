const express = require('express');
const cors = require('cors');
const path = require('path');
const album = require('./album');
const gif = require('./gif');
const temp = require('./temp');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve temp files
app.use('/temp', express.static(temp.TEMP_DIR));

// ─── Health / Status ──────────────────────────────
app.get('/status', (req, res) => {
    const stats = temp.getStats();
    res.json({
        status: 'ok',
        tempFiles: stats.fileCount,
        tempSizeMB: stats.totalSizeMB,
        memoryUsage: process.memoryUsage()
    });
});

// ─── Search images (simple) ────────────────────────
app.post('/search', async (req, res) => {
    try {
        const { query, site = 'pornpics' } = req.body;
        if (!query) return res.status(400).json({ error: 'query required' });
        const urls = await album.searchImages(query, site);
        res.json({ images: urls });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Download an album ──────────────────────────────
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

// ─── Get next image from album ──────────────────────
app.get('/album/:albumId/next', (req, res) => {
    try {
        const { albumId } = req.params;
        const image = temp.getNextImage(albumId);
        if (!image) {
            return res.status(404).json({ error: 'Album empty or not found' });
        }
        const imageUrl = `/temp/${path.basename(image.path)}`;
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

// ─── Search GIF ──────────────────────────────────────
app.get('/gif', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ error: 'q required' });
        const gifUrls = await gif.search(q);
        res.json({ gifs: gifUrls });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Cleanup endpoint (admin) ──────────────────────
app.post('/cleanup', (req, res) => {
    temp.cleanup();
    res.json({ status: 'cleaned' });
});

// ─── Start server ───────────────────────────────────
app.listen(PORT, () => {
    console.log(`🖼️ Intelligent Scraper running on port ${PORT}`);
    console.log(`🧹 Temp cleanup every 5 minutes`);
    setInterval(temp.cleanup, 300000);
});
