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

async function searchImages(query, site = 'pornpics') {
    let url;
    if (site === 'pornpics') {
        url = `https://www.pornpics.com/search/?q=${encodeURIComponent(query)}`;
    } else if (site === 'darknaija') {
        url = `https://darknaija.com/?s=${encodeURIComponent(query)}`;
    } else {
        throw new Error('Unsupported site');
    }
    const html = await utils.fetchPage(url);
    const imageUrls = await utils.extractImageUrls(html, url);
    return imageUrls.slice(0, 20);
}

module.exports = {
    downloadAlbum,
    searchImages
};
