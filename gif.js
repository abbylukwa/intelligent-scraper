const axios = require('axios');

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

// ─── Primary: Tenor (no key needed) ───────────────────────
async function searchTenor(query) {
    const url = `https://tenor.com/search/${encodeURIComponent(query)}-gifs`;
    try {
        const response = await axios.get(url, { headers: HEADERS, timeout: 15000 });
        const html = response.data;
        // Tenor embeds .gif URLs in the page
        const matches = html.match(/https:\/\/media\.tenor\.com\/[^"']+\.gif/g) || [];
        const unique = [...new Set(matches)];
        if (unique.length > 0) return unique.slice(0, 10);
    } catch (e) {
        console.error('Tenor error:', e.message);
    }
    return [];
}

// ─── Fallback: GIPHY public search page ──────────────────
async function searchGiphyScrape(query) {
    const url = `https://giphy.com/search/${encodeURIComponent(query)}`;
    try {
        const response = await axios.get(url, { headers: HEADERS, timeout: 15000 });
        const html = response.data;
        const matches = html.match(/https:\/\/media\d*\.giphy\.com\/media\/[^"']+\.gif/g) || [];
        const unique = [...new Set(matches)];
        if (unique.length > 0) return unique.slice(0, 10);
    } catch (e) {
        console.error('GIPHY scrape error:', e.message);
    }
    return [];
}

// ─── Fallback: Reddit GIF search ─────────────────────────
async function searchRedditGifs(query) {
    const url = `https://old.reddit.com/search.json?q=${encodeURIComponent(query)}+gif&limit=10`;
    try {
        const response = await axios.get(url, { headers: HEADERS, timeout: 15000 });
        const posts = response.data?.data?.children || [];
        const gifs = posts
            .map(p => p.data.url)
            .filter(url => /\.(gif|gifv)$/i.test(url));
        if (gifs.length > 0) return gifs.slice(0, 10);
    } catch (e) {
        console.error('Reddit GIF error:', e.message);
    }
    return [];
}

// ─── Main search — try all sources ────────────────────────
async function search(query) {
    console.log(`[GIF] Searching "${query}"`);
    const sources = [searchTenor, searchGiphyScrape, searchRedditGifs];
    for (const fn of sources) {
        const results = await fn(query);
        if (results.length > 0) {
            console.log(`[GIF] Found ${results.length} from ${fn.name}`);
            return results;
        }
    }
    console.log(`[GIF] No results from any source`);
    return [];
}

module.exports = { search };
