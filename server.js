'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');

const album = require('./album');
const gif = require('./gif');
const temp = require('./temp');

const app = express();
const PORT = process.env.PORT || 10000;

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
        version: '2.1.0',
        uptime: process.uptime(),
        tempFiles: stats.fileCount,
        tempSizeMB: stats.totalSizeMB.toFixed(2),
        endpoints: [
            '/search',
            '/search-video', 
            '/search-music',
            '/search-lyrics',
            '/album',
            '/gif',
            '/cleanup'
        ]
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        ok: true, 
        timestamp: new Date().toISOString(),
        service: 'intelligent-scraper'
    });
});

// Search images (5 sources)
app.post('/search', async (req, res) => {
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
        
        res.json({ 
            success: true,
            query: searchQuery,
            images: urls, 
            count: urls.length,
            source: site
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
app.post('/search-video', async (req, res) => {
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
app.post('/search-music', async (req, res) => {
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
app.post('/search-lyrics', async (req, res) => {
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
app.post('/album', async (req, res) => {
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
app.get('/gif', async (req, res) => {
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
        
        res.json({ 
            success: true,
            query: q,
            gifs: gifUrls, 
            count: gifUrls.length
        });
    } catch (e) {
        console.error('GIF search error:', e);
        res.status(500).json({ 
            error: 'Failed to search GIFs',
            message: e.message 
        });
    }
});

// Cleanup endpoint
app.post('/cleanup', (req, res) => {
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
