const utils = require('./utils');
const temp = require('./temp');
const pLimit = require('p-limit');

const ALBUM_MAP = {};

async function downloadAlbum(albumUrlOrKeyword, concurrency = 3) {
    let albumUrl = albumUrlOrKeyword;
    if (albumUrlOrKeyword in ALBUM_MAP) {
        albumUrl = ALBUM_MAP[albumUrlOrKeyword];
    }
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

async function searchImages(query, site = 'darknaija') {
    const attempts = [];

    // 1. DarkNaija
    attempts.push({
        site: 'darknaija',
        url: `https://darknaija.com/?s=${encodeURIComponent(query)}`
    });

    // 2. PornPics (multiple formats)
    attempts.push({
        site: 'pornpics',
        url: `https://www.pornpics.com/search/?q=${encodeURIComponent(query)}`
    });
    attempts.push({
        site: 'pornpics',
        url: `https://www.pornpics.com/search/srch.php?q=${encodeURIComponent(query)}&lang=en`
    });

    // 3. Reddit fallback (NSFW)
    attempts.push({
        site: 'reddit',
        url: `https://old.reddit.com/r/boobs/top/.json?limit=20`
    });

    for (const attempt of attempts) {
        try {
            const html = await utils.fetchPage(attempt.url);
            let imageUrls = [];
            if (attempt.site === 'reddit') {
                try {
                    const json = JSON.parse(html);
                    const posts = json.data.children;
                    imageUrls = posts
                        .map(p => p.data.url)
                        .filter(url => /\.(jpg|jpeg|png|gif|webp)$/i.test(url));
                } catch (e) {
                    continue;
                }
            } else {
                imageUrls = await utils.extractImageUrls(html, attempt.url);
            }
            if (imageUrls.length > 0) {
                return imageUrls.slice(0, 20);
            }
        } catch (e) {
            // Try next attempt
        }
    }
    return [];
}

module.exports = {
    downloadAlbum,
    searchImages
};
