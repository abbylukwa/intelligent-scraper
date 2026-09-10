const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const pornhub = require('@justalk/pornhub-api');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://www.google.com/'
};

const MAX_FILE_SIZE = 32 * 1024 * 1024; // 32MB WhatsApp limit

// ─── Smart image URL filter ─────────────────────────
const BLOCKED_PATTERNS = [
  'logo', 'icon', 'avatar', 'thumb', 'banner', 'button',
  'pixel', 'tracking', 'spacer', 'blank', 'placeholder',
  '1x1', 'transparent', 'loading', 'preview_small'
];

const MIN_IMAGE_DIMENSIONS = { width: 200, height: 200 };

function isRealImage(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  // Must be an image extension
  if (!/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(lower)) return false;
  // Filter out UI elements
  for (const pattern of BLOCKED_PATTERNS) {
    if (lower.includes(pattern)) return false;
  }
  return true;
}

function normalizeUrl(url, baseUrl) {
  if (!url) return null;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) {
    try { return new URL(url, baseUrl).href; }
    catch { return null; }
  }
  if (url.startsWith('http')) return url;
  return null;
}

// ─── Fetch page ──────────────────────────────────────
async function fetchPage(url) {
  const response = await axios.get(url, {
    headers: HEADERS,
    timeout: 20000,
    maxRedirects: 5
  });
  return response.data;
}

// ─── Extract image URLs (smart) ──────────────────────
async function extractImageUrls(html, baseUrl) {
  const $ = cheerio.load(html);
  const urls = new Set();

  // <img> tags
  $('img').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') ||
                $(el).attr('data-original') || $(el).attr('data-lazy-src');
    const normalized = normalizeUrl(src, baseUrl);
    if (normalized && isRealImage(normalized)) urls.add(normalized);
  });

  // <a> links to images
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    const normalized = normalizeUrl(href, baseUrl);
    if (normalized && isRealImage(normalized)) urls.add(normalized);
  });

  // <source> tags (for <picture> elements)
  $('source[srcset], source[data-srcset]').each((i, el) => {
    const srcset = $(el).attr('srcset') || $(el).attr('data-srcset');
    if (srcset) {
      const parts = srcset.split(',');
      for (const part of parts) {
        const url = part.trim().split(' ')[0];
        const normalized = normalizeUrl(url, baseUrl);
        if (normalized && isRealImage(normalized)) urls.add(normalized);
      }
    }
  });

  // Background images in style attributes
  $('[style*="background"]').each((i, el) => {
    const style = $(el).attr('style') || '';
    const match = style.match(/url\(['"]?([^'"()]+)['"]?\)/);
    if (match) {
      const normalized = normalizeUrl(match[1], baseUrl);
      if (normalized && isRealImage(normalized)) urls.add(normalized);
    }
  });

  return [...urls];
}

// ─── Download image with size check ──────────────────
async function downloadImage(url, checkSize = true) {
  try {
    // HEAD request first to check size
    if (checkSize) {
      try {
        const head = await axios.head(url, {
          headers: HEADERS,
          timeout: 10000
        });
        const contentLength = parseInt(head.headers['content-length'] || '0');
        if (contentLength > MAX_FILE_SIZE) {
          console.log(`Skipping ${url}: ${(contentLength/1024/1024).toFixed(1)}MB > 32MB limit`);
          return null;
        }
      } catch (headErr) {
        // HEAD failed, try GET anyway
      }
    }

    const response = await axios.get(url, {
      headers: HEADERS,
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: MAX_FILE_SIZE,
      maxRedirects: 5
    });

    const buffer = Buffer.from(response.data);

    // Double-check size
    if (buffer.length > MAX_FILE_SIZE) {
      console.log(`Downloaded file too large: ${(buffer.length/1024/1024).toFixed(1)}MB`);
      return null;
    }

    // Determine extension
    let ext = path.extname(url).toLowerCase();
    if (!ext || ext.length > 5) {
      const contentType = response.headers['content-type'] || '';
      if (contentType.includes('webp')) ext = '.webp';
      else if (contentType.includes('png')) ext = '.png';
      else if (contentType.includes('gif')) ext = '.gif';
      else ext = '.jpg';
    }

    return { buffer, ext, size: buffer.length, url };
  } catch (e) {
    console.error('Download failed:', url, e.message);
    return null;
  }
}

// ─── PornHub API wrappers ────────────────────────────
async function phSearchVideos(query, page = 1) {
  try {
    const results = await pornhub.search(query, ['title', 'link', 'duration', 'hd', 'premium', 'views'], {
      page,
      search: 'video'
    });
    return results || [];
  } catch (e) {
    console.error('PH search error:', e.message);
    return [];
  }
}

async function phSearchGifs(query, page = 1) {
  try {
    const results = await pornhub.search(query, ['title', 'link_mp4', 'link_webm', 'thumbnail_url'], {
      page,
      search: 'gifs'
    });
    return results || [];
  } catch (e) {
    console.error('PH gif search error:', e.message);
    return [];
  }
}

async function phGetVideoDetails(url) {
  try {
    const details = await pornhub.page(url, [
      'title', 'download_urls', 'duration', 'views', 'pornstars',
      'categories', 'tags', 'thumbnail_url'
    ]);
    return details;
  } catch (e) {
    console.error('PH video details error:', e.message);
    return null;
  }
}

async function phGetModel(name, type = 'pornstar') {
  try {
    const details = await pornhub.model(name, [
      'title', 'rank_model', 'video_views', 'videos_watched'
    ]);
    return details;
  } catch (e) {
    console.error('PH model error:', e.message);
    return null;
  }
}

// ─── Download video from PornHub ─────────────────────
async function downloadPHVideo(downloadUrls) {
  if (!downloadUrls || typeof downloadUrls !== 'object') return null;

  // Try qualities from highest to lowest
  const qualities = ['1080', '720', '480', '360', '240'];
  for (const q of qualities) {
    const url = downloadUrls[q];
    if (!url) continue;

    try {
      // Check size first
      const head = await axios.head(url, {
        headers: HEADERS,
        timeout: 10000
      });
      const contentLength = parseInt(head.headers['content-length'] || '0');
      if (contentLength > MAX_FILE_SIZE) {
        console.log(`Quality ${q}: ${(contentLength/1024/1024).toFixed(1)}MB > 32MB, trying lower`);
        continue;
      }

      const response = await axios.get(url, {
        headers: HEADERS,
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: MAX_FILE_SIZE,
        maxRedirects: 5
      });

      const buffer = Buffer.from(response.data);
      if (buffer.length <= MAX_FILE_SIZE) {
        return { buffer, ext: '.mp4', size: buffer.length, quality: q };
      }
    } catch (e) {
      console.log(`Quality ${q} failed:`, e.message);
    }
  }
  return null;
}

module.exports = {
  HEADERS, MAX_FILE_SIZE, BLOCKED_PATTERNS,
  fetchPage, extractImageUrls, downloadImage,
  isRealImage, normalizeUrl,
  phSearchVideos, phSearchGifs, phGetVideoDetails, phGetModel,
  downloadPHVideo
};
