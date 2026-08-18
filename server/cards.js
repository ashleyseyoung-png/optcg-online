'use strict';
const fs = require('fs');
const path = require('path');
const { sendJson } = require('./http-helpers');

const CARDS_PATH = path.join(__dirname, '..', 'public', 'data', 'cards.json');
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

function registerRoutes(router) {
  router.get('/api/cards', (req, res) => {
    sendJson(res, 200, { cards: CARDS, count: CARDS.length });
  });
  router.get('/api/cards/:id', (req, res) => {
    const c = BY_ID.get(req.params.id);
    if (!c) return sendJson(res, 404, { error: 'Card not found' });
    sendJson(res, 200, c);
  });
}

module.exports = { registerRoutes, getCard, allCards, load };
