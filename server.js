const express = require('express');
const cors = require('cors');
const path = require('path');
const album = require('./album');
const gif = require('./gif');
const temp = require('./temp');
const utils = require('./utils');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/temp', express.static(temp.TEMP_DIR));

// ============================================================
//  AI PROMPT HINTS SYSTEM
// ============================================================

const AI_HINTS = {
  // ✅ EXPECTED PROMPTS — these will work
  expected: {
    search: [
      'search <keyword>',
      'find <keyword>',
      'lookup <keyword>',
      'get images of <keyword>',
      'show me <keyword> pics',
      'pics of <keyword>',
      'images <keyword>',
      'gallery <keyword>',
      'nsfw <keyword>',
      'xxx <keyword>',
      'porn <keyword>',
      'adult <keyword>',
      'hot <keyword>',
      'sexy <keyword>',
      'nude <keyword>',
      'naked <keyword>',
      'boobs <keyword>',
      'ass <keyword>',
      'pussy <keyword>',
      'dick <keyword>',
      'blowjob <keyword>',
      'anal <keyword>',
      'lesbian <keyword>',
      'milf <keyword>',
      'teen <keyword>',
      'ebony <keyword>',
      'asian <keyword>',
      'latina <keyword>',
      'bbc <keyword>',
      'creampie <keyword>',
      'squirt <keyword>',
      'threesome <keyword>',
      'orgy <keyword>',
      'bdsm <keyword>',
      'cosplay <keyword>',
      'amateur <keyword>',
      'homemade <keyword>',
      'outdoor <keyword>',
      'public <keyword>',
      'office <keyword>',
      'school <keyword>',
      'stepmom <keyword>',
      'stepsister <keyword>',
    ],
    gif: [
      'gif <keyword>',
      'send gif <keyword>',
      'animated <keyword>',
      'moving <keyword>',
      'clip <keyword>',
      'short video <keyword>',
    ],
    video: [
      'video <keyword>',
      'download video <url>',
      'get video <url>',
      'ph video <keyword>',
      'pornhub video <keyword>',
      'full video <keyword>',
    ],
    album: [
      'album <url>',
      'download album <url>',
      'gallery <url>',
      'get album <url>',
      'model <username>',
      'pornstar <name>',
      'search model <name>',
      'find model <name>',
      'model album <name>',
    ],
    navigation: [
      'next',
      'more',
      'previous',
      'back',
      'prev',
      'n',
      'p',
      'b',
      'next pic',
      'next image',
      'more pics',
      'keep going',
      'continue',
      'another',
      'again',
    ],
    help: [
      'help',
      'menu',
      'commands',
      'what can you do',
      'how to use',
      'guide',
      'tutorial',
      'info',
      'about',
      'start',
      'hi',
      'hello',
      'hey',
    ]
  },

  // ❌ WON'T WORK — explain why
  wontWork: {
    'send me a video': 'Use "video <keyword>" or paste a PornHub URL. Videos only available 9PM-4AM.',
    'download from youtube': 'Only PornHub videos are supported. Use "video <pornhub_url>".',
    'send me all pics': 'Be specific! Say "search <keyword>" with what you want.',
    'random pics': 'Use "search <keyword>" — I need a topic to search for.',
    'free porn': 'Just say "search <keyword>" directly. No need for "free" prefix.',
    'best porn': 'Use "search <keyword>" — I search across multiple sites for you.',
    'hd video': 'Use "video <keyword>" or "video <pornhub_url>". Quality auto-selects best under 32MB.',
    'long video': 'Videos are capped at 32MB (WhatsApp limit). Shorter clips work best.',
    'send file': 'Use "search <keyword>" for images or "gif <keyword>" for GIFs.',
    'download all': 'Use "album <url>" to download a full gallery, then "next" to browse.',
  },

  // 💡 TIPS for better results
  tips: [
    'Add details: "blonde milf outdoor" gets better results than just "milf"',
    'Combine terms: "asian teen cosplay" is more specific than "asian"',
    'Use model names: "search Riley Reid" or "model Riley Reid" for specific stars',
    'For GIFs: say "gif <keyword>" — only works 9PM-4AM',
    'For videos: paste a PornHub URL or say "video <keyword>" — only 9PM-4AM',
    'Browse albums: after searching, say "next" or "more" to see more pics',
    'Go back: say "prev" or "back" to see the previous image',
    'Album mode: "album <url>" downloads a full gallery, then use "next"/"prev"',
    'Model search: "model <username>" searches across sites for a specific model',
    'Different sites: add "from pornpics" or "from darknaija" to target a source',
    'Avoid repeating: each search is tracked — try different keywords for variety',
    'Page navigation: "search <keyword> page 2" for next page of results',
  ],

  // 🔄 How to vary prompts (avoid repetition)
  varyPrompts: [
    'Instead of "boobs" → try "big natural boobs", "small perky tits", "busty blonde"',
    'Instead of "ass" → try "big booty", "bubble butt", "thick ass latina"',
    'Instead of "blowjob" → try "deepthroat", "facefuck", "cum in mouth"',
    'Instead of "lesbian" → try "girl on girl", "tribbing", "scissoring"',
    'Instead of "anal" → try "ass fuck", "backdoor", "anal creampie"',
    'Add adjectives: "amateur", "homemade", "professional", "hd", "4k"',
    'Add setting: "outdoor", "public", "office", "bedroom", "kitchen", "car"',
    'Add ethnicity: "asian", "ebony", "latina", "european", "japanese", "brazilian"',
    'Add body type: "petite", "curvy", "bbw", "fit", "skinny", "thick"',
    'Add hair: "blonde", "brunette", "redhead", "brunette", "goth"',
    'Add age: "teen", "milf", "mature", "granny", "college"',
    'Add action: "riding", "doggy", "missionary", "cowgirl", "69"',
  ]
};

function getAIHints() {
  return AI_HINTS;
}

function getHelpMessage() {
  return `🤖 *INTELLIGENT SCRAPER v2.0*

📸 *Image Search:*
\`search <keyword>\` — Search across multiple sites
\`find <keyword>\` — Same as search
\`pics of <keyword>\` — Natural language search

🎬 *GIFs (9PM-4AM only):*
\`gif <keyword>\` — Search GIFs from GIPHY, Tenor, PornHub

📹 *Videos (9PM-4AM only):*
\`video <keyword>\` — Search PornHub videos
\`video <pornhub_url>\` — Download specific video (max 32MB)

🖼️ *Albums:*
\`album <url>\` — Download full gallery
\`model <username>\` — Search model/star album

📄 *Navigation:*
\`next\` / \`more\` — Next image in album
\`prev\` / \`back\` — Previous image
\`page <number>\` — Jump to page in search

💡 *Tips:*
• Add details for better results (e.g., "blonde milf outdoor")
• Videos/GIFs only 9PM-4AM Harare time
• Max 32MB per file (WhatsApp limit)
• Each search is deduplicated — vary your keywords!

_Type "tips" for search tips or "vary" for prompt ideas_`;
}

function getTipsMessage() {
  return `💡 *SEARCH TIPS:*
${AI_HINTS.tips.map((t, i) => `${i+1}. ${t}`).join('\n')}

_Type "vary" for ideas on how to vary your prompts_`;
}

function getVaryMessage() {
  return `🔄 *HOW TO VARY YOUR PROMPTS:*
${AI_HINTS.varyPrompts.map((v, i) => `${i+1}. ${v}`).join('\n')}

_Type "tips" for general search tips_`;
}

// ============================================================
//  ENDPOINTS
// ============================================================

// ─── Health / Status ─────────────────────────────────
app.get('/status', (req, res) => {
  const stats = temp.getStats();
  res.json({
    status: 'ok',
    version: '2.0.0',
    tempFiles: stats.fileCount,
    albums: stats.albumCount,
    tempSizeMB: stats.totalSizeMB,
    memoryUsage: process.memoryUsage(),
    gifTime: gif.isGifTime(),
    uptime: process.uptime()
  });
});

// ─── AI Hints ────────────────────────────────────────
app.get('/hints', (req, res) => {
  res.json(getAIHints());
});

app.get('/help', (req, res) => {
  res.json({
    help: getHelpMessage(),
    tips: getTipsMessage(),
    vary: getVaryMessage()
  });
});

// ─── Search images ───────────────────────────────────
app.post('/search', async (req, res) => {
  try {
    const {
      query,
      site = 'all',
      page = 1,
      limit = 20,
      userId = null
    } = req.body;

    if (!query) {
      return res.status(400).json({
        error: 'Query required',
        hint: 'Try: "search blonde milf" or "find asian teen"',
        examples: AI_HINTS.expected.search.slice(0, 5)
      });
    }

    const results = await album.searchImages(query, {
      site, page, limit, userId
    });

    res.json({
      ...results,
      help: results.deduped ? AI_HINTS.varyPrompts.slice(0, 3) : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Download album ──────────────────────────────────
app.post('/album', async (req, res) => {
  try {
    const { url, title, concurrency } = req.body;
    if (!url) {
      return res.status(400).json({
        error: 'URL required',
        hint: 'Provide a gallery/album URL to download'
      });
    }

    const albumId = await album.downloadAlbum(url, { title, concurrency });
    const info = temp.getAlbumInfo(albumId);

    res.json({
      albumId,
      total: info.total,
      title: info.title,
      help: 'Use /album/:albumId/next to browse images. Say "next" for next pic, "prev" for previous.'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Search model album ──────────────────────────────
app.post('/model', async (req, res) => {
  try {
    const { username, concurrency } = req.body;
    if (!username) {
      return res.status(400).json({
        error: 'Username required',
        hint: 'Try: "model Riley Reid" or "model Lana Rhoades"'
      });
    }

    const result = await album.searchModelAlbum(username, { concurrency });
    const info = temp.getAlbumInfo(result.albumId);

    res.json({
      albumId: result.albumId,
      type: result.type,
      total: info.total,
      title: info.title,
      modelInfo: result.modelInfo || null,
      help: 'Use /album/:albumId/next to browse. "next" for more, "prev" to go back.'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Get next image from album ───────────────────────
app.get('/album/:albumId/next', (req, res) => {
  try {
    const { albumId } = req.params;
    const image = temp.getNextImage(albumId);

    if (!image) {
      return res.status(404).json({
        error: 'Album empty or finished',
        hint: 'Album complete! Search for something new or try a different album.'
      });
    }

    const imageUrl = `/temp/${path.basename(image.path)}`;
    res.json({
      imageId: image.id,
      url: imageUrl,
      fullUrl: `${BASE_URL}${imageUrl}`,
      index: image.index,
      total: image.total,
      size: image.size,
      remaining: image.total - image.index
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Get previous image from album ───────────────────
app.get('/album/:albumId/prev', (req, res) => {
  try {
    const { albumId } = req.params;
    const image = temp.getPrevImage(albumId);

    if (!image) {
      return res.status(404).json({
        error: 'Already at the beginning',
        hint: 'You\'re at the first image. Say "next" to go forward.'
      });
    }

    const imageUrl = `/temp/${path.basename(image.path)}`;
    res.json({
      imageId: image.id,
      url: imageUrl,
      fullUrl: `${BASE_URL}${imageUrl}`,
      index: image.index,
      total: image.total,
      size: image.size
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Get specific image by index ─────────────────────
app.get('/album/:albumId/:index', (req, res) => {
  try {
    const { albumId, index } = req.params;
    const idx = parseInt(index) - 1; // 1-based to 0-based
    const image = temp.getImageAt(albumId, idx);

    if (!image) {
      return res.status(404).json({
        error: 'Image not found',
        hint: `Album has images 1-${temp.getAlbumInfo(albumId)?.total || '?'}`
      });
    }

    const imageUrl = `/temp/${path.basename(image.path)}`;
    res.json({
      imageId: image.id,
      url: imageUrl,
      fullUrl: `${BASE_URL}${imageUrl}`,
      index: image.index,
      total: image.total,
      size: image.size
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Album info ──────────────────────────────────────
app.get('/album/:albumId/info', (req, res) => {
  try {
    const { albumId } = req.params;
    const info = temp.getAlbumInfo(albumId);

    if (!info) {
      return res.status(404).json({ error: 'Album not found' });
    }

    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Search GIFs ─────────────────────────────────────
app.get('/gif', async (req, res) => {
  try {
    const { q, limit = 5 } = req.query;
    if (!q) {
      return res.status(400).json({
        error: 'Query required',
        hint: 'Try: "gif boobs" or "gif blowjob"',
        timeGated: !gif.isGifTime()
      });
    }

    const results = await gif.search(q, { limit: parseInt(limit) });

    if (results.timeGated) {
      return res.status(403).json(results);
    }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Get video from PornHub URL ──────────────────────
app.post('/video', async (req, res) => {
  try {
    // Time gate check
    if (!gif.isGifTime()) {
      return res.status(403).json({
        error: 'Videos only available 9PM-4AM',
        message: gif.getTimeMessage()
      });
    }

    const { url, query } = req.body;

    if (url) {
      // Download specific video
      const result = await album.getVideoDownload(url);
      const fileUrl = `/temp/${result.fileId}.mp4`;
      res.json({
        ...result,
        url: fileUrl,
        fullUrl: `${BASE_URL}${fileUrl}`
      });
    } else if (query) {
      // Search for videos
      const results = await utils.phSearchVideos(query, 1);
      const videos = results.slice(0, 5).map(v => ({
        title: v.title,
        url: v.link,
        duration: v.duration,
        hd: v.hd,
        views: v.views,
        premium: v.premium
      }));

      res.json({
        videos,
        help: 'Reply with "video <url>" to download one. Max 32MB.'
      });
    } else {
      return res.status(400).json({
        error: 'URL or query required',
        hint: 'Try: "video <pornhub_url>" or "video milf"'
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Get file by ID ──────────────────────────────────
app.get('/file/:id', (req, res) => {
  try {
    const { id } = req.params;
    const file = temp.getFile(id);

    if (!file) {
      return res.status(404).json({ error: 'File not found or expired' });
    }

    const fileUrl = `/temp/${path.basename(file.path)}`;
    res.json({
      id,
      url: fileUrl,
      fullUrl: `${BASE_URL}${fileUrl}`,
      size: file.size,
      ext: file.ext,
      type: file.type || 'image'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Cleanup ─────────────────────────────────────────
app.post('/cleanup', (req, res) => {
  temp.cleanup();
  const stats = temp.getStats();
  res.json({ status: 'cleaned', ...stats });
});

// ─── 404 handler ─────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    availableEndpoints: [
      'GET  /status',
      'GET  /help',
      'GET  /hints',
      'POST /search  { query, site?, page?, limit?, userId? }',
      'POST /album   { url, title?, concurrency? }',
      'POST /model   { username, concurrency? }',
      'POST /video   { url? | query? }',
      'GET  /gif?q=<query>&limit=5',
      'GET  /album/:albumId/next',
      'GET  /album/:albumId/prev',
      'GET  /album/:albumId/:index',
      'GET  /album/:albumId/info',
      'GET  /file/:id',
      'POST /cleanup'
    ]
  });
});

// ─── Start server ────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🤖 Intelligent Scraper v2.0`);
  console.log(`📍 Running on port ${PORT}`);
  console.log(`🌐 Base URL: ${BASE_URL}`);
  console.log(`⏰ GIF/Video time: ${gif.isGifTime() ? 'ACTIVE ✅' : 'BLOCKED ❌ (9PM-4AM only)'}`);
  console.log(`📦 Max file size: 32MB (WhatsApp limit)`);
  console.log(`🧹 Auto-cleanup: every 5 minutes\n`);

  setInterval(() => {
    temp.cleanup();
    console.log(`🧹 Cleanup done — ${temp.getStats().fileCount} files, ${temp.getStats().albumCount} albums`);
  }, 300000);
});
