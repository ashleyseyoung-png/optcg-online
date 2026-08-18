'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { sendJson } = require('./http-helpers');

const CARDS_PATH = path.join(__dirname, '..', 'public', 'data', 'cards.json');
const SYNC_SCRIPT = path.join(__dirname, '..', 'scripts', 'sync-cards.js');
let CARDS = [];
let BY_ID = new Map();

function load() {
  const raw = fs.readFileSync(CARDS_PATH, 'utf8');
  CARDS = JSON.parse(raw);
  BY_ID = new Map(CARDS.map((c) => [c.id, c]));
  console.log(`Loaded ${CARDS.length} cards`);
}
load();

function getCard(id) { return BY_ID.get(id); }
function allCards() { return CARDS; }

// ---------------------------------------------------------------------------------------
// Background card-list refresh: pulls any printings we don't have yet (new sets, alt arts)
// from optcgapi.com at most once a day, then hot-reloads. Never blocks startup; if the
// machine is offline the shipped list is simply used as-is. Disable with CARD_SYNC=0.
// ---------------------------------------------------------------------------------------
function scheduleCardSync(dataDir) {
  if (process.env.CARD_SYNC === '0') return;
  const stamp = path.join(dataDir || os.tmpdir(), 'cards-sync.stamp');
  const DAY = 24 * 60 * 60 * 1000;
  let last = 0;
  try { last = fs.statSync(stamp).mtimeMs; } catch (e) { /* never synced */ }
  if (Date.now() - last < DAY) return;
  // Only useful if we can actually write the file (read-only deploys just skip)
  try { fs.accessSync(CARDS_PATH, fs.constants.W_OK); } catch (e) { return; }
  setTimeout(() => {
    const child = spawn(process.execPath, [SYNC_SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      out.trim().split('\n').filter(Boolean).forEach((l) => console.log(l));
      try { fs.writeFileSync(stamp, String(Date.now())); } catch (e) { /* ignore */ }
      if (code === 0) {
        try {
          const n = CARDS.length;
          load();
          if (CARDS.length !== n) console.log(`Card list refreshed: ${n} → ${CARDS.length} printings.`);
        } catch (e) { console.warn('Card list reload failed:', e.message); }
      }
    });
    child.on('error', (e) => console.warn('Card sync could not start:', e.message));
  }, 3000).unref();
}

// ---------------------------------------------------------------------------------------
// Card image relay: /api/card-image/:id — fetches the art server-side, caches it on disk and
// serves it from our own origin. Used by the browser as a fallback when the art hosts refuse
// a direct request (some networks/ISPs/hotlink rules block them), so everyone sees the same
// pictures. Only known card ids are relayed; nothing else can be proxied through here.
// ---------------------------------------------------------------------------------------
let IMG_CACHE_DIR = null;
const inflight = new Map();
const MAX_IMG_BYTES = 3 * 1024 * 1024;
// Be polite to the art hosts: at most this many upstream fetches at once (a deck-builder page
// can ask for 100+ pictures in a burst); the rest queue.
const MAX_UPSTREAM = 6;
let upstreamActive = 0;
const upstreamQueue = [];
function withUpstreamSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => { upstreamActive++; fn().then(resolve, reject).finally(() => { upstreamActive--; const next = upstreamQueue.shift(); if (next) next(); }); };
    if (upstreamActive < MAX_UPSTREAM) run(); else upstreamQueue.push(run);
  });
}

function setImageCacheDir(dataDir) {
  try {
    IMG_CACHE_DIR = path.join(dataDir, 'card-images');
    fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });
  } catch (e) { IMG_CACHE_DIR = null; }
}

async function fetchImage(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; GrandLineTCG/1.0)', accept: 'image/*,*/*;q=0.8' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'unknown type'})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_IMG_BYTES) throw new Error('bad size');
  return { buf, type };
}

async function relayCardImage(card) {
  const key = card.id.replace(/[^A-Za-z0-9_-]/g, '_');
  const cachePath = IMG_CACHE_DIR ? path.join(IMG_CACHE_DIR, key) : null;
  if (cachePath) {
    try {
      const buf = fs.readFileSync(cachePath);
      const type = buf[0] === 0x89 ? 'image/png' : buf[0] === 0xff ? 'image/jpeg' : 'image/webp';
      return { buf, type };
    } catch (e) { /* not cached */ }
  }
  if (inflight.has(card.id)) return inflight.get(card.id);
  const p = (async () => {
    const urls = [card.image, card.image2].filter(Boolean);
    let lastErr = null;
    for (const url of urls) {
      try {
        const got = await withUpstreamSlot(() => fetchImage(url));
        if (cachePath) { try { fs.writeFileSync(cachePath, got.buf); } catch (e) { /* cache is best-effort */ } }
        return got;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no image sources');
  })();
  inflight.set(card.id, p);
  try { return await p; } finally { inflight.delete(card.id); }
}

function registerRoutes(router) {
  router.get('/api/cards', (req, res) => {
    sendJson(res, 200, { cards: CARDS, count: CARDS.length });
  });
  router.get('/api/cards/:id', (req, res) => {
    const c = BY_ID.get(req.params.id);
    if (!c) return sendJson(res, 404, { error: 'Card not found' });
    sendJson(res, 200, c);
  });
  router.get('/api/card-image/:id', async (req, res) => {
    const c = BY_ID.get(req.params.id);
    if (!c) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Unknown card'); return; }
    try {
      const { buf, type } = await relayCardImage(c);
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=2592000, immutable',
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Image unavailable');
    }
  });
}

module.exports = { registerRoutes, getCard, allCards, load, scheduleCardSync, setImageCacheDir };
