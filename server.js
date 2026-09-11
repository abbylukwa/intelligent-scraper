'use strict';

// ================================================================
// INTELLIGENT SCRAPER — Standalone API Service
// Scraper bridge + Ollama local AI endpoint
// No WhatsApp, no bot logic — pure API for whatsapp-qr-app to call
// ================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const PORT = process.env.PORT || 10000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2:0.5b';
const SCRAPER_LOG_MAX = 300;

// ================================================================
// LOG BUFFER — only shows requests from main bot + errors
// ================================================================
const scraperLogs = [];

function pushScraperLog(level, source, message, meta = {}) {
  const entry = {
    id: Date.now() + Math.random(),
    ts: new Date().toISOString(),
    level, source, message,
    meta: Object.keys(meta).length ? meta : undefined
  };
  scraperLogs.push(entry);
  if (scraperLogs.length > SCRAPER_LOG_MAX) scraperLogs.shift();
  console.log(`[${level.toUpperCase()}] [${source}] ${message}`);
}

// ================================================================
// TEMP STORAGE (moved from temp.js — self-contained)
// ================================================================
const TEMP_DIR = path.join(__dirname, 'temp');
fs.mkdirSync(TEMP_DIR, { recursive: true });

const registry = new Map();
const MAX_AGE_MS = 3600000;
const MAX_ITEMS = 200;
const MAX_ALBUM_ITEMS = 50;

function generateId() { return crypto.randomBytes(8).toString('hex'); }

function saveFile(buffer, ext = '.jpg', metadata = {}) {
  const id = generateId();
  const filename = `${id}${ext}`;
  const filepath = path.join(TEMP_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  const stats = fs.statSync(filepath);
  registry.set(id, { path: filepath, timestamp: Date.now(), size: stats.size, ext, ...metadata });
  cleanup();
  return id;
}

function saveAlbum(images, metadata = {}) {
  const albumId = generateId();
  const albumFolder = path.join(TEMP_DIR, `album_${albumId}`);
  fs.mkdirSync(albumFolder, { recursive: true });
  const imageIds = [];
  for (const item of images) {
    let buffer, ext;
    if (Buffer.isBuffer(item)) { buffer = item; ext = '.jpg'; }
    else if (item.buffer && item.ext) { buffer = item.buffer; ext = item.ext; }
    else continue;
    const id = generateId();
    const filepath = path.join(albumFolder, `${id}${ext}`);
    fs.writeFileSync(filepath, buffer);
    registry.set(id, { path: filepath, timestamp: Date.now(), size: buffer.length, ext, albumId });
    imageIds.push(id);
  }
  registry.set(`album_${albumId}`, {
    id: albumId, imageIds, index: 0, timestamp: Date.now(),
    title: metadata.title || '', source: metadata.source || '', total: imageIds.length
  });
  cleanup();
  return albumId;
}

function getNextImage(albumId) {
  const meta = registry.get(`album_${albumId}`);
  if (!meta || meta.index >= meta.imageIds.length) return null;
  const imageId = meta.imageIds[meta.index];
  meta.index += 1;
  const entry = registry.get(imageId);
  if (!entry) return null;
  return { id: imageId, path: entry.path, ext: entry.ext, size: entry.size, index: meta.index, total: meta.imageIds.length, albumId };
}

function cleanup() {
  const now = Date.now();
  let removed = 0;
  for (const [id, entry] of registry) {
    if (id.startsWith('album_')) continue;
    if (now - entry.timestamp > MAX_AGE_MS || registry.size > MAX_ITEMS) {
      try { fs.unlinkSync(entry.path); } catch (e) {}
      registry.delete(id);
      removed++;
    }
  }
  if (removed > 0) pushScraperLog('info', 'cleanup', `Removed ${removed} expired files`);
}

// ================================================================
// SCRAPER FUNCTIONS (placeholder — connect to your sources)
// ================================================================
async function searchImages(query, source = 'pornpics') {
  pushScraperLog('info', 'search', `Searching "${query}" on ${source}`);
  // TODO: Connect to actual scraper sources (pornpics, darknaija, etc.)
  // Return format: { ok: true, data: { results: [...] } }
  return { ok: false, error: 'Scraper sources not configured yet' };
}

async function searchGifs(query) {
  pushScraperLog('info', 'gif', `Searching GIFs for "${query}"`);
  return { ok: false, error: 'GIF source not configured yet' };
}

async function downloadAlbum(url) {
  pushScraperLog('info', 'album', `Downloading album from ${url}`);
  return { ok: false, error: 'Album download not configured yet' };
}

// ================================================================
// OLLAMA LOCAL AI
// ================================================================
async function askOllama(prompt, systemPrompt) {
  const t0 = Date.now();
  try {
    const r = await axios.post(`${OLLAMA_URL}/api/chat`, {
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      stream: false
    }, { timeout: 30000 });
    const text = r.data?.message?.content;
    pushScraperLog('info', 'ollama', `Reply generated in ${Date.now() - t0}ms`, { model: OLLAMA_MODEL });
    return text || null;
  } catch (e) {
    pushScraperLog('error', 'ollama', `Ollama failed: ${e.message}`, { url: OLLAMA_URL, model: OLLAMA_MODEL });
    return null;
  }
}

// ================================================================
// EXPRESS APP — API only, no WhatsApp, no QR
// ================================================================
const app = express();
app.use(express.json({ limit: '10mb' }));

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), ollama: OLLAMA_URL, model: OLLAMA_MODEL });
});

// --- Status ---
app.get('/status', (req, res) => {
  res.json({
    ok: true,
    service: 'intelligent-scraper',
    version: '2.0.0',
    uptime: process.uptime(),
    ollama: { url: OLLAMA_URL, model: OLLAMA_MODEL, reachable: false },
    logs: scraperLogs.length,
    tempFiles: registry.size
  });
});

// --- Scraper endpoints (called by main bot) ---
app.post('/search', async (req, res) => {
  const { query, q, source } = req.body;
  const searchQuery = query || q;
  pushScraperLog('info', 'api', `POST /search — "${searchQuery}"`, { source: source || 'default', ip: req.ip });
  const result = await searchImages(searchQuery, source);
  res.json(result);
});

app.post('/album', async (req, res) => {
  const { url } = req.body;
  pushScraperLog('info', 'api', `POST /album — ${url}`, { ip: req.ip });
  const result = await downloadAlbum(url);
  res.json(result);
});

app.get('/album/:albumId/next', (req, res) => {
  const { albumId } = req.params;
  const image = getNextImage(albumId);
  pushScraperLog('info', 'api', `GET /album/${albumId}/next — ${image ? 'found' : 'not found'}`, { ip: req.ip });
  if (!image) return res.status(404).json({ ok: false, error: 'No next image' });
  res.json({ ok: true, data: image });
});

app.get('/gif', async (req, res) => {
  const { q } = req.query;
  pushScraperLog('info', 'api', `GET /gif — "${q}"`, { ip: req.ip });
  const result = await searchGifs(q);
  res.json(result);
});

// --- Ollama chat endpoint (called by main bot for group replies) ---
app.post('/chat', async (req, res) => {
  const { prompt, system } = req.body;
  if (!prompt) return res.status(400).json({ ok: false, error: 'prompt required' });
  pushScraperLog('info', 'api', `POST /chat — "${prompt.slice(0, 60)}"`, { ip: req.ip });
  const reply = await askOllama(prompt, system || 'You are a helpful assistant.');
  if (!reply) return res.status(503).json({ ok: false, error: 'Ollama unavailable' });
  res.json({ ok: true, reply });
});

// --- Cleanup ---
app.post('/cleanup', (req, res) => {
  pushScraperLog('info', 'api', 'POST /cleanup — manual trigger');
  cleanup();
  res.json({ ok: true, remaining: registry.size });
});

// ================================================================
// LOG DASHBOARD — only shows API requests from main bot + errors
// ================================================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scraper API — Logs</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,monospace;background:#0a0e14;color:#c9d1d9;padding:20px}
h1{font-size:18px;color:#58a6ff;margin-bottom:4px}
.sub{font-size:12px;color:#8b949e;margin-bottom:16px}
.card{background:#11161d;border:1px solid #21262d;border-radius:8px;padding:16px;margin-bottom:12px}
.card h2{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
.stat-row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid #1c2128}
.stat-row:last-child{border-bottom:none}
.stat-val{color:#58a6ff;font-weight:600}
#logs{height:500px;overflow-y:auto;font-size:12px;line-height:1.7;background:#0a0e14;border-radius:6px;padding:10px}
.log-entry{padding:4px 0;border-bottom:1px solid #1c2128}
.log-time{color:#484f58;margin-right:8px}
.log-info{color:#58a6ff}.log-warn{color:#d29922}.log-error{color:#f85149}
.log-source{color:#8b949e;margin-right:8px;font-weight:600}
.log-meta{color:#484f58;font-size:11px;margin-left:6px}
.green{color:#3fb950}.red{color:#f85149}
</style></head><body>
<h1>🔧 Intelligent Scraper — API Logs</h1>
<div class="sub">This dashboard shows only requests from the main WhatsApp bot. No bot logic here.</div>
<div class="card">
<h2>Service Status</h2>
<div class="stat-row"><span>Ollama URL</span><span class="stat-val" id="ollamaUrl">—</span></div>
<div class="stat-row"><span>Ollama Model</span><span class="stat-val" id="ollamaModel">—</span></div>
<div class="stat-row"><span>Uptime</span><span class="stat-val" id="uptime">—</span></div>
<div class="stat-row"><span>Temp Files</span><span class="stat-val" id="tempFiles">—</span></div>
<div class="stat-row"><span>Log Entries</span><span class="stat-val" id="logCount">—</span></div>
</div>
<div class="card"><h2>Request Log (from main bot)</h2><div id="logs"></div></div>
<script>
const $ = id => document.getElementById(id);
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=Math.floor(s%60);return h+'h '+m+'m '+x+'s';}
async function refresh(){
  try{
    const r = await fetch('/status'); const d = await r.json();
    $('ollamaUrl').textContent = d.ollama?.url || '—';
    $('ollamaModel').textContent = d.ollama?.model || '—';
    $('uptime').textContent = fmt(d.uptime||0);
    $('tempFiles').textContent = d.tempFiles || 0;
    $('logCount').textContent = d.logs || 0;
  }catch(e){}
}
async function refreshLogs(){
  try{
    const r = await fetch('/logs'); const d = await r.json();
    const box = $('logs');
    box.innerHTML = '';
    for(const en of (d.logs||[]).slice(-100)){
      const div = document.createElement('div');
      div.className='log-entry';
      const t = new Date(en.ts).toLocaleTimeString();
      const meta = en.meta ? ' <span class="log-meta">'+esc(JSON.stringify(en.meta))+'</span>' : '';
      div.innerHTML = '<span class="log-time">'+t+'</span><span class="log-'+en.level+'">['+en.level.toUpperCase()+']</span> <span class="log-source">'+esc(en.source)+'</span>'+esc(en.message)+meta;
      box.appendChild(div);
    }
    box.scrollTop = box.scrollHeight;
  }catch(e){}
}
refresh(); refreshLogs(); setInterval(refresh,5000); setInterval(refreshLogs,3000);
</script></body></html>`);
});

// --- Logs API for the dashboard ---
app.get('/logs', (req, res) => {
  res.json({ logs: scraperLogs.slice(-200) });
});

// ================================================================
// STARTUP
// ================================================================
app.listen(PORT, () => {
  pushScraperLog('info', 'system', `Scraper API running on port ${PORT}`);
  pushScraperLog('info', 'system', `Ollama: ${OLLAMA_URL} (model: ${OLLAMA_MODEL})`);
  console.log(`\n🔧 Intelligent Scraper API`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Ollama: ${OLLAMA_URL} / ${OLLAMA_MODEL}`);
  console.log(`   Dashboard: http://localhost:${PORT}/`);
  console.log(`   API endpoints:`);
  console.log(`     GET  /health`);
  console.log(`     GET  /status`);
  console.log(`     POST /search   { query, source }`);
  console.log(`     POST /album    { url }`);
  console.log(`     GET  /album/:albumId/next`);
  console.log(`     GET  /gif?q=...`);
  console.log(`     POST /chat     { prompt, system }`);
  console.log(`     POST /cleanup`);
});
