const utils = require('./utils');
const temp = require('./temp');
const pLimit = require('p-limit');

// v4.1 FIX: was a plain `{}` — `'x' in ALBUM_MAP` walks the prototype
// chain, so `'constructor' in ALBUM_MAP` was always true and the
// keyword branch assigned the Function object itself as albumUrl →
// guaranteed crash. Object.create(null) makes `in` safe.
const ALBUM_MAP = Object.create(null);

/* ══════════════════════════════════════════════════════════════
 *  v3.0 ZERO BUILT-IN SOURCES — album.js is now source-free.
 *  Every search endpoint (/search, /gif, /video, /music) gets its
 *  media EXCLUSIVELY from the slots the owner configures:
 *    my_links.json  (hot-reloaded)  ·  MYLINKS env  ·  per-request
 *  There are NO fallback engines, NO emergency chains and NO
 *  hardcoded websites anywhere in this codebase anymore.
 *  What lives here is the generic ALBUM downloader: fetch a page
 *  the caller points at, extract its images, download them. ═══ */

async function downloadAlbum(albumUrlOrKeyword, concurrency = 3) {
    let albumUrl = albumUrlOrKeyword;
    if (Object.prototype.hasOwnProperty.call(ALBUM_MAP, albumUrlOrKeyword)) {
        albumUrl = ALBUM_MAP[albumUrlOrKeyword];
    }
    albumUrl = utils.safeUrl(albumUrl);   // v4.1 SSRF guard
    const html = await utils.fetchPage(albumUrl);
    const imageUrls = await utils.extractImageUrls(html, albumUrl);
    if (imageUrls.length === 0) {
        throw new Error('No images found in album');
    }
    const limit = pLimit(concurrency);
    const downloadPromises = imageUrls.map(url =>
        limit(() => utils.downloadImage(url))
    );
    const results = await Promise.allSettled(downloadPromises);
    const valid = results
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);
    if (valid.length === 0) {
        throw new Error('No images could be downloaded');
    }
    const albumId = temp.saveAlbum(valid);
    return albumId;
}

module.exports = {
    downloadAlbum
};
