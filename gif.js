const axios = require('axios');

async function search(query) {
    // GIPHY public beta key (works without signup)
    const giphyUrl = `https://api.giphy.com/v1/gifs/search?api_key=dc6zaTOxFJmzC&q=${encodeURIComponent(query)}&limit=5`;
    try {
        const response = await axios.get(giphyUrl, { timeout: 15000 });
        const gifs = response.data.data.map(g => g.images.original.url);
        if (gifs.length > 0) return gifs;
    } catch (e) {
        console.error('GIPHY error:', e.message);
    }
    return [];
}

module.exports = { search };
