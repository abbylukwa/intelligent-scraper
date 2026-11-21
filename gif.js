const axios = require('axios');
const utils = require('./utils');

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

// ─── MyLinks GIF sources (prioritized) ───────────────────
async function searchMyLinksGifs(query, myLinks) {
    const gifs = [];
    if (!myLinks || !Array.isArray(myLinks)) return gifs;
    for (const link of myLinks) {
        if (link.type !== 'gif' || !link.enabled) continue;
        try {
            const url = link.url.includes('{query}') 
                ? link.url.replace('{query}', encodeURIComponent(query))
                : link.url;
            const html = await utils.fetchPage(url);
            const found = utils.extractImageUrls(html, url)
                .filter(u => /\.(gif|gifv|mp4|webm)$/i.test(u));
            if (found.length > 0) {
                gifs.push(...found.slice(0, 5));
            }
        } catch (e) {
            console.error(`[GIF] MyLinks "${link.name}" error:`, e.message);
        }
    }
    return gifs;
}

// ─── PornHub GIF scraper (custom) ────────────────────────
async function searchPornHubGifs(query) {
    const url = `https://www.pornhub.com/gifs/search?search=${encodeURIComponent(query)}`;
    try {
        const response = await axios.get(url, { headers: HEADERS, timeout: 15000 });
        const html = response.data;
        const matches = html.match(/https:\/\/[^"']*\.pornhub[^"']*\.(gif|mp4|webm)/gi) || [];
        const unique = [...new Set(matches)];
        if (unique.length > 0) return unique.slice(0, 10);
    } catch (e) {
        console.error('[GIF] PornHub error:', e.message);
    }
    return [];
}

// ─── DarkNaija GIF/video scraper ─────────────────────────
async function searchDarkNaijaGifs(query) {
    const url = `https://darknaija.com/?s=${encodeURIComponent(query)}`;
    try {
        const response = await axios.get(url, { headers: HEADERS, timeout: 15000 });
        const html = response.data;
        const gifs = utils.extractImageUrls(html, url)
            .filter(u => /\.(gif|gifv|mp4|webm)$/i.test(u));
        if (gifs.length > 0) return gifs.slice(0, 10);
    } catch (e) {
        console.error('[GIF] DarkNaija error:', e.message);
    }
    return [];
}

// ─── Fallback: Reddit GIF search (NSFW only) ─────────────
async function searchRedditGifs(query, nsfw) {
    if (!nsfw) return []; // Skip on SFW queries
    const url = `https://old.reddit.com/search.json?q=${encodeURIComponent(query)}+gif&limit=10&include_over_18=on`;
    try {
        const response = await axios.get(url, { headers: HEADERS, timeout: 15000 });
        const posts = response.data?.data?.children || [];
        const gifs = posts
            .map(p => p.data.url)
            .filter(url => /\.(gif|gifv)$/i.test(url));
        if (gifs.length > 0) return gifs.slice(0, 10);
    } catch (e) {
        console.error('[GIF] Reddit error:', e.message);
    }
    return [];
}

// ─── Main search — priority to custom sources ────────────
async function search(query, diag, opts = {}) {
    const nsfw = !!(opts && opts.nsfw);
    const myLinks = opts.myLinks || [];
    console.log(`[GIF] Searching "${query}"${nsfw ? ' (nsfw)' : ''}`);
    
    const all = [];

    // 1. Try MyLinks GIF slots FIRST (prioritized)
    if (myLinks.length > 0) {
        try {
            const myGifs = await searchMyLinksGifs(query, myLinks);
            if (diag) diag['mylinks_gifs'] = myGifs.length;
            all.push(...myGifs);
        } catch (e) {
            if (diag) diag['mylinks_gifs'] = 0;
            console.error('[GIF] MyLinks batch failed:', e.message);
        }
    }

    // 2. Custom sources (always run on NSFW)
    if (nsfw) {
        const customSources = [
            { fn: searchPornHubGifs, name: 'pornhub' },
            { fn: searchDarkNaijaGifs, name: 'darknaija' }
        ];
        
        await Promise.all(customSources.map(async (src) => {
            try {
                const r = await src.fn(query);
                const clean = (r || []).filter(Boolean);
                if (diag) diag[src.name] = clean.length;
                all.push(...clean);
            } catch (e) {
                if (diag) diag[src.name] = 0;
                console.error(`[GIF] ${src.name} failed:`, e.message);
            }
        }));

        // 3. Reddit fallback (NSFW only)
        try {
            const redditGifs = await searchRedditGifs(query, nsfw);
            if (diag) diag['reddit'] = redditGifs.length;
            all.push(...redditGifs);
        } catch (e) {
            if (diag) diag['reddit'] = 0;
            console.error('[GIF] Reddit fallback failed:', e.message);
        }
    }

    const merged = [...new Set(all)];
    const final = utils.relevantGifs(merged, query);
    console.log(`[GIF] "${query}" → ${merged.length} raw → ${final.length} on-topic gif(s)`);
    return final;
}

module.exports = { search };
