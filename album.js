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
    const attempts = [
        { 
            site: 'darknaija', 
            url: `https://darknaija.com/?s=${encodeURIComponent(query)}`,
            extractor: extractDarkNaijaImages
        },
        { 
            site: 'pornpics', 
            url: `https://www.pornpics.com/search/?q=${encodeURIComponent(query)}`,
            extractor: extractPornPicsImages
        },
        { 
            site: 'pornpics_alt', 
            url: `https://www.pornpics.com/search/srch.php?q=${encodeURIComponent(query)}&lang=en`,
            extractor: extractPornPicsImages
        },
        { 
            site: 'reddit', 
            url: `https://old.reddit.com/r/boobs/top/.json?limit=20`,
            extractor: extractRedditImages
        },
        { 
            site: 'imagefaqs', 
            url: `https://www.imagefaqs.com/search?q=${encodeURIComponent(query)}`,
            extractor: extractImageFaqsImages
        }
    ];

    for (const attempt of attempts) {
        try {
            const html = await utils.fetchPage(attempt.url);
            let imageUrls = [];
            
            if (attempt.extractor) {
                imageUrls = await attempt.extractor(html, attempt.url);
            } else {
                imageUrls = await utils.extractImageUrls(html, attempt.url);
            }
            
            if (imageUrls.length > 0) {
                console.log(`Found ${imageUrls.length} images from ${attempt.site}`);
                // FIX: was `slice(0, dic20)` — undefined variable crashed every successful
                // search, so /search always returned []. Cap at 20 images.
                return imageUrls.slice(0, 20);
            }
        } catch (e) {
            console.error(`Failed to scrape ${attempt.site}:`, e.message);
            continue;
        }
    }
    return [];
}

// Site-specific extractors
async function extractDarkNaijaImages(html, url) {
    const $ = require('cheerio').load(html);
    const images = [];
    $('img').each((i, elem) => {
        const src = $(elem).attr('src');
        if (src && src.includes('darknaija')) {
            images.push(src);
        }
    });
    return images;
}

async function extractPornPicsImages(html, url) {
    const $ = require('cheerio').load(html);
    const images = [];
    $('.thumb img, .image img, img[data-src]').each((i, elem) => {
        const src = $(elem).attr('src') || $(elem).attr('data-src');
        if (src && (src.includes('pornpics.com') || src.includes('image'))) {
            images.push(src.startsWith('http') ? src : `https:${src}`);
        }
    });
    return images;
}

async function extractRedditImages(html, url) {
    try {
        const json = JSON.parse(html);
        return json.data.children
            .map(p => p.data.url)
            .filter(url => /\.(jpg|jpeg|png|gif|webp)$/i.test(url))
            .slice(0, 20);
    } catch (e) {
        return [];
    }
}

async function extractImageFaqsImages(html, url) {
    const $ = require('cheerio').load(html);
    const images = [];
    $('.post img, .content img, img.thumbnail').each((i, elem) => {
        const src = $(elem).attr('src');
        if (src && !src.startsWith('data:')) {
            images.push(src.startsWith('http') ? src : `https://www.imagefaqs.com${src}`);
        }
    });
    return images;
}

async function searchVideos(query) {
    const attempts = [
        { 
            site: 'pornhub', 
            url: `https://www.pornhub.com/search/?search=${encodeURIComponent(query)}`,
            extractor: extractPornhubVideos
        },
        { 
            site: 'xhamster', 
            url: `https://www.xhamster.com/search?keyword=${encodeURIComponent(query)}`,
            extractor: extractXhamsterVideos
        },
        { 
            site: 'spankyou', 
            url: `https://spankyou.com/search?q=${encodeURIComponent(query)}`,
            extractor: extractSpankyouVideos
        }
    ];

    for (const attempt of attempts) {
        try {
            await new Promise(resolve => setTimeout(resolve, 500)); // Rate limiting
            const html = await utils.fetchPage(attempt.url);
            let videoUrls = [];
            
            if (attempt.extractor) {
                videoUrls = await attempt.extractor(html);
            } else {
                // Fallback regex extraction
                const matches = html.match(/https?:\/\/[^"'\s<>]+\.(mp4|m3u8|webm)[^"'\s<>]*/g) || [];
                videoUrls = matches;
            }
            
            if (videoUrls.length > 0) {
                console.log(`Found ${videoUrls.length} videos from ${attempt.site}`);
                return [...new Set(videoUrls)].slice(0, 10);
            }
        } catch (e) {
            console.error(`Failed to scrape videos from ${attempt.site}:`, e.message);
            continue;
        }
    }
    return [];
}

// Video extractors
async function extractPornhubVideos(html) {
    const $ = require('cheerio').load(html);
    const videos = [];
    
    // Look for video links and embed URLs
    $('a[href*="/view_video.php"], a[href*="/video"]').each((i, elem) => {
        const href = $(elem).attr('href');
        if (href && href.includes('pornhub')) {
            videos.push(href.startsWith('http') ? href : `https://www.pornhub.com${href}`);
        }
    });
    
    // Also look for video sources in script tags
    const scriptRegex = /https?:\/\/[^"'\s]+\.(mp4|m3u8|webm)[^"'\s]*/gi;
    const scriptMatches = html.match(scriptRegex) || [];
    videos.push(...scriptMatches);
    
    return [...new Set(videos)];
}

async function extractXhamsterVideos(html) {
    const $ = require('cheerio').load(html);
    const videos = [];
    
    $('a[href*="/videos/"], video source').each((i, elem) => {
        const href = $(elem).attr('href') || $(elem).attr('src');
        if (href && (href.includes('.mp4') || href.includes('/videos/'))) {
            videos.push(href.startsWith('http') ? href : `https://xhamster.com${href}`);
        }
    });
    
    return [...new Set(videos)];
}

async function extractSpankyouVideos(html) {
    // Regex fallback for spankyou
    const regex = /https?:\/\/[^"'\s]+\.(mp4|m3u8|webm)[^"'\s]*/gi;
    return (html.match(regex) || []).filter(url => url.includes('spankyou'));
}

async function searchMusic(query) {
    const attempts = [
        { 
            site: 'y2mate', 
            url: `https://www.y2mate.com/search?q=${encodeURIComponent(query)}`,
            extractor: extractY2MateMusic
        },
        { 
            site: 'mp3juices', 
            url: `https://mp3juices.cc/search/?q=${encodeURIComponent(query)}`,
            extractor: extractMp3JuicesMusic
        },
        { 
            site: 'pagalworld', 
            url: `https://pagalworld.com/search/${encodeURIComponent(query)}`,
            extractor: extractPagalworldMusic
        }
    ];

    for (const attempt of attempts) {
        try {
            // FIX: was `invo500` — undefined variable threw inside try, so every
            // attempt failed and /search-music always returned []. Rate limit = 500ms.
            await new Promise(resolve => setTimeout(resolve, 500)); // Rate limiting
            const html = await utils.fetchPage(attempt.url);
            let musicUrls = [];
            
            if (attempt.extractor) {
                musicUrls = await attempt.extractor(html);
            } else {
                // Fallback regex
                const matches = html.match(/https?:\/\/[^"'\s]+\.(mp3|aac|ogg|wav|flac)[^"'\s]*/gi) || [];
                musicUrls = matches;
            }
            
            if (musicUrls.length > 0) {
                console.log(`Found ${musicUrls.length} music links from ${attempt.site}`);
                return [...new Set(musicUrls)].slice(0, 10);
            }
        } catch (e) {
            console.error(`Failed to scrape music from ${attempt.site}:`, e.message);
            continue;
        }
    }
    return [];
}

// Music extractors
async function extractY2MateMusic(html) {
    const $ = require('cheerio').load(html);
    const music = [];
    
    $('a[href*="download"], a[href*=".mp3"], button[data-url]').each((i, elem) => {
        const href = $(elem).attr('href') || $(elem).attr('data-url') || $(elem).attr('data-src');
        if (href && href.match(/\.(mp3|aac|ogg)$/i)) {
            music.push(href);
        }
    });
    
    return music;
}

async function extractMp3JuicesMusic(html) {
    const $ = require('cheerio').load(html);
    const music = [];
    
    $('.download-btn, .download-button, a.download').each((i, elem) => {
        const href = $(elem).attr('href');
        if (href && href.includes('download') && href.match(/\.mp3$/i)) {
            music.push(href);
        }
    });
    
    return music;
}

async function extractPagalworldMusic(html) {
    const $ = require('cheerio').load(html);
    const music = [];
    
    $('a[href*=".mp3"], a[href*="download.php"]').each((i, elem) => {
        const href = $(elem).attr('href');
        if (href && href.includes('pagalworld')) {
            music.push(href.startsWith('http') ? href : `https://pagalworld.com${href}`);
        }
    });
    
    return music;
}

async function searchLyrics(query) {
    const googleQuery = `https://www.google.com/search?q=${encodeURIComponent(query + " lyrics")}`;
    
    try {
        const html = await utils.fetchPage(googleQuery);
        const $ = require('cheerio').load(html);
        const lyricLinks = [];
        
        // Extract Google search results
        $('a[href*="azlyrics.com"], a[href*="genius.com"], a[href*="lyrics.com"]').each((i, elem) => {
            const href = $(elem).attr('href');
            if (href && href.startsWith('/url?q=')) {
                const decodedUrl = decodeURIComponent(href.split('/url?q=')[1].split('&')[0]);
                if (decodedUrl.includes('lyrics')) {
                    lyricLinks.push(decodedUrl);
                }
            }
        });
        
        // Also try direct regex for common lyric sites
        const regex = /https?:\/\/(?:www\.)?(?:azlyrics\.com|genius\.com|lyrics\.com)\/[^"'\s>]+/gi;
        const regexMatches = html.match(regex) || [];
        
        return [...new Set([...lyricLinks, ...regexMatches])].slice(0, 5);
    } catch (e) {
        console.error('Failed to search lyrics:', e.message);
        return [];
    }
}

module.exports = {
    downloadAlbum,
    searchImages,
    searchVideos,
    searchMusic,
    searchLyrics
};
