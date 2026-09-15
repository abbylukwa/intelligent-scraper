const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// User agents for rotation
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

async function fetchPage(url) {
    try {
        const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'max-age=0'
            },
            timeout: 15000,
            maxRedirects: 5
        });
        
        return response.data;
    } catch (error) {
        console.error(`Failed to fetch ${url}:`, error.message);
        throw error;
    }
}

async function downloadImage(url) {
    try {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            headers: {
                'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                'Referer': new URL(url).origin
            },
            timeout:13200000
        });
        
        const filename = crypto.createHash('md5').update(url).digest('hex') + '.jpg';
        const filepath = path.join(__dirname, 'temp', filename);
        
        const writer = fs.createWriteStream(filepath);
        response.data.pipe(writer);
        
        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve({
                path: filepath,
                filename: filename,
                url: url,
                size: fs.statSync(filepath).size
            }));
            writer.on('error', reject);
        });
    } catch (error) {
        console.error(`Failed to download image ${url}:`, error.message);
        return null;
    }
}

function extractImageUrls(html, baseUrl) {
    const $ = require('cheerio').load(html);
    const images = [];
    
    $('img').each((i, elem) => {
        let src = $(elem).attr('src') || $(elem).attr('data-src') || $(elem).attr('data-original');
        
        if (src) {
            // Convert relative URLs to absolute
            if (src.startsWith('//')) {
                src = 'https:' + src;
            } else if (src.startsWith('/')) {
                src = new URL(baseUrl).origin + src;
            } else if (!src.startsWith('http')) {
                src = baseUrl + '/' + src;
            }
            
            // Filter out data URLs and very small images
            if (!src.startsWith('data:') && !src.includes('icon') && !src.includes('logo')) {
                images.push(src);
            }
        }
    });
    
    return [...new Set(images)]; // Remove duplicates
}

module.exports = {
    fetchPage,
    downloadImage,
    extractImageUrls
};
