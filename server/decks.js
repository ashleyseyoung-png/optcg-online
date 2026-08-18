'use strict';
const { db } = require('./db');
const { sendJson, readJsonBody } = require('./http-helpers');
const { attachSession, ownerKey } = require('./auth');
const { getCard } = require('./cards');

const DECK_SIZE = 50;
const MAX_COPIES = 4;

function validateDeck(leaderId, cardCounts) {
  const errors = [];
  const leader = getCard(leaderId);
  if (!leader || leader.type !== 'Leader') errors.push('Choose a valid Leader card.');
  const leaderColors = leader ? leader.colors : [];

  let total = 0;
  for (const [cardId, count] of Object.entries(cardCounts)) {
    const card = getCard(cardId);
    if (!card) { errors.push(`Unknown card: ${cardId}`); continue; }
    if (card.type === 'Leader') { errors.push(`${card.name} is a Leader and can't go in the main deck.`); continue; }
    if (count < 0 || count > MAX_COPIES) errors.push(`${card.name}: max ${MAX_COPIES} copies (has ${count}).`);
    if (leader && !card.colors.some((c) => leaderColors.includes(c))) {
      errors.push(`${card.name} (${card.colors.join('/')}) doesn't match your Leader's color (${leaderColors.join('/')}).`);
    }
    total += count;
  }
  if (total !== DECK_SIZE) errors.push(`Deck must have exactly ${DECK_SIZE} cards (has ${total}).`);
  return errors;
}

function registerRoutes(router) {
  router.get('/api/decks', async (req, res) => {
    attachSession(req);
    if (!req.session) return sendJson(res, 200, { decks: [] });
    const rows = db.prepare('SELECT * FROM decks WHERE owner_key = ? ORDER BY updated_at DESC').all(ownerKey(req.session));
    sendJson(res, 200, { decks: rows.map(rowToDeck) });
  });

  router.get('/api/decks/:id', async (req, res) => {
    attachSession(req);
    const row = db.prepare('SELECT * FROM decks WHERE id = ?').get(Number(req.params.id));
    if (!row || !req.session || row.owner_key !== ownerKey(req.session)) {
      return sendJson(res, 404, { error: 'Deck not found' });
    }
    sendJson(res, 200, rowToDeck(row));
  });

  router.post('/api/decks', async (req, res) => {
    attachSession(req);
    if (!req.session) return sendJson(res, 401, { error: 'Sign in or play as guest to save decks' });
    const body = await readJsonBody(req);
    const name = (body.name || 'Untitled Deck').slice(0, 60);
    const leaderId = body.leaderId;
    const cardCounts = body.cards || {};
    const errors = validateDeck(leaderId, cardCounts);
    if (errors.length) return sendJson(res, 400, { error: 'Deck is not legal', details: errors });
    const now = Date.now();
    const info = db.prepare(
      'INSERT INTO decks (owner_key, name, leader_id, cards_json, created_at, updated_at) VALUES (?,?,?,?,?,?)'
    ).run(ownerKey(req.session), name, leaderId, JSON.stringify(cardCounts), now, now);
    sendJson(res, 200, { id: info.lastInsertRowid });
  });

  router.put('/api/decks/:id', async (req, res) => {
    attachSession(req);
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM decks WHERE id = ?').get(id);
    if (!row || !req.session || row.owner_key !== ownerKey(req.session)) {
      return sendJson(res, 404, { error: 'Deck not found' });
    }
    const body = await readJsonBody(req);
    const name = (body.name || row.name).slice(0, 60);
    const leaderId = body.leaderId || row.leader_id;
    const cardCounts = body.cards || JSON.parse(row.cards_json);
    const errors = validateDeck(leaderId, cardCounts);
    if (errors.length) return sendJson(res, 400, { error: 'Deck is not legal', details: errors });
    db.prepare('UPDATE decks SET name=?, leader_id=?, cards_json=?, updated_at=? WHERE id=?')
      .run(name, leaderId, JSON.stringify(cardCounts), Date.now(), id);
    sendJson(res, 200, { ok: true });
  });

  router.delete('/api/decks/:id', async (req, res) => {
    attachSession(req);
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM decks WHERE id = ?').get(id);
    if (!row || !req.session || row.owner_key !== ownerKey(req.session)) {
      return sendJson(res, 404, { error: 'Deck not found' });
    }
    db.prepare('DELETE FROM decks WHERE id=?').run(id);
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/decks/validate', async (req, res) => {
    const body = await readJsonBody(req);
    const errors = validateDeck(body.leaderId, body.cards || {});
    sendJson(res, 200, { valid: errors.length === 0, errors });
  });
}

function rowToDeck(row) {
  return {
    id: row.id,
    name: row.name,
    leaderId: row.leader_id,
    cards: JSON.parse(row.cards_json),
    updatedAt: row.updated_at,
  };
}

module.exports = { registerRoutes, validateDeck };
