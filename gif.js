const axios = require('axios');
const utils = require('./utils');

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
async function searchRedditGifs(query, nsfw) {
    /* v2.8.2: nsfw requests add include_over_18=on so results are
     * actually adult instead of default-mixed. */
    const url = `https://old.reddit.com/search.json?q=${encodeURIComponent(query)}+gif&limit=10${nsfw ? '&include_over_18=on' : ''}`;
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
async function search(query, diag, opts = {}) {
    const nsfw = !!(opts && opts.nsfw);
    console.log(`[GIF] Searching "${query}"${nsfw ? ' (nsfw)' : ''}`);
    /* v2.6 MERGE-ALL: the old first-hit return meant one weak source
     * (tenor HTML → 1 gif) starved the others. All sources now run and
     * merge, deduped — the bot still downloads the first that works. */
    /* v2.8.2 NO-SFW-FALLBACK ON NSFW: Tenor and Giphy BAN adult content —
     * for an explicit NSFW gif request they can only return memes/clean
     * loops (the "wrong files" class). When the caller flags the query
     * NSFW, the general SFW gif engines are SKIPPED entirely — reddit
     * (unfiltered, +over18) stays, and the caller's my_links adult gif
     * slots still lead the list. */
    const sources = nsfw ? [searchRedditGifs] : [searchTenor, searchGiphyScrape, searchRedditGifs];
    const names = nsfw ? ['reddit'] : ['tenor', 'giphy', 'reddit'];
    const all = [];
    await Promise.all(sources.map(async (fn, i) => {
        try {
            const r = await fn(query, nsfw);
            const clean = (r || []).filter(Boolean);
            if (diag) diag[names[i]] = clean.length;
            all.push(...clean);
        } catch (e) {
            if (diag) diag[names[i]] = 0;
            console.error(`[GIF] ${fn.name} failed:`, e.message);
        }
    }));
    const merged = [...new Set(all)];
    /* v2.8 SLUG RELEVANCE: tenor/giphy pages embed related + trending
     * sections — the bot used to lead with a mexican-food gif for
     * "ebony". Dedupe by media id and rank on-topic slugs first. */
    const final = utils.relevantGifs(merged, query);
    console.log(`[GIF] "${query}" → ${merged.length} raw → ${final.length} on-topic gif(s)`);
    return final;
}

module.exports = { search };
