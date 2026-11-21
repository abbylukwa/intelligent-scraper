'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');

const album = require('./album');
const temp = require('./temp');
const media = require('./media');

const app = express();
const PORT = process.env.PORT || 10000;

// ═══════════════════════════════════════════════════════════════
// v3.0 MYLINKS-ONLY — ZERO BUILT-IN SOURCES
// Every endpoint is driven EXCLUSIVELY by the slots the owner
// configures. There are NO hardcoded websites, NO fallback
// engines and NO emergency chains anywhere in this codebase.
//   1. my_links.json (HOT-RELOADED — edit the file, the very next
//      search uses it. NO restart needed.)
//   2. MYLINKS env var — "url1, url2" (set on this service OR on
//      the bot — the bot forwards its own MYLINKS with every search)
//   3. per-request: POST /search {"myLinks": ["https://..."]}
// Slot types: 'image' | 'gif' | 'video' | 'music'.
// Empty config = honest "no sources configured" answers.
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const axios = require('axios');
const utils = require('./utils');
const MY_LINKS_FILE = path.join(__dirname, 'my_links.json');

let MY_LINKS = [];
let MY_LINKS_MTIME = -1;
function loadMyLinks(force){
    try {
        const st = fs.existsSync(MY_LINKS_FILE) ? fs.statSync(MY_LINKS_FILE) : null;
        const mtime = st ? st.mtimeMs : 0;
        if (!force && mtime === MY_LINKS_MTIME) return;
        MY_LINKS_MTIME = mtime;
        if (!st){ MY_LINKS = []; return; }
        const raw = JSON.parse(fs.readFileSync(MY_LINKS_FILE, 'utf8'));
        MY_LINKS = Array.isArray(raw.links) ? raw.links.filter(l => l && l.url) : [];
        console.log(`MY LINKS: loaded ${MY_LINKS.length} slot(s) from my_links.json (hot-reload on)`);
    } catch (e) {
        console.error('MY LINKS: could not parse my_links.json —', e.message);
    }
}
loadMyLinks(true);

const MY_LINKS_ENV = String(process.env.MYLINKS || '')
    .split(/[\n,]+/).map(s => s.trim())
    .filter(s => /^https?:\/\//i.test(s))
    .filter((s, i, a) => a.indexOf(s) === i)
    .map((s, i) => ({ slot: 'env-' + (i + 1), name: 'env slot ' + (i + 1), url: s,
                      type: /\.gif(\?|$)/i.test(s) ? 'gif' : 'image', enabled: true, source: 'env' }));
if (MY_LINKS_ENV.length) console.log(`MY LINKS: +${MY_LINKS_ENV.length} slot(s) from MYLINKS env`);

/* per-slot diagnostics — open /my-links to SEE which of your sites
 * really return media and which are JS-walled (0 results) */
const MY_LINK_DIAG = new Map();
function diagRecord(key, count, error){
    MY_LINK_DIAG.set(key, { ts: new Date().toISOString(), count: count || 0, error: error || null });
}

/* v4.6: human name from a URL — request slots used to be listed as
 * "undefined — bot-link-N" garbage in the site picker (135 of them when
 * the bot forwards its whole registry). A hostname tells the owner WHAT
 * the slot actually is. */
function hostnameName(url, fallback){
    try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch (e) { return fallback; }
}

function getMyLinks(type, extraLinks, extraType){
    loadMyLinks(false);
    const fileSlots = MY_LINKS.map(l => Object.assign({ source: 'file' }, l));
    let slots = fileSlots.concat(MY_LINKS_ENV);
    if (Array.isArray(extraLinks) && extraLinks.length){
        const t = extraType || type;
        const reqSlots = extraLinks.map((l, i) => {
            if (typeof l === 'string')
                return { url: l, type: t, name: hostnameName(l, 'bot-link-' + (i + 1)), source: 'request' };
            return (l && l.url) ? Object.assign({ source: 'request', type: t }, l,
                        { name: l.name || hostnameName(l.url, 'bot-link-' + (i + 1)) }) : null;
        }).filter(Boolean);
        /* v4.6: per-request links still LEAD the search order — but a
         * request slot whose URL is already a file slot is dropped in
         * favour of the file slot (same site, same search, and the real
         * name like "YonaYethuu (SA HD Videos)" survives for the lists). */
        const fileUrls = new Set(fileSlots
            .filter(l => String(l.type || 'image') === t)
            .map(l => String(l.url || '')));
        slots = reqSlots.filter(l => !fileUrls.has(String(l.url || ''))).concat(slots);
    }
    const seenUrls = new Set();
    return slots
        .filter(l => (l.enabled !== false) && String(l.type || 'image') === type)
        .filter(l => { const u = String(l.url || ''); if (seenUrls.has(u)) return false; seenUrls.add(u); return true; });
}

// Build the real URL to fetch for a custom link + search word.
//   • a link WITH a path is a pinned CATEGORY page → fetched AS-IS
//   • a bare domain gets ?s=<query> appended
//   • {query} templates are replaced
function myLinkUrl(link, query) {
    const q = encodeURIComponent(query || '');
    const u = String(link.url || '');
    if (u.includes('{query}')) return u.replace(/\{query\}/g, q);
    try {
        const pu = new URL(u);
        const segs = pu.pathname.split('/').filter(Boolean);
        /* pinned category page: keep it as-is (search word already in path) */
        if (segs.length >= 1 && !/[?&]s=$/.test(u)) return u;
    } catch (e) {}
    return u + (u.includes('?') ? '&' : '?') + 's=' + q;
}

const NO_SOURCES_HINT = 'No sources configured. Add your links: my_links.json (hot-reloaded, no restart) / MYLINKS env var ("url1, url2") / per-request myLinks parameter. Slot types: image, gif, video, music.';

/* v3.1: video slots must follow FILE order (owner pins the priority —
 * YonaYethuu first) even when the bot forwards the same URLs as env /
 * per-request slots (those would otherwise lead and break the order).
 * Slots that exist in the file sort by their file position; request-
 * only slots append after them in arrival order. */
function sortSlotsByFileOrder(slots, type){
    loadMyLinks(false);
    const fileOrder = new Map();
    MY_LINKS.forEach((l, i) => { if (String(l.type || 'image') === type) fileOrder.set(String(l.url), i); });
    return slots
        .map((s, i) => ({ s, rank: fileOrder.has(String(s.url)) ? fileOrder.get(String(s.url)) : 1000 + i }))
        .sort((a, b) => a.rank - b.rank)
        .map(x => x.s);
}

/* v3.1: pick one video slot by name piece, slot number or url piece.
 * "yona" / "pornpics" work as substrings; a PURE-NUMBER pick ("2")
 * matches the file slot number OR the /video-sites list position —
 * never a URL substring (IPs/ports would false-match). Returns
 * { slots, available } — available = the enabled choices for errors. */
/* v4.6: word similarity — typos still find the site
 * ("yonalethu" ≈ "yonayethuu", 0.8 similarity → matches). */
function levenshtein(a, b){
    const m = a.length, n = b.length;
    let prev = new Array(n + 1).fill(0).map((_, i) => i);
    for (let i = 1; i <= m; i++){
        const cur = [i];
        for (let j = 1; j <= n; j++){
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[n];
}
function similarity(a, b){
    if (!a || !b) return 0;
    if (a === b) return 1;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function filterVideoSlots(slots, site){
    /* v4.6: the user-facing list is DEDUPED by URL (the bot forwards its
     * whole registry, so raw slots had 100+ near-duplicates), named after
     * the hostname when unnamed, and numbered by LIST POSITION — the
     * same numbers /video-sites shows, so site:<n> always picks what the
     * user actually saw. */
    const seen = new Set(); const available = [];
    for (const s of slots){
        const key = String(s.url || '');
        if (seen.has(key)) continue;
        seen.add(key);
        available.push({ pick: available.length + 1, slot: s.slot, name: s.name || s.url, url: s.url });
    }
    if (!site) return { slots, available };
    const pick = String(site).trim().toLowerCase();
    if (!pick) return { slots, available };
    if (/^\d+$/.test(pick)) {
        const num = parseInt(pick, 10);
        const byPick = available[num - 1];
        return { slots: slots.filter(s => Number(s.slot) === num || (byPick && String(s.url) === String(byPick.url))), available };
    }
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const p = norm(pick);
    if (!p) return { slots: [], available };
    const matched = slots.filter(s =>
        norm(s.name).includes(p) || String(s.url || '').toLowerCase().includes(pick));
    if (matched.length) return { slots: matched, available };
    /* v4.6 FUZZY FALLBACK: no exact hit → score the pick against every
     * site name and hostname; best ≥ 0.6 wins ("yonalethu" → YonaYethuu).
     * The TLD is stripped first — "yona-yethuu.co.za" must score like
     * "yonayethuu", not drown in "coza" noise. */
    let best = null, bestScore = 0;
    for (const a of available){
        const host = hostnameName(a.url, '').replace(/\.[a-z]{2,7}(\.[a-z]{2,7})?$/i, '');
        for (const cand of [a.name, host]){
            const sim = similarity(p, norm(cand));
            if (sim > bestScore){ bestScore = sim; best = a; }
        }
    }
    if (best && bestScore >= 0.6)
        return { slots: slots.filter(s => String(s.url) === String(best.url)), available,
                 fuzzy: { picked: best.name, score: Math.round(bestScore * 100) / 100 } };
    return { slots: [], available };
}

// Try every enabled custom link of `type`; returns an array of direct
// media URLs found. A dead link NEVER breaks a search — each slot
// fails independently, is skipped and logged.
async function tryMyLinks(query, type, extraLinks, opts = {}) {
    let slots = (opts && opts.slots) || getMyLinks(type, extraLinks);
    /* v4.7.7: generic per-slot targeting (site:<number|name>) — the bot
     * can pin a search to ONE slot for any media kind, and /test-site
     * reports per-slot truth for images/gifs/music too. */
    if (opts && opts.site != null && opts.site !== 'auto'){
        const pick = String(opts.site).trim();
        if (/^\d+$/.test(pick)) slots = slots.filter(s => String(s.slot) === pick);
        else {
            const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const p = norm(pick);
            const hit = slots.filter(s => norm(s.name).includes(p) || String(s.url).toLowerCase().includes(pick.toLowerCase()));
            if (hit.length) slots = hit;
        }
    }
    if (!slots.length) return [];
    const found = [];
    await Promise.all(slots.map(async (link) => {
        try {
            const url = myLinkUrl(link, query);
            /* JSON SLOTS: a slot pointing at a .json API endpoint is
             * PARSED as JSON — regex-on-HTML finds nothing because JSON
             * has no <img> tags. Standard search.json result shape. */
            if (/\.json(\?|#|$)/i.test(url)) {
                const r = await axios.get(url, {
                    headers: { 'User-Agent': 'mozilla/5.0 breadbot-scraper/3.0', 'Accept': 'application/json' },
                    timeout: 15000 });
                const children = r.data?.data?.children || [];
                const urls = [];
                for (const c of children){
                    const d = c.data || {};
                    const u = d.url_overridden_by_dest || '';
                    if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(u)) urls.push(u);
                    const pv = d.preview?.images?.[0]?.source?.url || '';
                    if (pv) urls.push(pv.replace(/&amp;/g, '&'));
                }
                const clean = [...new Set(urls)].filter(u => !utils.isJunkImageUrl(u)).slice(0, 30);
                diagRecord(String(link.url), clean.length, clean.length ? null : '0 media in JSON');
                if (clean.length) console.log(`MY LINKS (json): "${link.name || link.url}" → ${clean.length} ${type}(s)`);
                found.push(...clean);
                return;
            }
            /* v4.7.7: extraction as a closure — the SAME logic runs on
             * the static HTML and again after a render-through. */
            const extractFrom = (html) => {
                let urls = [];
                if (type === 'gif') {
                    /* v3.1: gif slots also extract .mp4/.webm loops — blog
                     * "gif" posts embed mp4 players, not .gif files. The bot
                     * sends both as video, so nothing breaks downstream. */
                    const matches = String(html).match(/https?:\/\/[^"'\s<>\\]+\.(?:gif|mp4|webm)(?:\?[^\s"'<>\\]*)?/gi) || [];
                    urls = matches.filter(u => !/replace-me|example\.com/i.test(u));
                    /* dedupe + rank on-topic slugs first (generic, no site logic) */
                    urls = utils.relevantGifs(urls, query);
                } else if (type === 'video' || type === 'music') {
                    /* list-only mode (used by /search-video & /search-music):
                     * direct media links straight off the page, no download */
                    const re = type === 'video'
                        ? /https?:\/\/[^\s"'<>\\]+\.(?:mp4|webm)[^\s"'<>\\]*/gi
                        : /https?:\/\/[^\s"'<>\\]+\.(?:mp3|m4a|ogg|wav|aac)(?:\?[^\s"'<>\\]*)?/gi;
                    urls = [...new Set((String(html).match(re) || []).map(u => u.replace(/&amp;/g, '&')))];
                } else {
                    urls = utils.extractImageUrls(String(html), url);
                    /* DAPI XML SLOTS: gelbooru-family dapi endpoints answer
                     * static XML with full-res originals in file_url="…" —
                     * no <img> tags, cheerio finds nothing. */
                    if (!urls.length) urls = utils.extractDapiFileUrls(String(html));
                }
                return urls;
            };
            /* v4.7.4: the 15s race cut the hardened ladder off mid-run
             * (challenge rounds need more) — 60s with the same guard. */
            const html = await Promise.race([
                utils.fetchPage(url),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 120000))
            ]);
            let urls = extractFrom(html);
            /* v4.7.7 APP-SHELL RENDER-THROUGH — JS-walled sites (beeg,
             * RedGIFs, SexGifs…) answer 200 with a framework shell that
             * passes every blocked check — static extraction reads "0
             * media". When the page looks like an SPA shell, re-render
             * the SAME url through the stealth browser (JS executes)
             * and extract once more. */
            if (!urls.length && utils.looksLikeAppShell(html)){
                try {
                    const html2 = await Promise.race([
                        utils.stealthFetchHTML(url),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('render timeout')), 240000))
                    ]);
                    urls = extractFrom(html2);
                    if (urls.length) console.log(`MY LINKS: "${link.name || link.url}" → RENDERED through stealth browser → ${urls.length} ${type}(s)`);
                } catch (e2) {
                    console.log(`MY LINKS: "${link.name || link.url}" render-through failed: ${e2.message}`);
                }
            }
            urls = [...new Set(urls)].slice(0, 30);
            diagRecord(String(link.url), urls.length, urls.length ? null : '0 media in static HTML (JS-walled?)');
            if (urls.length) console.log(`MY LINKS: "${link.name || link.url}" → ${urls.length} ${type}(s)`);
            else console.log(`MY LINKS: "${link.name || link.url}" → no ${type}s found (page may need JS)`);
            found.push(...urls);
        } catch (e) {
            diagRecord(String(link.url), 0, e.message);
            console.log(`MY LINKS: "${link.name || link.url}" skipped (${e.message}) — check /my-links diagnostics`);
        }
    }));
    return found;
}

// FIX: trust proxy so req.protocol is https behind Render's proxy
// (media URLs returned to the bot must be absolute https links)
app.set('trust proxy', true);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files
app.use('/temp', express.static(temp.TEMP_DIR));

// Health check endpoints
app.get('/status', (req, res) => {
    loadMyLinks(false);   /* keep the counts fresh (mtime hot-reload) */
    const stats = temp.getStats();
    res.json({
        status: 'ok',
        service: 'intelligent-scraper',
        version: '4.7.6',
        uptime: process.uptime(),
        tempFiles: stats.fileCount,
        tempSizeMB: Number(stats.totalSizeMB) || 0,
        maxDownloadMB: media.MAX_MB,
        builtInSources: 0,
        endpoints: [
            '/search',
            '/search-video',
            '/search-music',
            '/search-lyrics',
            '/album',
            '/gif',
            '/music',
            '/video',
            '/video-ranked',
            '/video-resolve',
            '/video-sites',
            '/download',
            '/cleanup',
            '/my-links'
        ],
        myLinks: {
            loaded: MY_LINKS.length,
            enabled: MY_LINKS.filter(l => l.enabled !== false).length,
            envSlots: MY_LINKS_ENV.length,
            hotReload: true,
            triedFirst: true,
            types: ['image', 'gif', 'video', 'music']
        }
    });
});

// MY LINKS status — live diagnostics for every slot you added
app.get('/my-links', (req, res) => {
    loadMyLinks(false);
    const diag = (url) => MY_LINK_DIAG.get(String(url)) || null;
    res.json({
        success: true,
        version: '4.7.6',
        howTo: 'MYLINKS-ONLY (zero built-in sites). THREE ways: (1) edit my_links.json — HOT-reloaded, next search uses it, no restart; (2) set MYLINKS env var "url1, url2" on this service OR on the bot (the bot forwards its own MYLINKS with every search); (3) POST /search {"myLinks":["https://..."]}. Types: image, gif, video, music. {query} template optional, enabled:false switches a slot off. A dead slot never breaks a search.',
        loaded: MY_LINKS.length,
        enabled: MY_LINKS.filter(l => l.enabled !== false).length,
        envSlots: MY_LINKS_ENV.map(l => l.url),
        links: MY_LINKS.map(l => Object.assign({}, l, { lastResult: diag(l.url) })),
        envLinkDiag: MY_LINKS_ENV.map(l => Object.assign({}, l, { lastResult: diag(l.url) }))
    });
});

// ─── GET / and /ping — cron-job.org keep-alive targets ────────
// v4.3.1: cron-job.org pings the ROOT url. There was no / route, so
// every ping got a 404 → "HTTP error" → the keep-alive job got
// DISABLED and Render went to sleep. Root and /ping now answer a tiny
// JSON (also fine for HEAD requests — no big output ever).
app.get('/', (req, res) => {
    res.json({ ok: true, service: 'intelligent-scraper', version: '4.7.6', hint: 'POST /search /video /video-ranked /video-resolve /music /download · GET /my-links /video-sites /health' });
});
app.get('/ping', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
});

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        service: 'intelligent-scraper'
    });
});

// ─── v82: Toggle site enable/disable ───
app.post('/toggle-site', (req, res) => {
    try {
        const { slot, enabled } = req.body || {};
        if (slot == null) return res.status(400).json({ ok: false, error: 'Missing slot' });
        loadMyLinks(true);
        const link = MY_LINKS.find(l => l.slot === parseInt(slot));
        if (!link) return res.status(404).json({ ok: false, error: 'Slot not found' });
        link.enabled = !!enabled;
        // Write back to my_links.json
        const raw = JSON.parse(fs.readFileSync(MY_LINKS_FILE, 'utf8'));
        const target = (raw.links || []).find(l => l.slot === parseInt(slot));
        if (target) target.enabled = !!enabled;
        fs.writeFileSync(MY_LINKS_FILE, JSON.stringify(raw, null, 2));
        console.log(`TOGGLE: slot #${slot} → ${enabled ? 'ON' : 'OFF'}`);
        res.json({ ok: true, slot: parseInt(slot), enabled: !!enabled });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── v82: Per-site test ───
app.post('/test-site', async (req, res) => {
    try {
        const { slot, query = 'test' } = req.body || {};
        if (slot == null) return res.status(400).json({ ok: false, error: 'Missing slot' });
        loadMyLinks(true);
        const link = MY_LINKS.find(l => l.slot === parseInt(slot));
        if (!link) return res.status(404).json({ ok: false, error: 'Slot not found' });
        const t0 = Date.now();
        // Try a quick search on this site
        const kind = link.type || 'image';
        const endpoint = kind === 'video' ? '/video' : kind === 'gif' ? '/gif' : kind === 'music' ? '/music' : '/search';
        const result = await axios.post(`http://localhost:${PORT}${endpoint}`, { query, site: String(slot) }, { timeout: 90000 });
        const ms = Date.now() - t0;
        /* v4.7.7: the endpoints do NOT share a body field (/search →
         * images, /video → videos, /gif → gifs) — the old code read
         * only `results` and every kind reported 0. All endpoints carry
         * `count`. */
        const payload = result.data || {};
        const list = payload.results || payload.videos || payload.gifs || payload.images || payload.music || [];
        const n = Number.isFinite(payload.count) ? payload.count : list.length;
        res.json({ ok: true, slot: parseInt(slot), name: link.name, type: kind, results: n, ms });
    } catch (e) {
        res.json({ ok: false, slot: req.body && req.body.slot, error: e.message, ms: 0 });
    }
});

// ─── Optional token auth ──────────────────────────────────────
// If SCRAPER_TOKEN is set here, data endpoints require the same token.
// If not set, everything stays open exactly as before.
const dataApi = express.Router();
dataApi.use((req, res, next) => {
    const token = process.env.SCRAPER_TOKEN;
    if (!token) return next();
    const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (provided === token) return next();
    return res.status(401).json({ error: 'Unauthorized — send Authorization: Bearer <SCRAPER_TOKEN>' });
});

// Search images — v3.0: EXCLUSIVELY from your MyLinks slots
app.post('/search', dataApi, async (req, res) => {
    try {
        const { query, q, site = 'auto' } = req.body;
        const searchQuery = query || q;

        if (!searchQuery || searchQuery.trim() === '') {
            return res.status(400).json({
                error: 'Query parameter is required',
                example: { "query": "nature" }
            });
        }

        console.log(`Searching images for: "${searchQuery}" (site=${site})`);

        // MY LINKS: your sites (file + env + request) are the ONLY source
        const myUrls = await tryMyLinks(searchQuery, 'image', req.body?.myLinks,
            { site: (site && site !== 'auto') ? site : null });
        if (myUrls.length) console.log(`[search] ${myUrls.length} image(s) from MY LINKS — placed FIRST`);

        const allUrls = [...new Set(myUrls)];
        /* LEAD-RESULT VERIFIER: probe the first candidates and lead with
         * a VERIFIED alive one (adds ~1-2s, only when the leader is dead). */
        const verified = allUrls.length ? await utils.verifyLeadingImages(allUrls, 4) : allUrls;
        if (verified[0] !== allUrls[0]) console.log(`[search] lead result was DEAD — promoted verified image to front`);

        res.json({
            success: true,
            query: searchQuery,
            images: verified,
            count: verified.length,
            source: site,
            myLinks: myUrls.length,
            myLinksFirst: myUrls.length > 0,
            hint: myUrls.length ? undefined : NO_SOURCES_HINT,
            version: '4.7.6'
        });
    } catch (e) {
        console.error('Image search error:', e);
        res.status(500).json({
            error: 'Failed to search images',
            message: e.message
        });
    }
});

// Search videos — v3.1: direct video links scraped from YOUR slots.
// Optional "site" picks ONE video site (name piece / slot number).
app.post('/search-video', dataApi, async (req, res) => {
    try {
        const { query, q, site } = req.body;
        const searchQuery = query || q;

        if (!searchQuery || searchQuery.trim() === '') {
            return res.status(400).json({
                error: 'Query parameter is required',
                example: { "query": "music video" }
            });
        }

        console.log(`Searching videos for: "${searchQuery}"${site ? ' (site=' + site + ')' : ''}`);
        const extraLinks = Array.isArray(req.body?.myLinks) ? req.body.myLinks
            : (req.body?.myLinks ? [req.body.myLinks] : []);
        let slots = sortSlotsByFileOrder(getMyLinks('video', extraLinks, 'video'), 'video');
        const picked = filterVideoSlots(slots, site);
        if (site && !picked.slots.length) {
            return res.status(404).json({
                error: 'site "' + site + '" not found',
                available: picked.available,
                hint: 'Send one of the available names, or a slot number.',
                version: '4.7.6'
            });
        }
        /* v4.7.7: ONE slot engine — this route carried its own inline copy
         * with a 15s static race and NO app-shell render-through, so
         * JS-walled slots (beeg…) always read 0 here even after the main
         * engine was fixed. tryMyLinks runs the hardened ladder + stealth
         * render-through for every caller. */
        const found = await tryMyLinks(searchQuery, 'video', extraLinks, { slots: picked.slots });
        const videos = [...new Set(found)].slice(0, 30);

        res.json({
            success: true,
            query: searchQuery,
            videos: videos,
            count: videos.length,
            myLinks: videos.length,
            site: site || undefined,
            hint: videos.length ? undefined : NO_SOURCES_HINT,
            version: '4.7.6'
        });
    } catch (e) {
        console.error('Video search error:', e);
        res.status(500).json({
            error: 'Failed to search videos',
            message: e.message
        });
    }
});

// Search music — v3.0: direct audio links scraped from YOUR slots
app.post('/search-music', dataApi, async (req, res) => {
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
        const extraLinks = Array.isArray(req.body?.myLinks) ? req.body.myLinks
            : (req.body?.myLinks ? [req.body.myLinks] : []);
        const music = await tryMyLinks(searchQuery, 'music', extraLinks);

        res.json({
            success: true,
            query: searchQuery,
            music: music,
            count: music.length,
            myLinks: music.length,
            hint: music.length ? undefined : NO_SOURCES_HINT,
            version: '4.7.6'
        });
    } catch (e) {
        console.error('Music search error:', e);
        res.status(500).json({
            error: 'Failed to search music',
            message: e.message
        });
    }
});

// Search lyrics — v3.0: no built-in sources; kept for compatibility
app.post('/search-lyrics', dataApi, async (req, res) => {
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
        res.json({
            success: true,
            query: searchQuery,
            lyrics: [],
            count: 0,
            hint: NO_SOURCES_HINT,
            version: '4.7.6'
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
app.post('/album', dataApi, async (req, res) => {
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

// GIF search — v3.0: EXCLUSIVELY from your gif-type MyLinks slots
app.get('/gif', dataApi, async (req, res) => {
    try {
        const { q, site: gifSite } = req.query;

        if (!q || q.trim() === '') {
            return res.status(400).json({
                error: 'Query parameter q is required',
                example: '/gif?q=funny+cat'
            });
        }

        console.log(`Searching GIFs for: "${q}"`);

        // MY LINKS: your GIF sites (hot-reloaded file + env + request)
        const extraGifLinks = String(req.query.myLinks || '')
            .split(/[\n,]+/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s));
        const myGifs = await tryMyLinks(q, 'gif', extraGifLinks,
            { site: (gifSite && gifSite !== 'auto') ? gifSite : null });

        let allGifs = [...new Set(myGifs)];
        /* FINAL RELEVANCE PASS: floats on-topic slugs to the very front */
        const relevant = utils.relevantGifs(allGifs, q);
        if (relevant.length && relevant[0] !== allGifs[0]) {
            console.log(`[gif] relevance pass reordered — on-topic gif promoted to front`);
            allGifs = relevant;
        }

        res.json({
            success: true,
            query: q,
            gifs: allGifs,
            count: allGifs.length,
            myLinks: myGifs.length,
            myLinksFirst: myGifs.length > 0,
            hint: myGifs.length ? undefined : NO_SOURCES_HINT,
            version: '4.7.6'
        });
    } catch (e) {
        console.error('GIF search error:', e);
        res.status(500).json({
            error: 'Failed to search GIFs',
            message: e.message
        });
    }
});

// ─── POST /music — BreadBot integration ─────────────────────
// Bot: POST /music {query} -> expects { mediaUrl, title, mimetype, sizeBytes }
// v3.0: driven EXCLUSIVELY by your music-type slots (my_links.json /
// MYLINKS env / per-request myLinks). No slots = honest 404 + hint.
app.post('/music', dataApi, async (req, res) => {
    try {
        const { query, q } = req.body || {};
        const searchQuery = query || q;
        if (!searchQuery || String(searchQuery).trim() === '') {
            return res.status(400).json({ error: 'Query parameter is required', example: { "query": "Winky D" } });
        }
        const slots = getMyLinks('music', Array.isArray(req.body?.myLinks) ? req.body.myLinks
            : (req.body?.myLinks ? [req.body.myLinks] : []), 'music')
            .map(l => ({ name: l.name || l.url, url: myLinkUrl(l, searchQuery) }));
        if (!slots.length) {
            return res.status(404).json({ error: 'No sources', message: NO_SOURCES_HINT, hint: NO_SOURCES_HINT, version: '4.7.6' });
        }
        console.log(`[music] ${slots.length} music slot(s) for: "${searchQuery}"`);
        const baseUrl = req.protocol + '://' + req.get('host');
        const out = await media.myLinksMusic(slots, searchQuery, baseUrl, {
            exclude: req.body?.exclude
        });
        console.log(`[music] OK: ${out.title} (${(out.sizeBytes / 1048576).toFixed(1)}MB)`);
        return res.json({ success: true, mediaUrl: out.mediaUrl, title: out.title, mimetype: out.mimetype, kind: 'audio', sizeBytes: out.sizeBytes,
            expiresInSeconds: 3600, linkLifetime: 'temp copy — swept after 1h, 100 items, or service restart. Download it or copy it into your own storage.' });
    } catch (e) {
        console.error('Music error:', e);
        res.status(404).json({ error: 'No results', message: e.message, hint: NO_SOURCES_HINT, version: '4.7.6' });
    }
});

// ─── POST /video — BreadBot integration ──────────────────────
// Bot: POST /video {query} -> expects { mediaUrl, title, mimetype, sizeBytes }
// v3.1: driven EXCLUSIVELY by your video-type slots, tried in FILE
// order (YonaYethuu first). A slot's search page is scraped for direct
// .mp4/.webm links and for video-page links (each page opened, its mp4
// candidates pulled, quality-ranked). The winner is downloaded under
// the SCRAPER_MAX_MB cap (default 40MB — 34MB videos download fine)
// and served from /temp. The bot's exclude list (already-sent TITLES)
// is honoured. Optional "site" (name piece / slot number) forces ONE
// site — unknown picks return 404 + the available list.
app.post('/video', dataApi, async (req, res) => {
    try {
        const { query, q, exclude, site } = req.body || {};
        const searchQuery = query || q;
        if (!searchQuery || String(searchQuery).trim() === '') {
            return res.status(400).json({ error: 'Query parameter is required', example: { "query": "funny video" } });
        }
        const excl = (Array.isArray(exclude) ? exclude : []).map(x => String(x).toLowerCase().trim()).filter(Boolean);
        if (excl.length) console.log(`[video] exclude list: ${excl.length} already-sent title(s)`);
        let slots = sortSlotsByFileOrder(getMyLinks('video', Array.isArray(req.body?.myLinks) ? req.body.myLinks
            : (req.body?.myLinks ? [req.body.myLinks] : []), 'video'), 'video');
        const picked = filterVideoSlots(slots, site);
        if (site && picked.fuzzy) console.log(`[video] site "${site}" → fuzzy match "${picked.fuzzy.picked}" (${picked.fuzzy.score})`);
        if (site && !picked.slots.length) {
            console.log(`[video] site "${site}" not found — ${picked.available.length} available`);
            return res.status(404).json({
                error: 'site "' + site + '" not found',
                available: picked.available.slice(0, 25),
                availableTotal: picked.available.length,
                hint: 'Send one of the available names, or a slot number. !vidsites lists them.',
                version: '4.7.6'
            });
        }
        slots = picked.slots.map(l => ({ slot: l.slot, name: l.name || l.url, url: myLinkUrl(l, searchQuery) }));
        if (!slots.length) {
            return res.status(404).json({ error: 'No sources', message: NO_SOURCES_HINT, hint: NO_SOURCES_HINT, version: '4.7.6' });
        }
        console.log(`[video] ${slots.length} video slot(s) for: "${searchQuery}"${site ? ' (site=' + site + ')' : ''} — order: ${slots.map(s => s.name).join(' → ')}`);
        const baseUrl = req.protocol + '://' + req.get('host');
        const out = await media.myLinksVideo(slots, searchQuery, baseUrl, { exclude: excl });
        console.log(`[video] OK: ${out.title} (${(out.sizeBytes / 1048576).toFixed(1)}MB)`);
        return res.json({ success: true, mediaUrl: out.mediaUrl, title: out.title, source: out.source, site: site || undefined, mimetype: out.mimetype, kind: 'video', sizeBytes: out.sizeBytes,
            expiresInSeconds: 3600, linkLifetime: 'temp copy — swept after 1h, 100 items, or service restart. Download it or copy it into your own storage.' });
    } catch (e) {
        console.error('Video error:', e);
        res.status(404).json({ error: 'No results', message: e.message, hint: NO_SOURCES_HINT, version: '4.7.6' });
    }
});

// ─── POST /video-ranked — v4.3 the "5 most relevant" engine ────
// Bot: POST /video-ranked {query, site?, myLinks?, exclude?} →
// { success, results: [{ title, url, site, kind, score }], count }
// Every video slot's search page is scraped for watch-page links +
// direct mp4s, then the WHOLE list is scored against the full query
// with the weighted engine and returned best-first. The bot shows/
// resolves the top picks and walks down the list on "next".
const relevance = require('./relevance');
app.post('/video-ranked', dataApi, async (req, res) => {
    try {
        const { query, q, site } = req.body || {};
        const searchQuery = query || q;
        if (!searchQuery || String(searchQuery).trim() === '') {
            return res.status(400).json({ error: 'Query parameter is required', example: { "query": "iranian teen" } });
        }
        let slots = sortSlotsByFileOrder(getMyLinks('video', Array.isArray(req.body?.myLinks) ? req.body.myLinks
            : (req.body?.myLinks ? [req.body.myLinks] : []), 'video'), 'video');
        const picked = filterVideoSlots(slots, site);
        if (site && !picked.slots.length) {
            return res.status(404).json({ error: 'site "' + site + '" not found', available: picked.available, version: '4.7.6' });
        }
        slots = picked.slots.map(l => ({ slot: l.slot, name: l.name || l.url, url: myLinkUrl(l, relevance.searchTerms(searchQuery)) }));
        if (!slots.length) {
            return res.status(404).json({ error: 'No sources', message: NO_SOURCES_HINT, hint: NO_SOURCES_HINT, version: '4.4.0' });
        }
        console.log(`[video-ranked] ${slots.length} slot(s) for "${searchQuery}"`);
        const out = await media.myLinksVideoRanked(slots, searchQuery, {});
        console.log(`[video-ranked] ${out.results.length} ranked result(s) for "${searchQuery}"`);
        return res.json({
            success: true, query: searchQuery,
            results: out.results, count: out.results.length,
            errors: out.errors, version: '4.4.0'
        });
    } catch (e) {
        console.error('video-ranked error:', e.message);
        res.status(404).json({ error: 'No results', message: e.message, hint: NO_SOURCES_HINT, version: '4.7.6' });
    }
});

// ─── POST /video-resolve — one watch page → one real file ─────
// Bot: POST /video-resolve {url} → same shape as /video. Fetches the
// page, pulls player-config + direct mp4s, downloads the first that
// works under the cap, serves from /temp. This is how the bot sends
// the video the user actually picked from a ranked list.
app.post('/video-resolve', dataApi, async (req, res) => {
    try {
        const url = String((req.body || {}).url || '').trim();
        if (!/^https?:\/\//i.test(url)) {
            return res.status(400).json({ error: 'Body must be {"url": "https://…video page…"}', version: '4.7.6' });
        }
        const baseUrl = req.protocol + '://' + req.get('host');
        const out = await media.resolveVideoPage(url, baseUrl, {});
        console.log(`[video-resolve] OK: ${out.title} (${(out.sizeBytes / 1048576).toFixed(1)}MB)`);
        return res.json({ success: true, mediaUrl: out.mediaUrl, title: out.title, source: out.source, mimetype: out.mimetype, kind: 'video', sizeBytes: out.sizeBytes,
            expiresInSeconds: 3600, version: '4.7.6' });
    } catch (e) {
        console.error('video-resolve error:', e.message);
        res.status(404).json({ error: 'Not downloadable', message: e.message, version: '4.7.6' });
    }
});

// ─── GET /video-sites — the list users can pick from ───────────
// Powers the bot's !vidsites command: numbered, enabled-first.
app.get('/video-sites', dataApi, (req, res) => {
    loadMyLinks(false);
    const slots = sortSlotsByFileOrder(getMyLinks('video', [], 'video'), 'video');
    res.json({
        success: true,
        defaultFirst: slots.length ? slots[0].name : null,
        sites: slots.map((s, i) => ({ pick: i + 1, slot: s.slot, name: s.name || s.url, url: s.url })),
        version: '4.7.6'
    });
});

// ─── POST /download — BreadBot integration ───────────────────
// Bot: POST /download {url, kind} -> expects { mediaUrl, title, mimetype, kind, sizeBytes }
// v3.0: generic direct-URL download only (no site-specific resolvers).
app.post('/download', dataApi, async (req, res) => {
    try {
        const { url, kind = 'auto' } = req.body || {};
        if (!url || String(url).trim() === '') {
            return res.status(400).json({ error: 'URL parameter is required', example: { "url": "https://..." } });
        }
        try { utils.safeUrl(url); }              // v4.1 SSRF guard — reject before any fetch
        catch (se) { return res.status(400).json({ error: 'URL rejected: ' + se.message }); }
        const baseUrl = req.protocol + '://' + req.get('host');
        console.log(`[download] Direct ${kind}: ${String(url).slice(0, 120)}`);
        const out = await media.genericDownload(url, kind, baseUrl);
        return res.json({ success: true, mediaUrl: out.mediaUrl, title: out.title, mimetype: out.mimetype, kind: out.kind, sizeBytes: out.sizeBytes,
            expiresInSeconds: 3600, linkLifetime: 'temp copy — swept after 1h, 100 items, or service restart. Download it or copy it into your own storage.' });
    } catch (e) {
        console.error('Download error:', e);
        res.status(500).json({ error: 'Failed to download media', message: e.message });
    }
});

// Cleanup endpoint
app.post('/cleanup', dataApi, (req, res) => {
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

// ─── PERIODIC TEMP SWEEP — disk stays clean even on idle days ───
setInterval(() => {
    try {
        const r = temp.cleanup();
        if (r && r.deletedCount) console.log(`[temp] sweep: ${r.deletedCount} file(s), ${(r.freedSpaceMB || 0).toFixed(1)}MB freed`);
    } catch (e) {}
}, 5 * 60 * 1000).unref?.();   // v4.7.6: sweep every 5min (was 15)

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
            'POST /music',
            'POST /video',
            'POST /download',
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
    console.log(`🔗 MYLINKS-ONLY mode: media comes ONLY from your slots (my_links.json / MYLINKS env / per-request)`);
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});
