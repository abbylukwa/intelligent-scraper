'use strict';

// ================================================================
// INTELLIGENT SCRAPER — API Service + Local LLM Chat
// Original scraper preserved | SmolLM2 via dynamic import (ESM fix)
// ================================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

// Original scraper modules (unchanged)
const album = require('./album');
const gif = require('./gif');
const temp = require('./temp');

// ================================================================
// CONFIG
// ================================================================
const PORT = process.env.PORT || 10000;
const MODEL_URL = process.env.MODEL_URL || 'https://huggingface.co/QuantLLM/SmolLM2-135M-GGUF/resolve/main/SmolLM2-135M-GGUF.Q4_K_M.gguf';
const MODEL_PATH = path.join(__dirname, 'models', 'smollm2-135m.Q4_K_M.gguf');
const SCRAPER_LOG_MAX = 300;

// ================================================================
// LOG BUFFER
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
// LOCAL LLM — SmolLM2 via dynamic import (fixes ESM crash)
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
      pushScraperLog('info', 'model', 'Downloading SmolLM2-135M (~105MB)...');
      const response = await axios.get(MODEL_URL, {
        responseType: 'stream',
        timeout: 300000
      });
      const writer = fs.createWriteStream(MODEL_PATH);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      pushScraperLog('success', 'model', 'Model downloaded');
    }

    // ── ESM FIX: dynamic import() instead of require() ──
    const nlc = await import('node-llama-cpp');
    const { getLlama, LlamaChatSession } = nlc;

    llama = await getLlama({ gpu: false });
    model = await llama.loadModel({ modelPath: MODEL_PATH });
    context = await model.createContext({ contextSize: 512 });
    modelReady = true;

    pushScraperLog('success', 'model', `SmolLM2-135M loaded (ctx=512, CPU-only)`);
  } catch (e) {
    pushScraperLog('error', 'model', `Model init failed: ${e.message}`);
    modelReady = false;
  }
}

async function askLocalAI(prompt, systemPrompt) {
  if (!modelReady || !context) {
    pushScraperLog('warn', 'ai', 'Model not ready');
    return null;
  }
  const t0 = Date.now();
  try {
    const nlc = await import('node-llama-cpp');
    const { LlamaChatSession } = nlc;
    const session = new LlamaChatSession({ contextSequence: context.getSequence() });
    const fullPrompt = `${systemPrompt}\n\nUser: ${prompt}\nAssistant:`;
    const reply = await session.prompt(fullPrompt, {
      maxTokens: 150,
      temperature: 0.8
    });
    pushScraperLog('info', 'ai', `Reply in ${Date.now() - t0}ms`);
    return reply?.trim() || null;
  } catch (e) {
    pushScraperLog('error', 'ai', `Generation failed: ${e.message}`);
    return null;
  }
}

// ================================================================
// EXPRESS APP
// ================================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve temp files
app.use('/temp', express.static(temp.TEMP_DIR));

// ── Health / Status ──
app.get('/status', (req, res) => {
  const stats = temp.getStats();
  res.json({
    status: 'ok',
    service: 'intelligent-scraper',
    version: '3.1.0',
    uptime: process.uptime(),
    model: { name: 'SmolLM2-135M', ready: modelReady },
    tempFiles: stats.fileCount,
    tempSizeMB: stats.totalSizeMB,
    logs: scraperLogs.length
  });
});

// ── Search images (original logic preserved) ──
app.post('/search', async (req, res) => {
  try {
    const { query, site = 'pornpics' } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });
    pushScraperLog('info', 'api', `POST /search — "${query}"`, { site, ip: req.ip });
    const urls = await album.searchImages(query, site);
    pushScraperLog('info', 'search', `Found ${urls.length} images`);
    res.json({ images: urls });
  } catch (e) {
    pushScraperLog('error', 'search', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Download album (original logic preserved) ──
app.post('/album', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    pushScraperLog('info', 'api', `POST /album — ${url}`, { ip: req.ip });
    const albumId = await album.downloadAlbum(url);
    pushScraperLog('success', 'album', `Album created: ${albumId}`);
    res.json({ albumId });
  } catch (e) {
    pushScraperLog('error', 'album', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Get next image (original logic preserved) ──
app.get('/album/:albumId/next', (req, res) => {
  try {
    const { albumId } = req.params;
    const image = temp.getNextImage(albumId);
    if (!image) return res.status(404).json({ error: 'Album empty or not found' });
    const imageUrl = `/temp/${path.basename(image.path)}`;
    pushScraperLog('info', 'api', `GET /album/${albumId}/next — image ${image.index}/${image.total}`);
    res.json({ imageId: image.id, url: imageUrl, index: image.index, total: image.total });
  } catch (e) {
    pushScraperLog('error', 'album', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Search GIF (original logic preserved) ──
app.get('/gif', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    pushScraperLog('info', 'api', `GET /gif — "${q}"`, { ip: req.ip });
    const gifUrls = await gif.search(q);
    pushScraperLog('info', 'gif', `Found ${gifUrls.length} GIFs`);
    res.json({ gifs: gifUrls });
  } catch (e) {
    pushScraperLog('error', 'gif', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Local LLM chat (for group replies) ──
app.post('/chat', async (req, res) => {
  try {
    const { prompt, system } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    pushScraperLog('info', 'api', `POST /chat — "${prompt.slice(0, 60)}"`, { ip: req.ip });
    const reply = await askLocalAI(prompt, system || 'You are a helpful assistant.');
    if (!reply) return res.status(503).json({ error: 'Model unavailable or busy' });
    res.json({ reply });
  } catch (e) {
    pushScraperLog('error', 'ai', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Cleanup ──
app.post('/cleanup', (req, res) => {
  temp.cleanup();
  pushScraperLog('info', 'api', 'POST /cleanup — manual trigger');
  res.json({ status: 'cleaned' });
});

// ── Logs API ──
app.get('/logs', (req, res) => {
  res.json({ logs: scraperLogs.slice(-200) });
});

// ================================================================
// DASHBOARD
// ================================================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scraper API — Logs</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:monospace;background:#0a0e14;color:#c9d1d9;padding:20px}h1{font-size:18px;color:#58a6ff;margin-bottom:4px}.sub{font-size:12px;color:#8b949e;margin-bottom:16px}.card{background:#11161d;border:1px solid #21262d;border-radius:8px;padding:16px;margin-bottom:12px}.card h2{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}.stat-row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid #1c2128}.stat-row:last-child{border-bottom:none}.stat-val{color:#58a6ff;font-weight:600}#logs{height:500px;overflow-y:auto;font-size:12px;line-height:1.7;background:#0a0e14;border-radius:6px;padding:10px}.log-entry{padding:4px 0;border-bottom:1px solid #1c2128}.log-time{color:#484f58;margin-right:8px}.log-info{color:#58a6ff}.log-warn{color:#d29922}.log-error{color:#f85149}.log-source{color:#8b949e;margin-right:8px;font-weight:600}.log-meta{color:#484f58;font-size:11px;margin-left:6px}</style></head><body>
<h1>🔧 Intelligent Scraper — API Logs</h1>
<div class="sub">Requests from the main WhatsApp bot + local LLM activity.</div>
<div class="card"><h2>Service Status</h2>
<div class="stat-row"><span>Model</span><span class="stat-val" id="modelName">—</span></div>
<div class="stat-row"><span>Model Ready</span><span class="stat-val" id="modelReady">—</span></div>
<div class="stat-row"><span>Uptime</span><span class="stat-val" id="uptime">—</span></div>
<div class="stat-row"><span>Temp Files</span><span class="stat-val" id="tempFiles">—</span></div>
<div class="stat-row"><span>Log Entries</span><span class="stat-val" id="logCount">—</span></div></div>
<div class="card"><h2>Request Log</h2><div id="logs"></div></div>
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
  pushScraperLog('info', 'system', `Model: SmolLM2-135M`);
  setInterval(temp.cleanup, 300000);
  await initModel();
});
