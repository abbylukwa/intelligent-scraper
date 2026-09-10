const utils = require('./utils');
const temp = require('./temp');
const pLimit = require('p-limit');
const NodeCache = require('node-cache');

// ─── Caches ──────────────────────────────────────────
const searchCache = new NodeCache({ stdTTL: 600, checkperiod: 120 }); // 10 min
const albumCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 }); // 30 min
const dedupCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 }); // 24h dedup

// ─── Album URL mappings ──────────────────────────────
const ALBUM_MAP = {
  'darknaija': 'https://darknaija.com',
  'pornpics': 'https://www.pornpics.com',
  'sexcom': 'https://www.sex.com',
  'imagefap': 'https://www.imagefap.com',
  'nudevista': 'https://www.nudevista.com',
  'porngifs': 'https://www.redgifs.com',
};

// ─── Search history per user (for dedup) ─────────────
const userSearchHistory = new Map(); // userId -> Set of query hashes

function getQueryHash(query) {
  return require('crypto').createHash('md5').update(query.toLowerCase().trim()).digest('hex');
}

function isDuplicateQuery(userId, query) {
  const hash = getQueryHash(query);
  if (!userSearchHistory.has(userId)) {
    userSearchHistory.set(userId, new Set());
  }
  const history = userSearchHistory.get(userId);
  if (history.has(hash)) return true;
  history.add(hash);
  // Keep last 100 queries
  if (history.size > 100) {
    const arr = [...history];
    history.clear();
    arr.slice(-99).forEach(h => history.add(h));
  }
  return false;
}

// ─── Smart search across multiple sites ──────────────
async function searchImages(query, options = {}) {
  const {
    site = 'all',
    page = 1,
    limit = 20,
    userId = null,
    production = null, // 'homemade' | 'professional'
    minDuration = null,
    maxDuration = null
  } = options;

  if (!query) throw new Error('Query required');

  // Check dedup
  if (userId && isDuplicateQuery(userId, query)) {
    return {
      images: [],
      deduped: true,
      message: '🔄 You already searched this! Try a different query or add details.\n\n💡 *Tip:* Add words like "blonde", "outdoor", "closeup", "amateur" to get different results.'
    };
  }

  // Check cache
  const cacheKey = `search:${query}:${site}:${page}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    return { images: cached, cached: true, total: cached.length };
  }

  const attempts = [];

  if (site === 'all' || site === 'darknaija') {
    attempts.push({
      site: 'darknaija',
      url: `https://darknaija.com/?s=${encodeURIComponent(query)}`,
      extractor: 'cheerio'
    });
  }

  if (site === 'all' || site === 'pornpics') {
    attempts.push({
      site: 'pornpics',
      url: `https://www.pornpics.com/search/?q=${encodeURIComponent(query)}`,
      extractor: 'cheerio'
    });
  }

  if (site === 'all' || site === 'sexcom') {
    attempts.push({
      site: 'sexcom',
      url: `https://www.sex.com/search/${encodeURIComponent(query.replace(/\s+/g, '-'))}/`,
      extractor: 'cheerio'
    });
  }

  if (site === 'all' || site === 'imagefap') {
    attempts.push({
      site: 'imagefap',
      url: `https://www.imagefap.com/gallery.php?search=${encodeURIComponent(query)}`,
      extractor: 'cheerio'
    });
  }

  // PornHub image search via video thumbnails
  if (site === 'all' || site === 'pornhub') {
    attempts.push({
      site: 'pornhub',
      url: null, // Uses API
      extractor: 'pornhub_api'
    });
  }

  const allImages = [];

  for (const attempt of attempts) {
    try {
      let imageUrls = [];

      if (attempt.extractor === 'pornhub_api') {
        const phResults = await utils.phSearchVideos(query, page);
        imageUrls = phResults
          .filter(v => v.link)
          .map(v => v.link);
        // Also get thumbnails
        const thumbUrls = phResults
          .filter(v => v.thumbnail_url)
          .map(v => v.thumbnail_url);
        imageUrls = [...imageUrls, ...thumbUrls];
      } else {
        const html = await utils.fetchPage(attempt.url);
        imageUrls = await utils.extractImageUrls(html, attempt.url);
      }

      // Filter and deduplicate
      const valid = imageUrls.filter(url => utils.isRealImage(url));
      for (const url of valid) {
        if (!dedupCache.get(url)) {
          dedupCache.set(url, true);
          allImages.push({
            url,
            source: attempt.site,
            query
          });
        }
      }
    } catch (e) {
      console.error(`${attempt.site} search error:`, e.message);
    }
  }

  // Limit results
  const results = allImages.slice(0, limit);

  // Cache results
  searchCache.set(cacheKey, results);

  return {
    images: results,
    total: allImages.length,
    sources: [...new Set(results.map(r => r.source))],
    page
  };
}

// ─── Download album from URL ─────────────────────────
async function downloadAlbum(albumUrlOrKeyword, options = {}) {
  const { concurrency = 3, title = '' } = options;

  let albumUrl = albumUrlOrKeyword;

  // Check keyword mappings
  if (albumUrlOrKeyword in ALBUM_MAP) {
    albumUrl = ALBUM_MAP[albumUrlOrKeyword];
  }

  // Check cache
  const cacheKey = `album:${albumUrl}`;
  const cached = albumCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const html = await utils.fetchPage(albumUrl);
  const imageUrls = await utils.extractImageUrls(html, albumUrl);

  if (imageUrls.length === 0) {
    throw new Error('No images found in album');
  }

  // Download with concurrency limit
  const limit = pLimit(concurrency);
  const downloadPromises = imageUrls.map(url =>
    limit(() => utils.downloadImage(url, true))
  );

  const results = await Promise.allSettled(downloadPromises);
  const valid = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  if (valid.length === 0) {
    throw new Error('No images could be downloaded (all exceeded 32MB or failed)');
  }

  const albumId = temp.saveAlbum(valid, {
    title: title || new URL(albumUrl).hostname,
    source: albumUrl
  });

  // Cache the album ID
  albumCache.set(cacheKey, albumId);

  return albumId;
}

// ─── Search and download album by model/username ──────
async function searchModelAlbum(username, options = {}) {
  const { concurrency = 3 } = options;

  // Try PornHub model first
  try {
    const model = await utils.phGetModel(username, 'pornstar');
    if (model) {
      // Search for model's videos
      const videos = await utils.phSearchVideos(username, 1);
      if (videos.length > 0) {
        // Download thumbnails as album
        const images = [];
        for (const v of videos.slice(0, 20)) {
          if (v.thumbnail_url) {
            const img = await utils.downloadImage(v.thumbnail_url, true);
            if (img) images.push(img);
          }
        }
        if (images.length > 0) {
          const albumId = temp.saveAlbum(images, {
            title: `${username} - PornHub Model`,
            source: 'pornhub_model'
          });
          return { albumId, modelInfo: model, type: 'pornhub_model' };
        }
      }
    }
  } catch (e) {
    console.error('PH model search error:', e.message);
  }

  // Try searching across sites for the username
  const searchResults = await searchImages(username, { limit: 30 });
  if (searchResults.images.length > 0) {
    const limit = pLimit(concurrency);
    const downloadPromises = searchResults.images.map(img =>
      limit(() => utils.downloadImage(img.url, true))
    );
    const results = await Promise.allSettled(downloadPromises);
    const valid = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    if (valid.length > 0) {
      const albumId = temp.saveAlbum(valid, {
        title: `${username} - Album`,
        source: 'multi_source'
      });
      return { albumId, type: 'search_album' };
    }
  }

  throw new Error(`No content found for model/username: ${username}`);
}

// ─── Get video download URL from PornHub ─────────────
async function getVideoDownload(phUrl) {
  try {
    const details = await utils.phGetVideoDetails(phUrl);
    if (!details || !details.download_urls) {
      throw new Error('Could not get video details');
    }

    const videoData = await utils.downloadPHVideo(details.download_urls);
    if (!videoData) {
      throw new Error('Video too large (>32MB) or download failed');
    }

    const fileId = temp.saveFile(videoData.buffer, videoData.ext, {
      type: 'video',
      quality: videoData.quality,
      title: details.title
    });

    return {
      fileId,
      title: details.title,
      duration: details.duration,
      quality: videoData.quality,
      size: videoData.size,
      views: details.views
    };
  } catch (e) {
    throw new Error(`Video download failed: ${e.message}`);
  }
}

module.exports = {
  ALBUM_MAP,
  searchImages,
  downloadAlbum,
  searchModelAlbum,
  getVideoDownload,
  isDuplicateQuery,
  getQueryHash
};
