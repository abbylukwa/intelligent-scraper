const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const TEMP_DIR = path.join(__dirname, 'temp');
const MAX_AGE_MS = 3600000; // 1 hour
const MAX_ITEMS = 100;

fs.ensureDirSync(TEMP_DIR);

const registry = new Map();

function generateId() {
    return crypto.randomBytes(8).toString('hex');
}

function saveFile(buffer, ext = '.jpg') {
    const id = generateId();
    const filename = `${id}${ext}`;
    const filepath = path.join(TEMP_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    const stats = fs.statSync(filepath);
    registry.set(id, {
        path: filepath,
        timestamp: Date.now(),
        size: stats.size,
        ext: ext
    });
    cleanup();
    return id;
}

function saveAlbum(images) {
    const albumId = generateId();
    const albumFolder = path.join(TEMP_DIR, `album_${albumId}`);
    fs.ensureDirSync(albumFolder);
    const imageIds = [];
    for (let i = 0; i < images.length; i++) {
        const item = images[i];
        let buffer, ext;
        if (Buffer.isBuffer(item)) {
            buffer = item;
            ext = '.jpg';
        } else if (item.buffer && item.ext) {
            buffer = item.buffer;
            ext = item.ext;
        } else if (item.path && fs.existsSync(item.path)) {
            // FIX: downloadAlbum() passes {path, filename, url, size} records from
            // utils.downloadImage(). saveAlbum only handled Buffer/{buffer,ext}, so
            // EVERY album ended up with 0 images and /album/:id/next always 404'd.
            // Read the file from disk, then delete the orphaned temp file.
            try {
                buffer = fs.readFileSync(item.path);
                ext = path.extname(item.path) || '.jpg';
            } catch (e) { continue; }
            try { fs.removeSync(item.path); } catch (e) {}
        } else {
            continue;
        }
        const id = generateId();
        const filename = `${id}${ext}`;
        const filepath = path.join(albumFolder, filename);
        fs.writeFileSync(filepath, buffer);
        const stats = fs.statSync(filepath);
        registry.set(id, {
            path: filepath,
            timestamp: Date.now(),
            size: stats.size,
            ext: ext,
            albumId: albumId
        });
        imageIds.push(id);
    }
    const albumMeta = {
        id: albumId,
        imageIds: imageIds,
        index: 0,
        timestamp: Date.now()
    };
    registry.set(`album_${albumId}`, albumMeta);
    cleanup();
    return albumId;
}

function getNextImage(albumId) {
    const meta = registry.get(`album_${albumId}`);
    if (!meta) return null;
    if (meta.index >= meta.imageIds.length) return null;
    const imageId = meta.imageIds[meta.index];
    meta.index += 1;
    const entry = registry.get(imageId);
    if (!entry) return null;
    return {
        id: imageId,
        path: entry.path,
        ext: entry.ext,
        index: meta.index,
        total: meta.imageIds.length
    };
}

function cleanup() {
    const now = Date.now();
    const toDelete = [];
    for (const [id, entry] of registry) {
        if (id.startsWith('album_')) {
            if (now - entry.timestamp > MAX_AGE_MS) {
                for (const imgId of entry.imageIds) {
                    const imgEntry = registry.get(imgId);
                    if (imgEntry) {
                        try { fs.removeSync(imgEntry.path); } catch(e) {}
                        registry.delete(imgId);
                    }
                }
                toDelete.push(id);
            }
        } else {
            if (now - entry.timestamp > MAX_AGE_MS) {
                toDelete.push(id);
            }
        }
    }
    for (const id of toDelete) {
        const entry = registry.get(id);
        if (entry && entry.path) {
            try { fs.removeSync(entry.path); } catch(e) {}
        }
        registry.delete(id);
    }
    const entries = [...registry.entries()]
        .filter(([id]) => !id.startsWith('album_'))
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const excess = Math.max(0, entries.length - MAX_ITEMS);
    for (let i = 0; i < excess; i++) {
        const [id, entry] = entries[i];
        try { fs.removeSync(entry.path); } catch(e) {}
        registry.delete(id);
    }
    const albumFolders = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith('album_'));
    for (const folder of albumFolders) {
        const fullPath = path.join(TEMP_DIR, folder);
        const contents = fs.readdirSync(fullPath);
        if (contents.length === 0) {
            fs.removeSync(fullPath);
        }
    }
}

function getStats() {
    let totalSize = 0;
    let fileCount = 0;
    for (const [id, entry] of registry) {
        if (id.startsWith('album_')) continue;
        fileCount++;
        totalSize += entry.size || 0;
    }
    return {
        fileCount,
        totalSizeMB: (totalSize / 1024 / 1024).toFixed(2)
    };
}

module.exports = {
    TEMP_DIR,
    saveFile,
    saveAlbum,
    getNextImage,
    cleanup,
    getStats
};
