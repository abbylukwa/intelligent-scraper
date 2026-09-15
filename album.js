/* album.js – full replacement */
const utils = require('./utils');
const temp = require('./temp');
const pLimit = require('p-limit');

/* optional mapping of short keys → full album URLs */
const ALBUM_MAP = {};

/* -------------------------------------------------
   Download an album (image collection) and store it
   ------------------------------------------------- */
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

/* -------------------------------------------------
   Image search – tries up to 5 sources
   ------------------------------------------------- */
async function searchImages(query, site = 'darknaija') {
    const attempts = [
        {
            site: 'darknaija',
            url: `https://darknaija.com/?s=${encodeURIComponent(query)}`
        },
        {
            site: 'pornpics',
            url: `https://www.pornpics.com/search/?q=${encodeURIComponent(query)}`
        },
        {
            site: 'pornpics_alt',
            url: `https://www.pornpics.com/search/srch.php?q=${encodeURIComponent(query)}&lang=en`
        },
        {
            site: 'reddit',
            url: `https://old.reddit.com/r/boobs/top/.json?limit=20`
        },
        {
            site: 'imagefaqs',
            url: `https://www.imagefaqs.com/search?q=${encodeURIComponent(query)}`
        }
    ];

    for (const attempt of attempts) {
        try {
            const html = await utils.fetchPage(attempt.url);
            let imageUrls = [];

            if (attempt.site === 'reddit') {
                const json = JSON.parse(html);
                imageUrls = json.data.children
                    .map(p => p.data.url)
                    .filter(url => /\.(jpe?g|png|gif|webp)$/i.test(url));
            } else {
                imageUrls = await utils.extractImageUrls(html, attempt.url);
            }

            if (imageUrls.length > 0) {
                return imageUrls.slice(0, 20);
            }
        } catch (e) {
            // silently try next source
        }
    }
    return [];
}

/* -------------------------------------------------
   Video search – simple regex scrape for video URLs
   ------------------------------------------------- */
async function searchVideos(query) {
    const attempts = [
        {
            site: 'pornhub',
            url: `https://www.pornhub.com/search/?search=${encodeURIComponent(query)}`
        },
        {
            site: 'xhamster',
            url: `https://www.xhamster.com/search?keyword=${encodeURIComponent(query)}`
        },
        {
            site: 'spankyou',
            url: `https://spankyou.com/search?q=${encodeURIComponent(query)}`
        }
    ];

    for (const attempt of attempts) {
        try {
            const html = await utils.fetchPage(attempt.url);
            const matches =
                html.match(/https?:\/\/[^"']+\.(mp4|m3u8|webm)[^"']*/gi) || [];
            if (matches.length > 0) {
                return matches.slice(0, 10);
            }
        } catch (e) {
            // try next source
        }
    }
    return [];
}

/* -------------------------------------------------
   Music search – scrape for direct audio links
   ------------------------------------------------- */
async function searchMusic(query) {
    const attempts = [
        {
            site: 'y2mate',
            url: `https://v38.www-y2mate.com/search/?q=${encodeURIComponent(query)}`
        },
        {
            site: 'mp3juices',
            url: `https://mp3juices.cc/search/?q=${encodeURIComponent(query)}`
        },
        {
            site: 'pagalworld',
            url: `https://pagalworld.com/search/${encodeURIComponent(query)}`
        }
    ];

    for (const attempt of attempts) {
        try {
            const html = await utils.fetchPage(attempt.url);
            const matches =
                html.match(/https?:\/\/[^"']+\.(mp3|aac|ogg)[^"']*/gi) || [];
            if (matches.length > 0) {
                return matches.slice(0, 10);
            }
        } catch (e) {
            // try next source
        }
    }
    return [];
}

/* -------------------------------------------------
   Lyrics search – Google‑based discovery of lyric sites
   ------------------------------------------------- */
async function searchLyrics(query) {
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(
        query + ' lyrics'
    )}`;

    try {
        const html = await utils.fetchPage(googleUrl);
        const matches = html.match(
            /https?:\/\/(?:www\.)?(?:azlyrics|genius|lyrics\.com)\/[^"'\s>]+/gi
        ) || [];
        // unique list, limit to 5
        return [...new Set(matches)].slice(0, 5);
    } catch (e) {
        return [];
    }
}

/* -------------------------------------------------
   Exported API
   ------------------------------------------------- */
module.exports = {
    downloadAlbum,
    searchImages,
    searchVideos,
    searchMusic,
    searchLyrics
};
