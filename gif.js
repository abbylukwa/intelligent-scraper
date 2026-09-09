const axios = require('axios');
const cheerio = require('cheerio');

async function search(query) {
    const url = `https://hardgif.com/search/${encodeURIComponent(query)}`;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    try {
        const { data } = await axios.get(url, { headers, timeout: 10000 });
        const $ = cheerio.load(data);
        const gifUrls = [];
        $('img[src*=".gif"]').each((i, el) => {
            let src = $(el).attr('src');
            if (src) {
                if (src.startsWith('//')) src = 'https:' + src;
                if (src.startsWith('/')) src = 'https://hardgif.com' + src;
                gifUrls.push(src);
            }
        });
        $('a[href*=".gif"]').each((i, el) => {
            let href = $(el).attr('href');
            if (href) {
                if (href.startsWith('//')) href = 'https:' + href;
                if (href.startsWith('/')) href = 'https://hardgif.com' + href;
                gifUrls.push(href);
            }
        });
        return [...new Set(gifUrls)];
    } catch (e) {
        console.error('GIF search error:', e.message);
        return [];
    }
}

module.exports = { search };
