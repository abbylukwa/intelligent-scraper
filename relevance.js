'use strict';

/* ═══════════════════════════════════════════════════════════════
 *  relevance.js — v4.3 WEIGHTED QUERY↔RESULT RELEVANCE ENGINE
 *
 *  The old scoring was BINARY (a URL contained one query word → 0,
 *  otherwise 1), so the first site in file order always won with
 *  whatever it had — the boss called the results "2% relevant".
 *
 *  This engine scores every candidate 0-100 against the WHOLE query:
 *    · every query word that appears in the slug/title counts
 *      (fraction-of-coverage × 46)
 *    · the full phrase, in order, counts +34
 *    · all query words present counts +12
 *    · a word matching on a word BOUNDARY counts more than a
 *      substring hit (+8 for boundary hits)
 *  Candidates are ranked stably (equal score keeps discovery order),
 *  and an optional `topicGate` drops zero-score noise when enough
 *  on-topic results exist.
 * ═══════════════════════════════════════════════════════════════ */

/* meaningful query tokens — drop stopwords and 1-2 char fragments */
const STOPWORDS = new Set([
    'the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'with', 'by',
    'my', 'me', 'i', 'you', 'your', 'is', 'are', 'was', 'be', 'this', 'that',
    'give', 'gimme', 'send', 'show', 'find', 'get', 'download', 'want', 'need',
    'please', 'pls', 'plz', 'some', 'any', 'video', 'videos', 'vid', 'vids',
    'pic', 'pics', 'picture', 'pictures', 'image', 'images', 'photo', 'photos',
    'song', 'songs', 'music', 'clip', 'clips', 'movie', 'movies', 'full'
]);
/* media-noun words the bot strips before the query reaches the scraper */
const MEDIA_NOUNS = new Set([
    'video', 'videos', 'vid', 'vids', 'mavhidhiyo', 'clip', 'clips',
    'pic', 'pics', 'picture', 'pictures', 'image', 'images',
    'photo', 'photos', 'mapic', 'mapics', 'mufananidzo', 'mifananidzo',
    'song', 'songs', 'music', 'track', 'tracks', 'album', 'albums', 'mixtape',
    'gif', 'gifs'
]);

function tokenize(query) {
    const words = String(query || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter(w => w.length > 1 && !STOPWORDS.has(w));
    /* singularise cheap plurals so "cats" matches "cat-…" slugs */
    const out = [];
    for (const w of words) {
        out.push(w);
        if (w.length > 3 && w.endsWith('s') && !out.includes(w.slice(0, -1))) out.push(w.slice(0, -1));
    }
    return [...new Set(out)];
}

/* decoded, human-readable title of a URL: last 1-2 path segments,
 * extension stripped, separators → spaces (+ the query string content) */
function titleOf(url) {
    try {
        const pu = new URL(url);
        const segs = pu.pathname.split('/').filter(Boolean);
        const last = (segs[segs.length - 1] || '')
            .replace(/\.[a-z0-9]{2,5}$/i, '');
        const prev = (segs[segs.length - 2] || '')
            .replace(/\.[a-z0-9]{2,5}$/i, '')
            .replace(/^(video|watch|clip|media|v)-?/i, '');
        const human = [prev, last]
            .filter(Boolean)
            .join(' ')
            .replace(/[-_.+]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return decodeURIComponent(human || pu.hostname).toLowerCase();
    } catch (e) {
        return String(url || '').toLowerCase();
    }
}

/* does `word` appear in `text` as its own word? (boundary match) */
function boundaryHit(text, word) {
    if (!text || !word) return false;
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^\\p{L}\\p{N}])' + esc + 's?([^\\p{L}\\p{N}]|$)', 'u');
    return re.test(text);
}

/* does the full query phrase appear in order (allowing separators)? */
function phraseHit(text, words) {
    if (!words.length || !text) return false;
    const esc = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(esc.join('[\\s\\-_.+]*'), 'i');
    return re.test(text);
}

/* ═══ v4.4 GOOGLE-STYLE QUERY OPERATORS — research-proven web-query
 * narrowing, applied to every search. The boss: "add more research on
 * how to do a perfect web query to search what you want like google
 * tags". Supported in ANY query the bot forwards:
 *
 *   "latina teen"        → quoted phrase MUST appear in the result title
 *   latina -gay -shemale → minus words: any result containing them DIES
 *   site:xvideos.com     → only results from that domain survive
 *   intitle:teen         → word must be in the result title
 *
 * Operators are STRIPPED from the scoring tokens, turned into the URL
 * search string most tube engines understand ("quoted phrases" + -minus
 * words are honored by xvideos/xhamster/pornhub/xnxx/eporner search),
 * AND enforced again here as a hard post-filter — so even a site that
 * ignores the operators never leaks an off-topic result into the top.
 * ═══════════════════════════════════════════════════════════════ */
function queryPlan(rawQuery) {
    let q = String(rawQuery || '');
    const phrases = [];
    const minus = [];
    const titleMust = [];
    let siteFilter = null;
    q = q.replace(/"([^"]+)"/g, (m, p) => { const t = p.trim().toLowerCase(); if (t) phrases.push(t); return ' '; });
    q = q.replace(/(?:^|\s)-([\p{L}\p{N}]{2,})/gu, (m, w) => { minus.push(w.toLowerCase()); return ' '; });
    q = q.replace(/(?:^|\s)site:([a-z0-9.\-]+)/gi, (m, s) => { siteFilter = s.toLowerCase().replace(/^www\./, ''); return ' '; });
    q = q.replace(/(?:^|\s)intitle:([\p{L}\p{N}"]{2,})/giu, (m, w) => { titleMust.push(w.toLowerCase().replace(/"/g, '')); return ' '; });
    q = q.replace(/\s+/g, ' ').trim();
    return { q, phrases, minus, siteFilter, titleMust };
}
/* the string a SEARCH URL wants: cleaned words + "quoted phrases" +
 * -minus words (Google-style — tube search engines parse these) */
function searchTerms(rawQuery) {
    const plan = queryPlan(rawQuery);
    let s = plan.q;
    if (plan.phrases.length) s += ' ' + plan.phrases.map(p => '"' + p + '"').join(' ');
    if (plan.minus.length) s += ' ' + plan.minus.map(w => '-' + w).join(' ');
    return s.replace(/\s+/g, ' ').trim();
}
/* hard post-filter — returns true when a candidate SURVIVES the plan */
function planSurvives(urlOrTitle, plan) {
    if (!plan) return true;
    const t = typeof urlOrTitle === 'string' ? titleOf(urlOrTitle) : '';
    if (plan.minus.length && plan.minus.some(w => t.includes(w))) return false;
    if (plan.siteFilter) {
        try { const h = new URL(String(urlOrTitle)).hostname.replace(/^www\./, ''); if (!h.includes(plan.siteFilter)) return false; }
        catch (e) { return false; }
    }
    if (plan.titleMust.length && !plan.titleMust.every(w => t.includes(w))) return false;
    if (plan.phrases.length && !plan.phrases.every(p => phraseHit(t, p.split(/\s+/)))) return false;
    return true;
}

/* THE score — 0..100 */
function scoreOf(url, words, phrase) {
    const s = String(url || '').toLowerCase();
    if (!s) return 0;
    const title = titleOf(s);
    if (!words.length) return 20;                        /* no query → neutral */
    let score = 0;
    let hits = 0;
    for (const w of words) {
        const inTitle = title.includes(w);
        if (!inTitle) continue;
        hits++;
        if (boundaryHit(title, w)) score += 4;           /* real word, not substring noise */
        /* query words are search-target words — substring hits in the
         * slug still count, just less than boundary hits */
        score += 3;
    }
    /* coverage is the dominant term — "iranian teen" must beat a page
     * that only says "iranian" in the site name */
    score += (hits / words.length) * 46;
    if (phrase && phraseHit(title, words)) score += 34;
    if (hits === words.length) score += 12;              /* every word present */
    return Math.min(100, Math.round(score));
}

/* rank [{url,...}] items by relevance, best first. Ties keep the
 * original discovery order (stable sort). Returns a NEW array.
 * v4.4: opts.plan (from queryPlan) enforces operators as a hard filter
 * BEFORE scoring — operator-violating candidates never rank at all. */
function rankResults(items, query, opts = {}) {
    const words = opts.words || tokenize(opts.plan ? opts.plan.q : query);
    const phrase = words.length ? words.join(' ') : '';
    const plan = opts.plan || null;
    const scored = (items || [])
        .filter(it => planSurvives(typeof it === 'string' ? it : (it.url || ''), plan))
        .map((it, i) => ({ it, i, score: scoreOf(typeof it === 'string' ? it : (it.url || it.title || ''), words, phrase) }))
        .sort((a, b) => (b.score - a.score) || (a.i - b.i))
        .map(x => x.it);
    /* topic gate: when enough on-topic results exist, drop the noise */
    const gate = opts.topicGate === undefined ? 6 : opts.topicGate;
    if (gate > 0 && words.length) {
        const on = scored.filter(it => scoreOf(typeof it === 'string' ? it : (it.url || ''), words, phrase) >= 25);
        if (on.length >= gate) return on;
    }
    return scored;
}

module.exports = { tokenize, titleOf, scoreOf, rankResults, boundaryHit, phraseHit, queryPlan, searchTerms, planSurvives, MEDIA_NOUNS, STOPWORDS };
