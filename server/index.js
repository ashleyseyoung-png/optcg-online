'use strict';
const http = require('http');
const path = require('path');
const { Router, serveStatic, requestUrl, parseCookies, sendJson } = require('./http-helpers');
const { WSServer } = require('./ws-server');
const auth = require('./auth');
const decks = require('./decks');
const cards = require('./cards');
const rooms = require('./game/rooms');
const starters = require('./starter-decks');
const packs = require('./packs');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const router = new Router();
router.get('/healthz', (req, res) => sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) }));
auth.registerRoutes(router);
cards.registerRoutes(router);
decks.registerRoutes(router);
starters.registerRoutes(router, { sendJson });
packs.registerRoutes(router);
rooms.registerRoutes(router, { attachSession: auth.attachSession, ownerKey: auth.ownerKey, sendJson, readJsonBody: require('./http-helpers').readJsonBody });

const staticHandler = serveStatic(PUBLIC_DIR);

const server = http.createServer(async (req, res) => {
  const url = requestUrl(req);
  const pathname = url.pathname;
  const handled = await router.handle(req, res, pathname);
  if (handled) return;
  if (staticHandler(req, res, pathname)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WSServer();
wss.attach(server);
wss.on('connection', (socket, req) => {
  const url = requestUrl(req);
  const roomCode = (url.searchParams.get('room') || '').toUpperCase();
  const cookies = parseCookies(req);
  const session = auth.getSession(cookies[auth.SESSION_COOKIE]);
  if (!session || !roomCode) { socket.close(); return; }
  const room = rooms.manager.attachSocket(roomCode, auth.ownerKey(session), socket);
  if (!room) { socket.send(JSON.stringify({ type: 'error', message: 'Could not join that room' })); socket.close(); return; }

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    rooms.manager.handleAction(room, socket.seatIndex, msg);
  });
  socket.on('close', () => {
    // leave the socket reference so a reconnect can find & replace it; state persists in Room
  });
});

server.listen(PORT, () => {
  console.log(`Grand Line TCG is running → http://localhost:${PORT}`);
  console.log(`(Want a link friends can open? Stop this and run: npm run share)`);
  // Card art relay cache + once-a-day background refresh of the card list (new sets / alt arts).
  const { DATA_DIR } = require('./db');
  cards.setImageCacheDir(DATA_DIR);
  cards.scheduleCardSync(DATA_DIR);
});
