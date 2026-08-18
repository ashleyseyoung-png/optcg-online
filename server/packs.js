// Booster pack ripping + collection.
//
// Pack contents are generated on the server (so what lands in your collection is honest) from
// the actual card pool of the chosen set. Bandai doesn't publish official pull rates, so the
// odds are modelled on the community-documented figures (see PACK_MODEL below and README):
//   * 12 cards per pack, 24 packs per box.
//   * every pack has at least 1 Rare; ~1 in 3 packs upgrades a second Rare to a Super Rare;
//   * ~1 Leader every 2 packs (12 per box); ~1 Secret Rare per box; ~1 alternate-art
//     (parallel) card every 12 packs; Manga rares ~1 per 576–1,152 packs (we use the middle);
//     Treasure Rares (OP-13+) ~1 per case; SP cards ~1 per 160 packs.
//   * commons fill the rest, uncommons ~3 per pack.
// Only cards that actually belong to the set can appear (parallels = that set's own cards).
'use strict';
const crypto = require('crypto');
const { db } = require('./db');
const cardsMod = require('./cards');
const { getCard, allCards } = cardsMod;
const { sendJson, readJsonBody } = require('./http-helpers');
const { attachSession, ownerKey } = require('./auth');

db.exec(`
  CREATE TABLE IF NOT EXISTS collection (
    owner_key TEXT NOT NULL,
    card_id TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    first_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_key, card_id)
  );
  CREATE TABLE IF NOT EXISTS pack_stats (
    owner_key TEXT NOT NULL,
    set_code TEXT NOT NULL,
    packs INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_key, set_code)
  );
  CREATE TABLE IF NOT EXISTS pulls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_key TEXT NOT NULL,
    set_code TEXT NOT NULL,
    card_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pulls_owner ON pulls(owner_key, at);
`);

const SET_NAMES = {
  OP01: 'Romance Dawn', OP02: 'Paramount War', OP03: 'Pillars of Strength', OP04: 'Kingdoms of Intrigue',
  OP05: 'Awakening of the New Era', OP06: 'Wings of the Captain', OP07: '500 Years in the Future',
  OP08: 'Two Legends', OP09: 'Emperors in the New World', OP10: 'Royal Blood', OP11: 'A Fist of Divine Speed',
  OP12: 'Legacy of the Master', OP13: 'Carrying On His Will', OP14: "The Azure Sea's Seven",
  OP15: "Adventure on Kami's Island", OP16: 'The Time of Battle', OP17: 'Booster OP-17', OP18: 'Booster OP-18',
  EB01: 'Extra Booster: Memorial Collection', EB02: 'Extra Booster: Anime 25th Collection',
  EB03: 'Extra Booster: One Piece Heroines Edition', EB04: 'Extra Booster EB-04',
};

// The odds model (per pack unless noted). Sources: tcgtalk.com box pull-rate guide, cardgamer.com
// rarities guide, tcgking.nl rarities guide, slab-z.com pull-rate guide (2026).
const PACK_MODEL = {
  cardsPerPack: 12,
  packsPerBox: 24,
  leaderChance: 1 / 2,      // ~12 Leaders per 24-pack box
  srChance: 8 / 24,         // ~8 Super Rares per box; an SR replaces the pack's 2nd Rare
  secChance: 1 / 24,        // ~1 Secret Rare per box (takes the SR/2nd-Rare slot)
  parallelChance: 1 / 12,   // ~2 alternate-art cards per box
  mangaChance: 1 / 864,     // ~1 per 576–1,152 packs (midpoint)
  spChance: 1 / 160,        // ~1–2 per 12-box case
  trChance: 1 / 288,        // Treasure Rare, OP-13+: ~1 per case
  uncommons: 3,
};

// ---- pools --------------------------------------------------------------------------
let POOLS = null;
function classifyVariant(v, printSet, setCode) {
  if (!v) return null;
  const s = v.toLowerCase();
  if (/box topper|wanted poster|reprint|winner|finalist|pack|event|tournament|championship|promo|store|festival|gift|collection|edition/.test(s)) return null; // not in packs
  if (/manga/.test(s)) return 'manga';
  if (/treasure/.test(s)) return 'tr';
  if (/\bsp\b/.test(s) && !/spr/.test(s)) return printSet && printSet.replace('-', '') === setCode ? 'sp' : null; // SPs are printed in LATER sets — only count them where we know the print set
  if (/spr|alternate art|parallel|full art/.test(s)) return 'parallel';
  return null;
}
function buildPools() {
  const pools = {};
  for (const c of allCards()) {
    const set = c.set;
    if (!/^(OP|EB)\d{2}$/.test(set)) continue;
    const p = pools[set] || (pools[set] = { set, name: SET_NAMES[set] || set, C: [], UC: [], R: [], SR: [], SEC: [], L: [], parallel: [], manga: [], sp: [], tr: [] });
    if (!c.variant) {
      if (p[c.rarity]) p[c.rarity].push(c.id);
    } else {
      const kind = classifyVariant(c.variant, c.printSet, set);
      if (kind) p[kind].push(c.id);
    }
  }
  // a set is rippable if it has the basic booster structure
  for (const k of Object.keys(pools)) { const p = pools[k]; if (!p.C.length || !p.R.length) delete pools[k]; }
  POOLS = pools;
  return pools;
}
function pools() { return POOLS || buildPools(); }
function refreshPools() { POOLS = null; }
if (cardsMod.onReload) cardsMod.onReload(refreshPools);

// ---- RNG helpers --------------------------------------------------------------------
function rnd() { return crypto.randomInt(0, 1e9) / 1e9; }
function pick(arr) { return arr[crypto.randomInt(0, arr.length)]; }
function pickN(arr, n) { // without replacement when possible
  const out = [];
  if (!arr.length) return out;
  const bag = arr.slice();
  for (let i = 0; i < n; i++) {
    if (!bag.length) bag.push(...arr);
    const j = crypto.randomInt(0, bag.length);
    out.push(bag.splice(j, 1)[0]);
  }
  return out;
}

const TIER_ORDER = { C: 0, UC: 1, R: 2, L: 3, SR: 4, parallel: 5, sp: 6, tr: 7, SEC: 8, manga: 9 };

// One pack, in reveal order (commons first … best card last).
function generatePack(setCode) {
  const p = pools()[setCode];
  if (!p) throw new Error('Unknown or non-booster set');
  const M = PACK_MODEL;
  const slots = []; // { id, tier }
  // Rare (guaranteed) + hit slot
  slots.push({ id: pick(p.R), tier: 'R' });
  let hit;
  if (p.SEC.length && rnd() < M.secChance) hit = { id: pick(p.SEC), tier: 'SEC' };
  else if (p.SR.length && rnd() < M.srChance) hit = { id: pick(p.SR), tier: 'SR' };
  else hit = { id: pick(p.R.filter((id) => id !== slots[0].id).length ? p.R.filter((id) => id !== slots[0].id) : p.R), tier: 'R' };
  slots.push(hit);
  // Leader slot
  const leader = p.L.length && rnd() < M.leaderChance ? { id: pick(p.L), tier: 'L' } : null;
  if (leader) slots.push(leader);
  // Uncommons
  const ucPool = p.UC.length ? p.UC : p.C;
  const ucTier = p.UC.length ? 'UC' : 'C';
  for (const id of pickN(ucPool, M.uncommons)) slots.push({ id, tier: ucTier });
  // Commons fill the rest
  const remaining = M.cardsPerPack - slots.length;
  for (const id of pickN(p.C, remaining)) slots.push({ id, tier: 'C' });

  // Chase upgrades: swap a same-card slot (or a common) for the special printing
  const upgrade = (kind) => {
    const alt = pick(p[kind]);
    const altCard = getCard(alt);
    if (!altCard) return;
    // replace the base version if it's in the pack, else a card of the same rarity, else a common
    let idx = slots.findIndex((s) => s.id === altCard.baseId);
    if (idx < 0) idx = slots.findIndex((s) => s.tier === altCard.rarity && !['SEC', 'manga', 'tr', 'sp', 'parallel'].includes(s.tier));
    if (idx < 0) idx = slots.findIndex((s) => s.tier === 'C');
    if (idx < 0) idx = slots.length - 1;
    slots[idx] = { id: alt, tier: kind };
  };
  if (p.manga.length && rnd() < M.mangaChance) upgrade('manga');
  else if (p.tr.length && rnd() < M.trChance) upgrade('tr');
  else if (p.sp.length && rnd() < M.spChance) upgrade('sp');
  else if (p.parallel.length && rnd() < M.parallelChance) upgrade('parallel');

  // reveal order: worst → best, ties keep position
  slots.sort((a, b) => (TIER_ORDER[a.tier] || 0) - (TIER_ORDER[b.tier] || 0));
  const isHit = (t) => ['SR', 'SEC', 'parallel', 'manga', 'sp', 'tr'].includes(t);
  return slots.map((s) => ({ id: s.id, tier: s.tier, hit: isHit(s.tier) }));
}

// ---- persistence ----------------------------------------------------------------------
const upsertCard = db.prepare(`INSERT INTO collection (owner_key, card_id, count, first_at, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(owner_key, card_id) DO UPDATE SET count = count + excluded.count, updated_at = excluded.updated_at`);
const upsertStats = db.prepare(`INSERT INTO pack_stats (owner_key, set_code, packs, hits) VALUES (?, ?, ?, ?)
  ON CONFLICT(owner_key, set_code) DO UPDATE SET packs = packs + excluded.packs, hits = hits + excluded.hits`);
const insertPull = db.prepare('INSERT INTO pulls (owner_key, set_code, card_id, tier, at) VALUES (?, ?, ?, ?, ?)');

function recordPacks(owner, setCode, packs) {
  const now = Date.now();
  const counts = new Map();
  let hits = 0;
  for (const pack of packs) for (const c of pack) { counts.set(c.id, (counts.get(c.id) || 0) + 1); if (c.hit) { hits++; insertPull.run(owner, setCode, c.id, c.tier, now); } }
  for (const [id, n] of counts) upsertCard.run(owner, id, n, now, now);
  upsertStats.run(owner, setCode, packs.length, hits);
  // keep the pull log bounded
  db.prepare('DELETE FROM pulls WHERE owner_key = ? AND id NOT IN (SELECT id FROM pulls WHERE owner_key = ? ORDER BY at DESC, id DESC LIMIT 200)').run(owner, owner);
}

// ---- routes ------------------------------------------------------------------------------
function registerRoutes(router) {
  router.get('/api/packs/sets', (req, res) => {
    attachSession(req);
    const owner = ownerKey(req.session);
    const stats = owner ? Object.fromEntries(db.prepare('SELECT set_code, packs, hits FROM pack_stats WHERE owner_key = ?').all(owner).map((r) => [r.set_code, r])) : {};
    const list = Object.values(pools()).sort((a, b) => (a.set.startsWith('OP') === b.set.startsWith('OP') ? a.set.localeCompare(b.set) : a.set.startsWith('OP') ? -1 : 1)).map((p) => ({
      set: p.set, name: p.name,
      counts: { L: p.L.length, C: p.C.length, UC: p.UC.length, R: p.R.length, SR: p.SR.length, SEC: p.SEC.length, parallel: p.parallel.length, manga: p.manga.length, sp: p.sp.length, tr: p.tr.length },
      total: p.L.length + p.C.length + p.UC.length + p.R.length + p.SR.length + p.SEC.length,
      opened: stats[p.set] ? stats[p.set].packs : 0,
      hits: stats[p.set] ? stats[p.set].hits : 0,
      cover: p.L[0] || p.SR[0],
    }));
    sendJson(res, 200, { sets: list, model: PACK_MODEL });
  });

  router.post('/api/packs/open', async (req, res) => {
    attachSession(req);
    const owner = ownerKey(req.session);
    const body = await readJsonBody(req);
    const setCode = String(body.set || '').toUpperCase();
    const count = Math.max(1, Math.min(24, parseInt(body.count, 10) || 1));
    if (!pools()[setCode]) return sendJson(res, 400, { error: 'That set can’t be opened as booster packs' });
    const packs = [];
    for (let i = 0; i < count; i++) packs.push(generatePack(setCode));
    if (owner) recordPacks(owner, setCode, packs);
    sendJson(res, 200, { set: setCode, name: SET_NAMES[setCode] || setCode, packs, saved: !!owner });
  });

  router.get('/api/collection', (req, res) => {
    attachSession(req);
    const owner = ownerKey(req.session);
    if (!owner) return sendJson(res, 200, { cards: [], stats: [], recent: [], signedIn: false });
    const cards = db.prepare('SELECT card_id AS id, count, first_at, updated_at FROM collection WHERE owner_key = ? AND count > 0 ORDER BY updated_at DESC').all(owner);
    const stats = db.prepare('SELECT set_code AS set_, packs, hits FROM pack_stats WHERE owner_key = ?').all(owner).map((r) => ({ set: r.set_, packs: r.packs, hits: r.hits }));
    const recent = db.prepare('SELECT card_id AS id, set_code AS set_, tier, at FROM pulls WHERE owner_key = ? ORDER BY at DESC, id DESC LIMIT 40').all(owner).map((r) => ({ id: r.id, set: r.set_, tier: r.tier, at: r.at }));
    sendJson(res, 200, { cards, stats, recent, signedIn: true });
  });
}

module.exports = { registerRoutes, generatePack, buildPools, refreshPools, PACK_MODEL, SET_NAMES };
