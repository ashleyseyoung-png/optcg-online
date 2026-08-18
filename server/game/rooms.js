// Room lifecycle: create/join by short code, hold decks until both seats are
// filled, then spin up a Game and relay actions between the two WebSocket
// connections. Also handles reconnects (same session id can re-attach a socket
// to a room it's already part of, e.g. after a page refresh).
'use strict';
const crypto = require('crypto');
const { Game } = require('./engine');
const { db } = require('../db');
const { getCard } = require('../cards');
const { validateDeck } = require('../decks');
const { getStarter, randomStarter } = require('../starter-decks');
const { Bot, pickBotName } = require('./bot');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
}

class Room {
  constructor(code) {
    this.code = code;
    this.seats = [null, null]; // { ownerKey, username, deckDoc, socket }
    this.game = null;
    this.bot = null; // set when this room is a practice match vs the AI
    this.createdAt = Date.now();
  }
  broadcast() {
    for (const seat of this.seats) {
      if (seat && seat.socket && seat.socket.alive) {
        seat.socket.send(JSON.stringify({ type: 'state', state: this.game.serializeFor(seat.seatIndex), meta: this.meta() }));
      }
    }
    // Every state change may hand a decision to the bot (block/counter/its turn) — let it look.
    if (this.bot && this.game && this.game.winner === null) this.bot.schedule();
  }
  meta() { return { vsBot: !!this.bot, tutorial: !!this.tutorial, botName: this.bot ? this.seats[1].username : null }; }
  errorTo(socket, message) {
    if (socket && socket.alive) socket.send(JSON.stringify({ type: 'error', message }));
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  create(ownerKey, username, deckDoc, opts = {}) {
    let code;
    do { code = makeCode(); } while (this.rooms.has(code));
    const room = new Room(code);
    room.seats[0] = { ownerKey, username, deckDoc, socket: null, seatIndex: 0 };
    this.rooms.set(code, room);
    if (opts.vsBot) {
      const botDeck = randomStarter();
      room.seats[1] = { ownerKey: `bot:${code}`, username: pickBotName(), deckDoc: { leaderId: botDeck.leaderId, cards: botDeck.cards }, socket: null, seatIndex: 1, isBot: true };
      room.bot = new Bot(room, 1);
      room.tutorial = !!opts.tutorial;
      this._maybeStart(room);
    }
    return code;
  }

  join(code, ownerKey, username, deckDoc) {
    const room = this.rooms.get(code);
    if (!room) throw new Error('Room not found');
    if (room.seats[0] && room.seats[0].ownerKey === ownerKey) return { code, seat: 0, already: true };
    if (room.seats[1] && room.seats[1].ownerKey === ownerKey) return { code, seat: 1, already: true };
    if (room.seats[1]) throw new Error('Room is full');
    room.seats[1] = { ownerKey, username, deckDoc, socket: null, seatIndex: 1 };
    this._maybeStart(room);
    return { code, seat: 1, already: false };
  }

  _maybeStart(room) {
    if (room.seats[0] && room.seats[1] && !room.game) {
      const sessions = room.seats.map((s) => ({ id: s.ownerKey, username: s.username }));
      const decks = room.seats.map((s) => s.deckDoc);
      room.game = new Game(room.code, sessions, decks);
      // Whichever seat already had a socket open (was on the "waiting" screen)
      // needs to be pushed the fresh game state now — it won't ask again on its own.
      room.broadcast();
    }
  }

  attachSocket(code, ownerKey, socket) {
    const room = this.rooms.get(code);
    if (!room) return null;
    let seatIdx = null;
    if (room.seats[0] && room.seats[0].ownerKey === ownerKey) seatIdx = 0;
    else if (room.seats[1] && room.seats[1].ownerKey === ownerKey) seatIdx = 1;
    if (seatIdx === null) return null;
    room.seats[seatIdx].socket = socket;
    socket.roomCode = code;
    socket.seatIndex = seatIdx;
    if (room.game) {
      socket.send(JSON.stringify({ type: 'state', state: room.game.serializeFor(seatIdx), meta: room.meta() }));
    } else {
      socket.send(JSON.stringify({ type: 'waiting', message: 'Waiting for your opponent to join…' }));
    }
    return room;
  }

  get(code) { return this.rooms.get(code); }

  handleAction(room, seat, msg) {
    if (!room.game) { room.errorTo(room.seats[seat].socket, 'Game has not started yet'); return; }
    const g = room.game;
    try {
      switch (msg.type) {
        case 'mulligan': g.mulligan(seat, !!msg.keep); break;
        case 'chooseFirst': g.setStartingPlayer(seat); break;
        case 'playCard': g.playCard(seat, msg.handIndex); break;
        case 'attachDon': g.attachDon(seat, msg.count, msg.target); break;
        case 'declareAttack': g.declareAttack(seat, msg.attacker, msg.target); break;
        case 'respondBlock': g.respondBlock(seat, msg.blockerIndex); break;
        case 'respondCounter': g.respondCounter(seat, msg.boost || 0); break;
        case 'playCounterEvent': g.playCounterEvent(seat, msg.handIndex); break;
        case 'playCounterCharacter': g.playCounterCharacter(seat, msg.handIndex); break;
        case 'respondTrigger': g.respondTrigger(seat, !!msg.activate); break;
        case 'resolveEffectTargets': g.resolveEffectTargets(seat, msg.selected || []); break;
        case 'endMainPhase': g.endMainPhase(seat); break;
        case 'manualAction': g.manualAction(seat, msg.action); break;
        case 'concede': g.concede(seat); break;
        case 'chat': {
          g._log(`💬 ${g.players[seat].username}: ${String(msg.text || '').slice(0, 300)}`);
          break;
        }
        default: room.errorTo(room.seats[seat].socket, `Unknown action: ${msg.type}`); return;
      }
      room.broadcast();
    } catch (e) {
      room.errorTo(room.seats[seat].socket, e.message);
    }
  }

  cleanupOld() {
    const cutoff = Date.now() - 1000 * 60 * 60 * 12; // 12h
    for (const [code, room] of this.rooms) {
      if (room.createdAt < cutoff) { if (room.bot) room.bot.stop(); this.rooms.delete(code); }
    }
  }
}

const manager = new RoomManager();
setInterval(() => manager.cleanupOld(), 1000 * 60 * 30).unref();

function registerRoutes(router, { attachSession, ownerKey, sendJson, readJsonBody }) {
  router.post('/api/rooms', async (req, res) => {
    attachSession(req);
    if (!req.session) return sendJson(res, 401, { error: 'Sign in or play as guest first' });
    const body = await readJsonBody(req);
    const deckDoc = await resolveDeckDoc(req.session, body);
    if (deckDoc.error) return sendJson(res, 400, deckDoc);
    const code = manager.create(ownerKey(req.session), req.session.username, deckDoc, { vsBot: !!body.vsBot, tutorial: !!body.tutorial });
    sendJson(res, 200, { roomCode: code, vsBot: !!body.vsBot });
  });

  router.post('/api/rooms/:code/join', async (req, res) => {
    attachSession(req);
    if (!req.session) return sendJson(res, 401, { error: 'Sign in or play as guest first' });
    const body = await readJsonBody(req);
    const deckDoc = await resolveDeckDoc(req.session, body);
    if (deckDoc.error) return sendJson(res, 400, deckDoc);
    try {
      const result = manager.join(req.params.code.toUpperCase(), ownerKey(req.session), req.session.username, deckDoc);
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 404, { error: e.message });
    }
  });

  router.get('/api/rooms/:code', async (req, res) => {
    const room = manager.get(req.params.code.toUpperCase());
    if (!room) return sendJson(res, 404, { error: 'Not found' });
    sendJson(res, 200, { code: room.code, players: room.seats.map((s) => s && s.username), started: !!room.game, vsBot: !!room.bot, tutorial: !!room.tutorial });
  });
}

async function resolveDeckDoc(session, body) {
  if (body.starterId) {
    const st = getStarter(body.starterId);
    if (!st) return { error: 'Starter deck not found' };
    return { leaderId: st.leaderId, cards: st.cards };
  }
  if (body.leaderId && body.cards) {
    const errors = validateDeck(body.leaderId, body.cards);
    if (errors.length) return { error: 'Deck is not legal', details: errors };
    return { leaderId: body.leaderId, cards: body.cards };
  }
  if (body.deckId) {
    const { ownerKey } = require('../auth');
    const row = db.prepare('SELECT * FROM decks WHERE id = ?').get(Number(body.deckId));
    if (!row || row.owner_key !== ownerKey(session)) return { error: 'Deck not found' };
    return { leaderId: row.leader_id, cards: JSON.parse(row.cards_json) };
  }
  return { error: 'No deck specified' };
}

module.exports = { manager, registerRoutes };
