'use strict';

// ================================================================
// INTELLIGENT SCRAPER — Standalone API Service
// node-llama-cpp with SmolLM2-135M (fits Render free tier)
// ================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { getLlama, LlamaChatSession } = require('node-llama-cpp');

const PORT = process.env.PORT || 10000;
const MODEL_URL = process.env.MODEL_URL || 'https://huggingface.co/QuantLLM/SmolLM2-135M-GGUF/resolve/main/SmolLM2-135M-GGUF.Q4_K_M.gguf';
const MODEL_PATH = path.join(__dirname, 'models', 'smollm2-135m.Q4_K_M.gguf');
const SCRAPER_LOG_MAX = 300;

// ================================================================
// MODEL INITIALIZATION
// ================================================================
let llama = null;
let model = null;
let context = null;
let modelReady = false;

async function initModel() {
  try {
    const modelDir = path.dirname(MODEL_PATH);
    if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });

    if (!fs.existsSync(MODEL_PATH)) {
      pushScraperLog('info', 'model', 'Downloading SmolLM2-135M (~90MB)...');
      const response = await axios.get(MODEL_URL, { responseType: 'stream', timeout: 120000 });
      const writer = fs.createWriteStream(MODEL_PATH);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      pushScraperLog('success', 'model', 'Model downloaded');
    }

    llama = await getLlama();
    model = await llama.loadModel({ modelPath: MODEL_PATH });
    context = await model.createContext();
    modelReady = true;
    pushScraperLog('success', 'model', 'SmolLM2-135M loaded and ready');
  } catch (e) {
    pushScraperLog('error', 'model', `Model init failed: ${e.message}`);
    modelReady = false;
  }
}

// ================================================================
// LOG BUFFER
// ================================================================
const scraperLogs = [];

function pushScraperLog(level, source, message, meta = {}) {
  const entry = { id: Date.now() + Math.random(), ts: new Date().toISOString(), level, source, message, meta: Object.keys(meta).length ? meta : undefined };
  scraperLogs.push(entry);
  if (scraperLogs.length > SCRAPER_LOG_MAX) scraperLogs.shift();
  console.log(`[${level.toUpperCase()}] [${source}] ${message}`);
}

// ================================================================
// LOCAL AI — SmolLM2
// ================================================================
async function askLocalAI(prompt, systemPrompt) {
  if (!modelReady || !context) {
    pushScraperLog('warn', 'ai', 'Model not ready, cannot generate reply');
    return null;
  }
  const t0 = Date.now();
  try {
    const session = new LlamaChatSession({ contextSequence: context.getSequence() });
    const fullPrompt = `${systemPrompt}\n\nUser: ${prompt}\nAssistant:`;
    const reply = await session.prompt(fullPrompt, { maxTokens: 150, temperature: 0.8 });
    pushScraperLog('info', 'ai', `Reply generated in ${Date.now() - t0}ms`);
    return reply?.trim() || null;
  } catch (e) {
    pushScraperLog('error', 'ai', `Generation failed: ${e.message}`);
    return null;
  }
}

// ================================================================
// TEMP STORAGE (unchanged)
// ================================================================
const TEMP_DIR = path.join(__dirname, 'temp');
fs.mkdirSync(TEMP_DIR, { recursive: true });
const registry = new Map();
const MAX_AGE_MS = 3600000;
const MAX_ITEMS = 200;

function generateId() { return crypto.randomBytes(8).toString('hex'); }

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
// SCRAPER FUNCTIONS — Connect to real sources
// ================================================================
async function searchImages(query, source = 'pornpics') {
  pushScraperLog('info', 'search', `Searching "${query}" on ${source}`);
  try {
    // Connect to your actual scraper source
    // Example: pornpics, darknaija, etc.
    const searchUrl = `https://www.pornpics.com/search/srch.php?q=${encodeURIComponent(query)}&lang=en`;
    const response = await axios.get(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000
    });
    const html = response.data;
    const matches = html.match(/https:\/\/cdni\.pornpics\.com\/[^"']+/g) || [];
    const results = matches.slice(0, 20).map(url => ({ url, source: 'pornpics' }));
    pushScraperLog('info', 'search', `Found ${results.length} results for "${query}"`);
    return { ok: true, data: { query, results, count: results.length } };
  } catch (e) {
    pushScraperLog('error', 'search', `Search failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function searchGifs(query) {
  pushScraperLog('info', 'gif', `Searching GIFs for "${query}"`);
  try {
    const url = `https://api.tenor.com/v1/search?q=${encodeURIComponent(query)}&key=LIVDSRZULELA&limit=10`;
    const response = await axios.get(url, { timeout: 15000 });
    const results = (response.data?.results || []).map(r => ({
      url: r.media?.[0]?.gif?.url,
      preview: r.media?.[0]?.tinygif?.url
    })).filter(r => r.url);
    pushScraperLog('info', 'gif', `Found ${results.length} GIFs for "${query}"`);
    return { ok: true, data: { query, results, count: results.length } };
  } catch (e) {
    pushScraperLog('error', 'gif', `GIF search failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function downloadAlbum(url) {
  pushScraperLog('info', 'album', `Downloading album from ${url}`);
  try {
    const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000 });
    const html = response.data;
    const matches = html.match(/https:\/\/cdni\.pornpics\.com\/[^"']+/g) || [];
    const images = matches.slice(0, 50).map(imgUrl => ({ url: imgUrl }));
    pushScraperLog('info', 'album', `Found ${images.length} images in album`);
    return { ok: true, data: { albumUrl: url, images, count: images.length } };
  } catch (e) {
    pushScraperLog('error', 'album', `Album download failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ================================================================
// EXPRESS APP
// ================================================================
const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), modelReady }));

app.get('/status', (req, res) => res.json({
  ok: true,
  service: 'intelligent-scraper',
  version: '3.0.0',
  uptime: process.uptime(),
  model: { name: 'SmolLM2-135M', ready: modelReady, path: MODEL_PATH },
  logs: scraperLogs.length,
  tempFiles: registry.size
}));

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

app.get('/gif', async (req, res) => {
  const { q } = req.query;
  pushScraperLog('info', 'api', `GET /gif — "${q}"`, { ip: req.ip });
  const result = await searchGifs(q);
  res.json(result);
});

app.post('/chat', async (req, res) => {
  const { prompt, system } = req.body;
  if (!prompt) return res.status(400).json({ ok: false, error: 'prompt required' });
  pushScraperLog('info', 'api', `POST /chat — "${prompt.slice(0, 60)}"`, { ip: req.ip });
  const reply = await askLocalAI(prompt, system || 'You are a helpful assistant.');
  if (!reply) return res.status(503).json({ ok: false, error: 'Model unavailable' });
  res.json({ ok: true, reply });
});

app.post('/cleanup', (req, res) => {
  pushScraperLog('info', 'api', 'POST /cleanup — manual trigger');
  cleanup();
  res.json({ ok: true, remaining: registry.size });
});

app.get('/logs', (req, res) => res.json({ logs: scraperLogs.slice(-200) }));

// ================================================================
// LOG DASHBOARD
// ================================================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scraper API — Logs</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:monospace;background:#0a0e14;color:#c9d1d9;padding:20px}h1{font-size:18px;color:#58a6ff;margin-bottom:4px}.sub{font-size:12px;color:#8b949e;margin-bottom:16px}.card{background:#11161d;border:1px solid #21262d;border-radius:8px;padding:16px;margin-bottom:12px}.card h2{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}.stat-row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid #1c2128}.stat-row:last-child{border-bottom:none}.stat-val{color:#58a6ff;font-weight:600}#logs{height:500px;overflow-y:auto;font-size:12px;line-height:1.7;background:#0a0e14;border-radius:6px;padding:10px}.log-entry{padding:4px 0;border-bottom:1px solid #1c2128}.log-time{color:#484f58;margin-right:8px}.log-info{color:#58a6ff}.log-warn{color:#d29922}.log-error{color:#f85149}.log-source{color:#8b949e;margin-right:8px;font-weight:600}.log-meta{color:#484f58;font-size:11px;margin-left:6px}.green{color:#3fb950}.red{color:#f85149}</style></head><body>
<h1>🔧 Intelligent Scraper — API Logs</h1>
<div class="sub">Only requests from the main WhatsApp bot. No bot logic here.</div>
<div class="card"><h2>Service Status</h2>
<div class="stat-row"><span>Model</span><span class="stat-val" id="modelName">—</span></div>
<div class="stat-row"><span>Model Ready</span><span class="stat-val" id="modelReady">—</span></div>
<div class="stat-row"><span>Uptime</span><span class="stat-val" id="uptime">—</span></div>
<div class="stat-row"><span>Temp Files</span><span class="stat-val" id="tempFiles">—</span></div>
<div class="stat-row"><span>Log Entries</span><span class="stat-val" id="logCount">—</span></div></div>
<div class="card"><h2>Request Log (from main bot)</h2><div id="logs"></div></div>
<script>
const $=id=>document.getElementById(id);
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=Math.floor(s%60);return h+'h '+m+'m '+x+'s';}
async function refresh(){try{const r=await fetch('/status');const d=await r.json();$('modelName').textContent=d.model?.name||'—';$('modelReady').textContent=d.model?.ready?'✅ Ready':'❌ Not Ready';$('uptime').textContent=fmt(d.uptime||0);$('tempFiles').textContent=d.tempFiles||0;$('logCount').textContent=d.logs||0;}catch(e){}}
async function refreshLogs(){try{const r=await fetch('/logs');const d=await r.json();const box=$('logs');box.innerHTML='';for(const en of (d.logs||[]).slice(-100)){const div=document.createElement('div');div.className='log-entry';const t=new Date(en.ts).toLocaleTimeString();const meta=en.meta?' <span class="log-meta">'+esc(JSON.stringify(en.meta))+'</span>':'';div.innerHTML='<span class="log-time">'+t+'</span><span class="log-'+en.level+'">['+en.level.toUpperCase()+']</span> <span class="log-source">'+esc(en.source)+'</span>'+esc(en.message)+meta;box.appendChild(div);}box.scrollTop=box.scrollHeight;}catch(e){}}
refresh();refreshLogs();setInterval(refresh,5000);setInterval(refreshLogs,3000);
</script></body></html>`);
});

// ================================================================
// STARTUP
// ================================================================
app.listen(PORT, async () => {
  pushScraperLog('info', 'system', `Scraper API running on port ${PORT}`);
  pushScraperLog('info', 'system', `Model: SmolLM2-135M (${MODEL_PATH})`);
  await initModel();
});
