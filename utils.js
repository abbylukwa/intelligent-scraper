const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

async function fetchPage(url) {
    const response = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    return response.data;
}

async function extractImageUrls(html, baseUrl) {
    const $ = cheerio.load(html);
    const urls = [];
    $('img').each((i, el) => {
        let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-original');
        if (src) {
            if (src.includes('logo') || src.includes('icon') || src.includes('thumb')) return;
            if (src.startsWith('//')) src = 'https:' + src;
            if (src.startsWith('/')) src = new URL(src, baseUrl).href;
            if (/\.(jpg|jpeg|png|gif|webp)$/i.test(src)) {
                urls.push(src);
            }
        }
    });
    $('a[href]').each((i, el) => {
        let href = $(el).attr('href');
        if (href && /\.(jpg|jpeg|png|gif|webp)$/i.test(href)) {
            if (href.startsWith('//')) href = 'https:' + href;
            if (href.startsWith('/')) href = new URL(href, baseUrl).href;
            urls.push(href);
        }
    });
    return [...new Set(urls)];
}

async function downloadImage(url) {
    try {
        const response = await axios.get(url, {
            headers: HEADERS,
            responseType: 'arraybuffer',
            timeout: 15000
        });
        const buffer = Buffer.from(response.data);
        const ext = path.extname(url) || '.jpg';
        return { buffer, ext };
    } catch (e) {
        console.error('Download failed for', url, e.message);
        return null;
    }
}

module.exports = {
    fetchPage,
    extractImageUrls,
    downloadImage
};
