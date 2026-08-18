// Deliberately simple auth: username + password, scrypt hashing (Node builtin,
// no bcrypt dependency needed), cookie session token stored in SQLite.
// Guests get a random pirate-y name and a short-lived session with no user row.
'use strict';
const crypto = require('crypto');
const { db } = require('./db');
const { parseCookies, setCookie, sendJson, readJsonBody } = require('./http-helpers');

const SESSION_COOKIE = 'optcg_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSession({ userId = null, guestName = null }) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, guest_name, created_at, expires_at) VALUES (?,?,?,?,?)')
    .run(token, userId, guestName, now, now + SESSION_MAX_AGE * 1000);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  if (row.user_id) {
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(row.user_id);
    if (!user) return null;
    return { type: 'user', id: user.id, username: user.username, token };
  }
  return { type: 'guest', id: `guest:${token.slice(0, 8)}`, username: row.guest_name, token };
}

const ADJ = ['Straw', 'Iron', 'Salty', 'Rowdy', 'Lucky', 'Grand', 'Golden', 'Crimson', 'Rusty', 'Sunny', 'Foxy', 'Marine', 'Stormy', 'Sly'];
const NOUN = ['Pirate', 'Cook', 'Swordsman', 'Navigator', 'Sniper', 'Shipwright', 'Musician', 'Doctor', 'Captain', 'Rookie', 'Sailor', 'Buccaneer'];
function randomGuestName() {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  const num = Math.floor(Math.random() * 9000) + 1000;
  return `${a}${n}${num}`;
}

// Express-less "middleware": call at top of any handler that needs auth context.
function attachSession(req) {
  const cookies = parseCookies(req);
  req.session = getSession(cookies[SESSION_COOKIE]);
}

function requireAuth(handler) {
  return async (req, res) => {
    attachSession(req);
    if (!req.session) return sendJson(res, 401, { error: 'Not signed in' });
    return handler(req, res);
  };
}

function registerRoutes(router) {
  router.post('/api/auth/register', async (req, res) => {
    const body = await readJsonBody(req);
    const username = (body.username || '').trim();
    const password = body.password || '';
    if (!/^[a-zA-Z0-9_\-]{3,20}$/.test(username)) {
      return sendJson(res, 400, { error: 'Username must be 3-20 characters: letters, numbers, _ or -' });
    }
    if (password.length < 6) {
      return sendJson(res, 400, { error: 'Password must be at least 6 characters' });
    }
    const lower = username.toLowerCase();
    const exists = db.prepare('SELECT id FROM users WHERE username_lower = ?').get(lower);
    if (exists) return sendJson(res, 409, { error: 'That username is taken' });
    const { salt, hash } = hashPassword(password);
    const info = db.prepare(
      'INSERT INTO users (username, username_lower, salt, hash, created_at) VALUES (?,?,?,?,?)'
    ).run(username, lower, salt, hash, Date.now());
    const token = createSession({ userId: info.lastInsertRowid });
    setCookie(res, SESSION_COOKIE, token, { maxAge: SESSION_MAX_AGE });
    sendJson(res, 200, { user: { id: info.lastInsertRowid, username } });
  });

  router.post('/api/auth/login', async (req, res) => {
    const body = await readJsonBody(req);
    const username = (body.username || '').trim();
    const password = body.password || '';
    const user = db.prepare('SELECT * FROM users WHERE username_lower = ?').get(username.toLowerCase());
    if (!user || !verifyPassword(password, user.salt, user.hash)) {
      return sendJson(res, 401, { error: 'Wrong username or password' });
    }
    const token = createSession({ userId: user.id });
    setCookie(res, SESSION_COOKIE, token, { maxAge: SESSION_MAX_AGE });
    sendJson(res, 200, { user: { id: user.id, username: user.username } });
  });

  router.post('/api/auth/guest', async (req, res) => {
    const name = randomGuestName();
    const token = createSession({ guestName: name });
    setCookie(res, SESSION_COOKIE, token, { maxAge: 60 * 60 * 24 }); // guests: 1 day
    sendJson(res, 200, { user: { id: `guest:${token.slice(0, 8)}`, username: name, guest: true } });
  });

  router.post('/api/auth/logout', async (req, res) => {
    attachSession(req);
    if (req.session) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.session.token);
    setCookie(res, SESSION_COOKIE, '', { maxAge: 0 });
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/auth/me', async (req, res) => {
    attachSession(req);
    if (!req.session) return sendJson(res, 200, { user: null });
    sendJson(res, 200, { user: { id: req.session.id, username: req.session.username, guest: req.session.type === 'guest' } });
  });
}

function ownerKey(session) {
  if (!session) return null;
  return session.type === 'user' ? `u:${session.id}` : `g:${session.token}`;
}

module.exports = { registerRoutes, attachSession, requireAuth, getSession, SESSION_COOKIE, ownerKey };
