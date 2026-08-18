#!/usr/bin/env node
// Refresh public/data/cards.json from optcgapi.com so EVERY printing (base cards, parallels,
// alternate arts, SP/SPR, manga arts, box toppers, reprints in the Premium Boosters, new sets)
// is available in the deck builder.
//
//   npm run sync-cards          (also runs automatically during the Render build)
//
// Design:
//   * Zero dependencies — Node 22's built-in fetch.
//   * Never breaks the app: any network/API problem just leaves the shipped cards.json alone
//     and exits 0. Only writes when it has something new.
//   * A printing IS the same card as its base by rule, so alt printings inherit the base's
//     game data; the API only contributes id / label / image for them.
//   * New base cards (a set that isn't in the shipped file yet) are added in full.
'use strict';
const fs = require('fs');
const path = require('path');

const CARDS_PATH = path.join(__dirname, '..', 'public', 'data', 'cards.json');
const API = 'https://optcgapi.com/api';
const IMG = 'https://optcgapi.com/media/static/Card_Images';
const OFFICIAL_IMG = 'https://en.onepiece-cardgame.com/images/cardlist/card';
const TIMEOUT_MS = 25000;
const CONCURRENCY = 4;
// Sets/decks that may not be in the API's index yet but exist as endpoints; 404s are fine.
const EXTRA_SETS = ['OP-17', 'OP-18', 'EB-05', 'EB-06', 'PRB-03'];
const EXTRA_DECKS = ['ST-29', 'ST-31', 'ST-32', 'ST-33', 'ST-34', 'ST-35'];

// ---- name / label helpers (mirror data/parse_cards.py) ------------------------------------
const NULLS = new Set(['-', '—', '‐', '−', 'NULL', 'null', '', 'None']);
const ART_SUFFIX_RE = /\s*\((Alternate Art|Parallel|Box Topper|Manga|Manga Art|Full Art|Reprint|SP|SPR|Special|Wanted Poster|Treasure Rare|Winner[^)]*|[^)]*(Pack|Collection|Tournament|Championship|Edition|Event|Promo|Release|Festival|Fest\.?|Cup|Regional|Store|Anniversary|Gift|Set|Vol\.?)[^)]*)\)\s*$/i;
const BRACKET_SUFFIX_RE = /\s*\[([^\]]{1,40})\]\s*$/;
const NAME_SET_SUFFIX_RE = /\s*(?:-\s*|\(\s*)(OP\d{2}|ST\d{2}|EB\d{2}|PRB\d{2}|P)-\d{3}\s*\)?\s*$/;
const NAME_PAREN_ID_RE = /\s*\((?:OP\d{2}|ST\d{2}|EB\d{2})?-?\d{3}\)\s*$/;
const ID_SUFFIX_RE = /_(p|r|pr|alt|v)\d+$/i;

const clean = (v) => (v == null ? null : (String(v).trim() && !NULLS.has(String(v).trim()) ? String(v).trim() : null));
const toInt = (v) => {
  const s = clean(v);
  if (s == null) return null;
  const m = String(s).replace(/,/g, '').match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
};

function normalizeName(name) {
  for (let i = 0; i < 3; i++) {
    name = name.replace(BRACKET_SUFFIX_RE, '').trim();
    name = name.replace(ART_SUFFIX_RE, '').trim();
  }
  name = name.replace(NAME_SET_SUFFIX_RE, '').trim();
  name = name.replace(NAME_PAREN_ID_RE, '').trim();
  return name;
}

function variantLabel(rawName, pid, baseId, printSet) {
  const labels = [];
  let name = rawName;
  for (let i = 0; i < 3; i++) {
    let m = name.match(BRACKET_SUFFIX_RE);
    if (m) { labels.unshift(m[1].trim()); name = name.replace(BRACKET_SUFFIX_RE, '').trim(); continue; }
    m = name.match(ART_SUFFIX_RE);
    if (m) { labels.unshift(m[1].trim()); name = name.replace(ART_SUFFIX_RE, '').trim(); continue; }
    break;
  }
  if (labels.length) return labels.join(' · ');
  if (pid === baseId) return null;
  const suf = (pid.match(ID_SUFFIX_RE) || [])[1];
  if (suf && suf.toLowerCase() === 'r') return printSet ? `Reprint · ${printSet}` : 'Reprint';
  if (suf && suf.toLowerCase() === 'pr') return 'Promo';
  return 'Alternate Art';
}

const KEYWORDS = ['Rush', 'Blocker', 'Double Attack', 'Banish', 'Trigger'];

// Type segmentation: split "Straw Hat Crew Supernovas" into known multi-word types first.
function makeTypeSegmenter(cards) {
  const known = new Set();
  for (const c of cards) for (const t of c.types || []) known.add(t);
  const sorted = [...known].sort((a, b) => b.split(' ').length - a.split(' ').length);
  return (str) => {
    if (!str) return [];
    const words = str.split(/\s+/).filter(Boolean);
    const out = []; let pending = []; let i = 0;
    while (i < words.length) {
      let matched = null;
      for (const phrase of sorted) {
        const pw = phrase.split(' ');
        if (pw.length <= words.length - i && words.slice(i, i + pw.length).map((w) => w.toLowerCase()).join(' ') === pw.map((w) => w.toLowerCase()).join(' ')) { matched = phrase; i += pw.length; break; }
      }
      if (matched) { if (pending.length) { out.push(pending.join(' ')); pending = []; } out.push(matched); }
      else { pending.push(words[i]); i++; }
    }
    if (pending.length) out.push(pending.join(' '));
    return out;
  };
}

// ---- fetch helpers ---------------------------------------------------------------------
async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json', 'user-agent': 'grand-line-tcg-sync/1.0' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data && Array.isArray(data.cards) ? data.cards : null);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

// ---- main ------------------------------------------------------------------------------
async function main() {
  let cards;
  try { cards = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8')); }
  catch (e) { console.error(`sync-cards: can't read ${CARDS_PATH}: ${e.message}`); return; }
  const byId = new Map(cards.map((c) => [c.id, c]));
  const segmentTypes = makeTypeSegmenter(cards);
  const before = cards.length;

  // 1) discover sets + decks
  let sets = [], decks = [];
  try { sets = ((await getJson(`${API}/allSets/`)) || []).map((s) => s.set_id || s.id).filter(Boolean); } catch (e) { console.warn('sync-cards: allSets failed:', e.message); }
  try { decks = ((await getJson(`${API}/allDecks/`)) || []).map((s) => s.deck_id || s.set_id || s.id).filter(Boolean); } catch (e) { console.warn('sync-cards: allDecks failed:', e.message); }
  const targets = [];
  const seenTargets = new Set();
  for (const s of [...sets, ...EXTRA_SETS]) if (!seenTargets.has(`sets/${s}`)) { seenTargets.add(`sets/${s}`); targets.push({ kind: 'sets', id: s }); }
  for (const s of [...decks, ...EXTRA_DECKS]) if (!seenTargets.has(`decks/${s}`)) { seenTargets.add(`decks/${s}`); targets.push({ kind: 'decks', id: s }); }
  if (!targets.length) { console.warn('sync-cards: nothing to fetch (offline?) — keeping shipped card list.'); return; }
  console.log(`sync-cards: checking ${targets.length} sets/decks against ${before} known printings…`);

  // 2) fetch each set/deck
  const fetched = await mapLimit(targets, CONCURRENCY, async (t) => {
    const url = `${API}/${t.kind}/${t.id}/`;
    try {
      const rows = await getJson(url);
      if (!rows) return { t, rows: [], missing: true };
      return { t, rows };
    } catch (e) { console.warn(`sync-cards: ${url} failed: ${e.message}`); return { t, rows: [], failed: true }; }
  });

  // 3) merge
  let added = 0, addedBase = 0, updated = 0;
  const seenIds = new Set();
  for (const { t, rows } of fetched) {
    for (const r of rows) {
      const baseRaw = clean(r.card_set_id);
      if (!baseRaw) continue;
      const baseId = baseRaw.replace(ID_SUFFIX_RE, '');
      let pid = clean(r.card_image_id) || baseRaw;
      if (!pid.startsWith(baseId)) pid = baseId; // defensive: odd ids -> treat as base
      if (seenIds.has(pid)) continue;
      seenIds.add(pid);
      const rawName = clean(r.card_name) || baseId;
      const printSet = clean(r.set_id) || t.id;
      const img = clean(r.card_image);
      const image = img && /^https?:/i.test(img) ? img : `${IMG}/${pid}.jpg`;
      const officialId = (pid === baseId || /_p\d+$/i.test(pid)) ? pid : baseId;
      const image2 = `${OFFICIAL_IMG}/${officialId}.png`;

      // ensure base card exists (new set) ------------------------------------------------
      let base = byId.get(baseId);
      if (!base) {
        const text = (clean(r.card_text) || '').replace(/\\n/g, '\n');
        base = {
          id: baseId, baseId, name: normalizeName(rawName) || baseId, variant: null,
          type: clean(r.card_type) || 'Character',
          colors: (clean(r.card_color) || '').split(/\s+/).filter(Boolean),
          cost: toInt(r.card_cost), power: toInt(r.card_power), counter: toInt(r.counter_amount), life: toInt(r.life),
          attribute: clean(r.attribute), rarity: clean(r.rarity),
          types: segmentTypes(clean(r.sub_types) || ''), text,
          keywords: KEYWORDS.filter((k) => text.includes(`[${k}]`)),
          set: baseId.includes('-') ? baseId.split('-')[0] : baseId,
          image: pid === baseId ? image : `${IMG}/${baseId}.jpg`,
          image2: `${OFFICIAL_IMG}/${baseId}.png`,
        };
        byId.set(baseId, base); cards.push(base); addedBase++;
      }
      if (pid === baseId) continue;

      // alt printing --------------------------------------------------------------------
      const existing = byId.get(pid);
      // "OP01" (our set code) vs "OP-01" (API set id): only label the print set when it differs
      const ownSetApiId = base.set.replace(/^(OP|ST|EB|PRB)(\d\d)$/, '$1-$2');
      const foreignPrintSet = printSet && printSet !== ownSetApiId && !printSet.startsWith(ownSetApiId) ? printSet : null;
      const variant = variantLabel(rawName, pid, baseId, foreignPrintSet);
      if (existing) {
        // API image is authoritative if we only had a guessed URL
        if (img && /^https?:/i.test(img) && existing.image !== img) { existing.image = img; updated++; }
        if (!existing.variant && variant) { existing.variant = variant; updated++; }
        continue;
      }
      const printing = {
        id: pid, baseId, name: base.name, variant: variant || 'Alternate Art',
        type: base.type, colors: base.colors, cost: base.cost, power: base.power, counter: base.counter, life: base.life,
        attribute: base.attribute, rarity: clean(r.rarity) || base.rarity, types: base.types, text: base.text, keywords: base.keywords,
        set: base.set, image, image2,
      };
      if (foreignPrintSet) printing.printSet = foreignPrintSet;
      byId.set(pid, printing); cards.push(printing); added++;
    }
  }

  const missingSets = fetched.filter((f) => f.missing).map((f) => f.t.id);
  const failedSets = fetched.filter((f) => f.failed).map((f) => f.t.id);
  if (failedSets.length) console.warn(`sync-cards: could not reach ${failedSets.length} endpoint(s): ${failedSets.join(', ')}`);
  if (added || addedBase || updated) {
    cards.sort((a, b) => (a.baseId < b.baseId ? -1 : a.baseId > b.baseId ? 1 : (a.id === a.baseId) !== (b.id === b.baseId) ? (a.id === a.baseId ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    fs.writeFileSync(CARDS_PATH, JSON.stringify(cards, null, 1));
    console.log(`sync-cards: +${addedBase} new cards, +${added} alt/parallel printings, ${updated} updated → ${cards.length} printings total.`);
  } else {
    console.log(`sync-cards: card list already complete (${cards.length} printings).`);
  }
  if (missingSets.length) console.log(`sync-cards: not published yet: ${missingSets.join(', ')}`);
}

main().catch((e) => { console.warn('sync-cards: skipped —', e.message); });
