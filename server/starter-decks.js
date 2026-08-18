// Ready-to-play starter decks, generated from the official ST (Starter Deck) sets.
// Each ST set is itself a real product: 1 Leader + ~16 unique cards. Bandai's exact
// per-card copy counts aren't in our card data, so we approximate the distribution
// (2 copies each, then fill toward 50 favouring cheaper cards, max 4 per card),
// which produces a legal, playable, on-theme 50-card deck for every set. These are
// used by the bot opponent and are also offered to players who don't want to build
// a deck before jumping in.
'use strict';
const { allCards } = require('./cards');
const { validateDeck } = require('./decks');

const DECK_SIZE = 50;
const MAX_COPIES = 4;
const MIN_UNIQUE = 12; // skip 5-card promo/"Ultra Deck" sets that aren't full decks

let STARTERS = null;

function build() {
  const bySet = new Map();
  for (const c of allCards()) {
    if (!c.set || !c.set.startsWith('ST')) continue;
    if (!bySet.has(c.set)) bySet.set(c.set, []);
    bySet.get(c.set).push(c);
  }
  const out = [];
  for (const [set, cards] of [...bySet.entries()].sort()) {
    const leaders = cards.filter((c) => c.type === 'Leader');
    const nonLeaders = cards.filter((c) => c.type !== 'Leader');
    if (!leaders.length || nonLeaders.length < MIN_UNIQUE) continue;
    for (const leader of leaders) {
      const pool = nonLeaders.filter((c) => c.colors.some((col) => leader.colors.includes(col)));
      if (pool.length < MIN_UNIQUE) continue;
      const counts = {};
      let total = 0;
      for (const c of pool) { counts[c.id] = 2; total += 2; }
      const byCost = pool.slice().sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0));
      let guard = 0;
      while (total < DECK_SIZE && guard < 1000) {
        guard++;
        let progressed = false;
        for (const c of byCost) {
          if (total >= DECK_SIZE) break;
          if (counts[c.id] < MAX_COPIES) { counts[c.id]++; total++; progressed = true; }
        }
        if (!progressed) break;
      }
      if (total > DECK_SIZE) {
        // trim from the most expensive down
        for (const c of byCost.slice().reverse()) {
          while (total > DECK_SIZE && counts[c.id] > 1) { counts[c.id]--; total--; }
          if (total <= DECK_SIZE) break;
        }
      }
      if (total !== DECK_SIZE) continue;
      const errors = validateDeck(leader.id, counts);
      if (errors.length) continue;
      const id = `${set}-${leader.id}`;
      const shortName = leader.name.replace(/\s*\(\d+\)\s*$/, '');
      out.push({
        id,
        set,
        name: `${set} · ${shortName} (${leader.colors.join('/')})`,
        leaderId: leader.id,
        colors: leader.colors,
        cards: counts,
      });
    }
  }
  return out;
}

function starterDecks() {
  if (!STARTERS) STARTERS = build();
  return STARTERS;
}

function getStarter(id) {
  return starterDecks().find((d) => d.id === id) || null;
}

function randomStarter() {
  const list = starterDecks();
  return list[Math.floor(Math.random() * list.length)];
}

function registerRoutes(router, { sendJson }) {
  router.get('/api/starter-decks', (req, res) => {
    sendJson(res, 200, { decks: starterDecks().map((d) => ({ id: d.id, set: d.set, name: d.name, leaderId: d.leaderId, colors: d.colors })) });
  });
  router.get('/api/starter-decks/:id', (req, res) => {
    const d = getStarter(req.params.id);
    if (!d) return sendJson(res, 404, { error: 'Starter deck not found' });
    sendJson(res, 200, d);
  });
}

module.exports = { starterDecks, getStarter, randomStarter, registerRoutes };
