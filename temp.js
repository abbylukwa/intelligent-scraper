const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const TEMP_DIR = path.join(__dirname, 'temp');
const MAX_AGE_MS = 3600000; // 1 hour
const MAX_ITEMS = 200;
const MAX_ALBUM_ITEMS = 50;

fs.ensureDirSync(TEMP_DIR);

// registry: id -> { path, timestamp, size, ext, albumId?, type? }
// album_<id> -> { id, imageIds, index, timestamp, title?, source? }
const registry = new Map();

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

// ─── Save a single file ──────────────────────────────
function saveFile(buffer, ext = '.jpg', metadata = {}) {
  const id = generateId();
  const filename = `${id}${ext}`;
  const filepath = path.join(TEMP_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  const stats = fs.statSync(filepath);
  registry.set(id, {
    path: filepath,
    timestamp: Date.now(),
    size: stats.size,
    ext,
    ...metadata
  });
  cleanup();
  return id;
}

// ─── Save an album ───────────────────────────────────
function saveAlbum(images, metadata = {}) {
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
      ext,
      albumId
    });
    imageIds.push(id);
  }

  const albumMeta = {
    id: albumId,
    imageIds,
    index: 0,
    timestamp: Date.now(),
    title: metadata.title || '',
    source: metadata.source || '',
    total: imageIds.length
  };
  registry.set(`album_${albumId}`, albumMeta);
  cleanup();
  return albumId;
}

// ─── Get next image from album ───────────────────────
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
    size: entry.size,
    index: meta.index,
    total: meta.imageIds.length,
    albumId
  };
}

// ─── Get previous image from album ───────────────────
function getPrevImage(albumId) {
  const meta = registry.get(`album_${albumId}`);
  if (!meta) return null;
  if (meta.index <= 1) return null; // Already at first

  meta.index -= 2; // Go back two (one for the current, one for previous)
  if (meta.index < 0) meta.index = 0;

  const imageId = meta.imageIds[meta.index];
  meta.index += 1;
  const entry = registry.get(imageId);
  if (!entry) return null;

  return {
    id: imageId,
    path: entry.path,
    ext: entry.ext,
    size: entry.size,
    index: meta.index,
    total: meta.imageIds.length,
    albumId
  };
}

// ─── Get specific image by index ─────────────────────
function getImageAt(albumId, idx) {
  const meta = registry.get(`album_${albumId}`);
  if (!meta) return null;
  if (idx < 0 || idx >= meta.imageIds.length) return null;

  meta.index = idx;
  const imageId = meta.imageIds[idx];
  meta.index = idx + 1;
  const entry = registry.get(imageId);
  if (!entry) return null;

  return {
    id: imageId,
    path: entry.path,
    ext: entry.ext,
    size: entry.size,
    index: meta.index,
    total: meta.imageIds.length,
    albumId
  };
}

// ─── Get album info ──────────────────────────────────
function getAlbumInfo(albumId) {
  const meta = registry.get(`album_${albumId}`);
  if (!meta) return null;
  return {
    id: meta.id,
    title: meta.title,
    source: meta.source,
    total: meta.imageIds.length,
    currentIndex: meta.index,
    timestamp: meta.timestamp
  };
}

// ─── Get file by ID ──────────────────────────────────
function getFile(id) {
  return registry.get(id) || null;
}

// ─── Cleanup ─────────────────────────────────────────
function cleanup() {
  const now = Date.now();
  const toDelete = [];

  for (const [id, entry] of registry) {
    if (id.startsWith('album_')) {
      if (now - entry.timestamp > MAX_AGE_MS) {
        for (const imgId of entry.imageIds) {
          const imgEntry = registry.get(imgId);
          if (imgEntry) {
            try { fs.removeSync(imgEntry.path); } catch (e) {}
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
      try { fs.removeSync(entry.path); } catch (e) {}
    }
    registry.delete(id);
  }

  // Enforce max items
  const entries = [...registry.entries()]
    .filter(([id]) => !id.startsWith('album_'))
    .sort((a, b) => a[1].timestamp - b[1].timestamp);

  const excess = Math.max(0, entries.length - MAX_ITEMS);
  for (let i = 0; i < excess; i++) {
    const [id, entry] = entries[i];
    try { fs.removeSync(entry.path); } catch (e) {}
    registry.delete(id);
  }

  // Remove empty album folders
  try {
    const albumFolders = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith('album_'));
    for (const folder of albumFolders) {
      const fullPath = path.join(TEMP_DIR, folder);
      if (fs.existsSync(fullPath) && fs.readdirSync(fullPath).length === 0) {
        fs.removeSync(fullPath);
      }
    }
  } catch (e) {}
}

// ─── Stats ───────────────────────────────────────────
function getStats() {
  let totalSize = 0;
  let fileCount = 0;
  let albumCount = 0;

  for (const [id, entry] of registry) {
    if (id.startsWith('album_')) {
      albumCount++;
      continue;
    }
    fileCount++;
    totalSize += entry.size || 0;
  }

  return {
    fileCount,
    albumCount,
    totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
    registrySize: registry.size
  };
}

module.exports = {
  TEMP_DIR,
  saveFile,
  saveAlbum,
  getNextImage,
  getPrevImage,
  getImageAt,
  getAlbumInfo,
  getFile,
  cleanup,
  getStats
};
