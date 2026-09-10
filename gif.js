const axios = require('axios');
const utils = require('./utils');

// Time gate: GIFs/videos only available 9PM-4AM (Harare time = UTC+2)
function isGifTime() {
  const now = new Date();
  const hour = now.getUTCHours() + 2; // Harare is UTC+2
  const adjustedHour = hour >= 24 ? hour - 24 : hour;
  // 9PM (21) to 4AM (4) - wraps around midnight
  return adjustedHour >= 21 || adjustedHour < 4;
}

function getTimeMessage() {
  return '⏰ *GIFs & Videos* are only available between *9 PM and 4 AM* (Harare time).\nTry again during those hours! 🌙';
}

// ─── GIPHY ───────────────────────────────────────────
async function searchGiphy(query, limit = 5) {
  const giphyUrl = `https://api.giphy.com/v1/gifs/search?api_key=dc6zaTOxFJmzC&q=${encodeURIComponent(query)}&limit=${limit}`;
  try {
    const response = await axios.get(giphyUrl, { timeout: 10000 });
    const gifs = response.data.data.map(g => ({
      url: g.images.original.url,
      preview: g.images.fixed_height_small.url,
      title: g.title,
      source: 'giphy'
    }));
    return gifs;
  } catch (e) {
    console.error('GIPHY error:', e.message);
    return [];
  }
}

// ─── Tenor ────────────────────────────────────────────
async function searchTenor(query, limit = 5) {
  try {
    const url = `https://tenor.com/search/${encodeURIComponent(query.replace(/\s+/g, '-'))}-gifs`;
    const html = await utils.fetchPage(url);
    const gifs = [];
    // Tenor stores GIF URLs in data attributes
    const matches = html.match(/https?:\/\/media\.tenor\.com\/[^"'\s]+\.(gif|mp4)/gi);
    if (matches) {
      const unique = [...new Set(matches)];
      for (const u of unique.slice(0, limit)) {
        gifs.push({ url: u, source: 'tenor' });
      }
    }
    return gifs;
  } catch (e) {
    console.error('Tenor error:', e.message);
    return [];
  }
}

// ─── PornHub GIFs ─────────────────────────────────────
async function searchPHGifs(query, limit = 5) {
  try {
    const results = await utils.phSearchGifs(query, 1);
    return results.slice(0, limit).map(g => ({
      url: g.link_mp4 || g.link_webm,
      preview: g.thumbnail_url,
      title: g.title,
      source: 'pornhub'
    }));
  } catch (e) {
    console.error('PH GIF error:', e.message);
    return [];
  }
}

// ─── RedGIFs ──────────────────────────────────────────
async function searchRedGifs(query, limit = 5) {
  try {
    const url = `https://www.redgifs.com/browse?search=${encodeURIComponent(query)}`;
    const html = await utils.fetchPage(url);
    const gifs = [];
    const matches = html.match(/https?:\/\/[^"'\s]*redgifs\.com\/[^"'\s]*\.(mp4|gif)/gi);
    if (matches) {
      for (const u of [...new Set(matches)].slice(0, limit)) {
        gifs.push({ url: u, source: 'redgifs' });
      }
    }
    return gifs;
  } catch (e) {
    console.error('RedGIFs error:', e.message);
    return [];
  }
}

// ─── Main search (aggregates all sources) ─────────────
async function search(query, options = {}) {
  const { limit = 5, sources = ['giphy', 'tenor', 'pornhub', 'redgifs'] } = options;

  // Time gate check
  if (!isGifTime()) {
    return { gifs: [], timeGated: true, message: getTimeMessage() };
  }

  const promises = [];
  if (sources.includes('giphy')) promises.push(searchGiphy(query, limit));
  if (sources.includes('tenor')) promises.push(searchTenor(query, limit));
  if (sources.includes('pornhub')) promises.push(searchPHGifs(query, limit));
  if (sources.includes('redgifs')) promises.push(searchRedGifs(query, limit));

  const results = await Promise.allSettled(promises);
  const allGifs = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      allGifs.push(...r.value);
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  const unique = allGifs.filter(g => {
    if (seen.has(g.url)) return false;
    seen.add(g.url);
    return true;
  });

  return {
    gifs: unique.slice(0, limit),
    timeGated: false,
    total: unique.length
  };
}

module.exports = { search, isGifTime, getTimeMessage };
