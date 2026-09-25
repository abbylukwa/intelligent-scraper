'use strict';

/* ============================================================
 *  media.js — /music, /video, /download backing for BreadBot
 *
 *  WHY THIS EXISTS (integration fix):
 *  whatsapp-qr-app/server.js calls:
 *      POST /music   { query }        -> { mediaUrl, title, mimetype, sizeBytes }
 *      POST /video   { query }        -> { mediaUrl, title, mimetype, sizeBytes }
 *      POST /download{ url, kind }    -> { mediaUrl, title, mimetype, kind, sizeBytes }
 *  None of these endpoints existed, so every !dl / !music / song
 *  request from the bot hit a 404. This module implements them.
 *
 *  v2.2.1 — ytdl-core REMOVED (user request: "ytdl-core doesn't work,
 *  find other ways… how y2mate does it / an online downloader"):
 *  - Search: results-page scrape (unchanged) + Piped API fallback.
 *  - Download: pure-axios chain of online resolver APIs, same idea as
 *    y2mate — resolve watch URL -> direct media URL, then download:
 *      1. Invidious instances  /api/v1/videos/<id>
 *      2. Piped instances      /streams/<id>
 *      3. Cobalt instances     POST /  (tunnel)
 *    First resolver that returns a playable URL wins. No ytdl
 *    dependency at all — plain HTTP with the same 34MB hard cap.
 *  - Storage: reuses temp.saveFile() so the 1h auto-cleanup applies.
 * ============================================================ */

const axios = require('axios');
const temp = require('./temp');

/* Online resolver instances (override via env, comma-separated).
 * Every one of them does exactly what y2mate does: hand back a direct
 * googlevideo/CDN URL for a watch URL — we just download that URL. */
const PIPED_APIS = (process.env.PIPED_APIS ||
  'https://pipedapi.kavin.rocks,https://pipedapi.adminforge.de,https://api.piped.private.coffee,https://pipedapi.drgns.space').split(',').map(s => s.trim()).filter(Boolean);
const INVIDIOUS_APIS = (process.env.INVIDIOUS_APIS ||
  'https://inv.nadeko.net,https://invidious.nerdvpn.de,https://yewtu.be,https://invidious.f5.si,https://iv.melmac.space').split(',').map(s => s.trim()).filter(Boolean);
const COBALT_APIS = (process.env.COBALT_APIS ||
  'https://cobalt-api.kwiatekmiki.com,https://capi.3kh0.net,https://cobalt-backend.canine.tools').split(',').map(s => s.trim()).filter(Boolean);
const RESOLVER_TIMEOUT_MS = Math.max(4000, parseInt(process.env.RESOLVER_TIMEOUT_MS || '10000', 10));

const MAX_MB = Math.max(1, parseInt(process.env.SCRAPER_MAX_MB || '34', 10));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function ytId(urlOrId) {
    const m = String(urlOrId || '').match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

/* ── YouTube search: scrape results page, fall back to Piped API ── */
async function ytSearch(query, limit = 5) {
    // 1) Piped search (proper API, no scraping) — instance rotation
    for (const base of PIPED_APIS) {
        try {
            const r = await axios.get(base + '/search?q=' + encodeURIComponent(query) + '&filter=videos',
                { timeout: RESOLVER_TIMEOUT_MS, headers: { 'User-Agent': UA } });
            const vids = (r.data && Array.isArray(r.data.items) ? r.data.items : [])
                .filter(v => v && (v.url || v.id))
                .slice(0, limit)
                .map(v => ({ id: (v.url || '').split('v=')[1] || v.id, title: v.title || 'YouTube video' }))
                .filter(v => v.id && v.id.length === 11);
            if (vids.length) return vids;
        } catch (e) { /* try next instance */ }
    }
    // 2) scrape the results page for videoId/title pairs
    try {
        const r = await axios.get('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), {
            headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
            timeout: 20000
        });
        const html = typeof r.data === 'string' ? r.data : '';
        const out = [];
        const seen = new Set();
        const re = /"videoId":"([A-Za-z0-9_-]{11})".*?"title":\{"runs":\[\{"text":"(.*?)"\}/g;
        let m;
        while ((m = re.exec(html)) !== null && out.length < limit) {
            if (!seen.has(m[1])) {
                seen.add(m[1]);
                out.push({ id: m[1], title: m[2].replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\n/g, ' ') });
            }
        }
        if (!out.length) {
            for (const mm of html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)) {
                if (!seen.has(mm[1])) { seen.add(mm[1]); out.push({ id: mm[1], title: 'YouTube video' }); }
                if (out.length >= limit) break;
            }
        }
        return out;
    } catch (e) {
        console.error('yt scrape failed:', e.message);
        return [];
    }
}

/* ── Capped download of a direct media URL (shared by all resolvers) ── */
async function fetchCapped(url) {
    const cap = MAX_MB * 1024 * 1024;
    const r = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: cap + 1,
        maxBodyLength: cap + 1,
        validateStatus: s => s >= 200 && s < 400,
        headers: { 'User-Agent': UA, 'Referer': 'https://www.youtube.com/' }
    });
    const buf = Buffer.from(r.data);
    if (!buf.length) throw new Error('Downloaded file is empty');
    if (buf.length > cap) throw new Error(`Media exceeds ${MAX_MB}MB cap`);
    return buf;
}

/* ── Resolver 0: YouTube innertube player API (first-party — the same
 *    trick y2mate-class sites use). No key needed; ANDROID client.
 *    Skips formats that only ship a signatureCipher (can't decrypt
 *    without deps); uses entries that carry a literal url. ── */
async function resolveInnertube(vid, kind) {
    const body = {
        context: { client: { clientName: 'ANDROID', clientVersion: '19.09.37',
                             androidSdkVersion: 30, hl: 'en' } },
        videoId: vid, contentCheckOk: true, racyCheckOk: true
    };
    const r = await axios.post('https://www.youtube.com/youtubei/v1/player', body, {
        timeout: RESOLVER_TIMEOUT_MS,
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
            'X-YouTube-Client-Name': '3',
            'X-YouTube-Client-Version': '19.09.37'
        }
    });
    const d = r.data || {};
    if (d.playabilityStatus && d.playabilityStatus.status !== 'OK') {
        throw new Error('innertube: ' + (d.playabilityStatus.reason || d.playabilityStatus.status));
    }
    const sd = d.streamingData || {};
    const all = (sd.formats || []).concat(sd.adaptiveFormats || []);
    let pick = null;
    if (kind === 'audio') {
        pick = all.filter(f => f.url && String(f.mimeType || '').startsWith('audio'))
                  .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    } else {
        pick = all.filter(f => f.url && String(f.mimeType || '').startsWith('video')
                              && String(f.mimeType || '').includes('mp4')
                              && (f.height || 0) <= 720 && (f.height || 0) > 0)
                  .sort((a, b) => (b.height || 0) - (a.height || 0))[0]
            || all.filter(f => f.url && String(f.mimeType || '').startsWith('video'))
                  .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    }
    if (!pick || !pick.url) throw new Error('innertube: no direct-url format');
    return {
        url: pick.url,
        title: (d.videoDetails && d.videoDetails.title) || ('YouTube ' + kind),
        mimetype: String(pick.mimeType || '').split(';')[0].trim()
    };
}

/* ── Resolver 1: Invidious — /api/v1/videos/<id> ── */
async function resolveInvidious(vid, kind) {
    for (const base of INVIDIOUS_APIS) {
        try {
            const r = await axios.get(base + '/api/v1/videos/' + vid,
                { timeout: RESOLVER_TIMEOUT_MS, headers: { 'User-Agent': UA } });
            const d = r.data;
            if (!d || (!d.adaptiveFormats && !d.formatStreams)) continue;
            let pick = null, mime = '';
            if (kind === 'audio') {
                const auds = (d.adaptiveFormats || [])
                    .filter(f => String(f.type || '').startsWith('audio'))
                    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                pick = auds[0];
            } else {
                // progressive streams carry both video+audio (like y2mate's mp4)
                const vids = (d.formatStreams || [])
                    .filter(f => String(f.type || '').includes('mp4'))
                    .sort((a, b) => parseInt(b.resolution || 0) - parseInt(a.resolution || 0));
                pick = vids.find(f => parseInt(f.resolution || 0) <= 720) || vids[0];
            }
            if (!pick || !pick.url) continue;
            mime = String(pick.type || '').split(';')[0].trim();
            return { url: pick.url, title: d.title || ('YouTube ' + kind), mimetype: mime };
        } catch (e) { /* try next instance */ }
    }
    throw new Error('Invidious: no resolver had the video');
}

/* ── Resolver 2: Piped — /streams/<id> ── */
async function resolvePiped(vid, kind) {
    for (const base of PIPED_APIS) {
        try {
            const r = await axios.get(base + '/streams/' + vid,
                { timeout: RESOLVER_TIMEOUT_MS, headers: { 'User-Agent': UA } });
            const d = r.data;
            if (!d) continue;
            let pick = null, mime = '';
            if (kind === 'audio') {
                const auds = (d.audioStreams || [])
                    .filter(s => s && s.url)
                    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                pick = auds.find(s => String(s.mimeType || s.format || '').includes('mpeg')) || auds.find(s => String(s.mimeType || s.format || '').includes('mp4')) || auds[0];
            } else {
                // videoOnly streams lack audio; prefer combined (videoOnly=false)
                const vs = (d.videoStreams || []).filter(s => s && s.url && !s.videoOnly)
                    .sort((a, b) => (b.height || 0) - (a.height || 0));
                pick = vs.find(s => (s.height || 0) <= 720) || vs[0];
            }
            if (!pick || !pick.url) continue;
            mime = String(pick.mimeType || pick.format || '').split(';')[0].trim();
            return { url: pick.url, title: d.title || ('YouTube ' + kind), mimetype: mime };
        } catch (e) { /* try next instance */ }
    }
    throw new Error('Piped: no resolver had the video');
}

/* ── Resolver 3: Cobalt — POST / with the watch URL (y2mate-style tunnel) ── */
async function resolveCobalt(idOrUrl, kind) {
    const watch = String(idOrUrl).length === 11
        ? 'https://www.youtube.com/watch?v=' + idOrUrl
        : String(idOrUrl);
    for (const base of COBALT_APIS) {
        try {
            const r = await axios.post(base + '/',
                { url: watch, audioOnly: kind === 'audio', videoQuality: '720' },
                { timeout: RESOLVER_TIMEOUT_MS, headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA } });
            const d = r.data || {};
            if ((d.status === 'tunnel' || d.status === 'stream' || d.status === 'redirect') && d.url) {
                return { url: d.url, title: d.filename || ('YouTube ' + kind), mimetype: kind === 'audio' ? 'audio/mp4' : 'video/mp4' };
            }
        } catch (e) { /* try next instance */ }
    }
    throw new Error('Cobalt: no resolver had the video');
}

/* ── Download a YouTube id/url as audio or video via the resolver
 *    chain (Invidious → Piped → Cobalt), store in temp. ── */
async function ytDownload(idOrUrl, kind, baseUrl) {
    const vid = ytId(idOrUrl) || idOrUrl;
    if (!vid || vid.length !== 11) throw new Error('Invalid YouTube id');
    if (kind !== 'audio' && kind !== 'video') kind = 'video';

    const resolvers = [resolveInnertube, resolveInvidious, resolvePiped, resolveCobalt];
    const errors = [];
    let resolved = null;
    for (const fn of resolvers) {
        try { resolved = await fn(vid, kind); break; }
        catch (e) { errors.push(e.message); }
    }
    if (!resolved) throw new Error('All online resolvers failed: ' + errors.join(' | '));

    const buf = await fetchCapped(resolved.url);
    let mimetype = (resolved.mimetype || '').toLowerCase();
    if (!mimetype.startsWith('audio') && !mimetype.startsWith('video')) {
        mimetype = kind === 'audio' ? 'audio/mp4' : 'video/mp4';
    }
    const ext = mimetype.includes('webm') ? '.webm'
              : mimetype.includes('mpeg') ? '.mp3'
              : (kind === 'audio' ? '.m4a' : '.mp4');
    const id = temp.saveFile(buf, ext);
    return { mediaUrl: baseUrl + '/temp/' + id + ext, title: resolved.title, mimetype, kind, sizeBytes: buf.length };
}

/* ── Generic direct-URL download (mp3 sites, image CDNs, etc.) ── */
async function genericDownload(url, kind, baseUrl) {
    const cap = MAX_MB * 1024 * 1024;
    const r = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: cap + 1,
        maxBodyLength: cap + 1,
        validateStatus: s => s >= 200 && s < 400,
        headers: { 'User-Agent': UA }
    });
    const buf = Buffer.from(r.data);
    if (!buf.length) throw new Error('Empty file');
    let mimetype = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const extMap = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
        'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
        'audio/ogg': '.ogg', 'audio/wav': '.wav', 'application/pdf': '.pdf'
    };
    const ext = extMap[mimetype] || '.bin';
    const id = temp.saveFile(buf, ext);
    const resolvedKind = kind && kind !== 'auto'
        ? kind
        : mimetype.startsWith('audio') ? 'audio'
        : mimetype.startsWith('video') ? 'video'
        : mimetype.startsWith('image') ? 'image' : 'file';
    return {
        mediaUrl: baseUrl + '/temp/' + id + ext,
        title: 'download' + ext,
        mimetype: mimetype || 'application/octet-stream',
        kind: resolvedKind,
        sizeBytes: buf.length
    };
}

module.exports = { ytSearch, ytDownload, genericDownload, ytId, MAX_MB };
