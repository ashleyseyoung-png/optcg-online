// The live game board. Renders server-authoritative state (server/game/engine.js
// Game.serializeFor) as a mirrored real-playmat layout and turns clicks / drags into
// WebSocket action messages. The server is the source of truth for all game logic —
// this file only decides what's clickable/draggable, draws it, and animates changes.

let ws = null;
let STATE = null;
let PREV = null;          // previous state, for diff-driven animations
let META = {};            // { vsBot, tutorial, botName } from the server
let ALL_CARDS = [];
let BY_ID = new Map();
let TUTORIAL = new URLSearchParams(location.search).get('tutorial') === '1';
let coachDismissed = false;

// ---- local UI-only interaction state (never authoritative) ----
let selectedAttacker = null;     // { type: 'leader' | 'char', idx }
let attachDonMode = false;
let toolboxMode = false;
let tbSelectedTarget = null;     // { side: 'self'|'opp', type: 'leader'|'char', idx }
let awaitingHandDiscard = false;
let effectSelected = [];
let lastEffectKey = null;
let lastPlayedFromRect = null;   // where the last hand card was clicked/dragged from (for the flight animation)
let lastLogTs = 0;
let phaseSweep = null;           // { seat, startedAt } — animates the phase strip on turn start
let sideHidden = window.innerWidth < 1100; // drawer open by default on wide screens
const drag = { active: false, kind: null, srcKey: null, ghost: null, payload: null, startX: 0, startY: 0, pointerId: null };

const PHASES = ['Refresh', 'Draw', 'DON!!', 'Main', 'End'];
const COLOR_RGB = { Red: '211,51,51', Green: '44,154,82', Blue: '42,127,214', Purple: '139,79,196', Black: '90,90,100', Yellow: '224,184,35' };
let turnClock = { seat: null, turnNumber: null, startedAt: Date.now() };
function tintFor(colors, a1, a2) {
  const c = (colors && colors.length ? colors : ['Red']).map((k) => COLOR_RGB[k] || COLOR_RGB.Red);
  const c2 = c.length > 1 ? c[1] : c[0];
  return `--tint1: rgba(${c[0]},${a1}); --tint2: rgba(${c2},${a2}); --av1: rgb(${c[0]}); --av2: rgb(${c2});`;
}
function fmtClock(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function initials(name) { const parts = String(name).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/); return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : (parts[0] || '??')[1] || '')).toUpperCase(); }


async function init() {
  const { cards } = await API.get('/api/cards');
  ALL_CARDS = cards;
  BY_ID = new Map(cards.map((c) => [c.id, c]));
  await loadUser();
  if (!CURRENT_USER) await requireUser();
  wireStaticUi();
  connect();
}

function getCard(id) { return BY_ID.get(id); }
function other(seat) { return seat === 0 ? 1 : 0; }
function currentMe() { return STATE.players.find((p) => p.seat === STATE.you); }
function currentOpp() { return STATE.players.find((p) => p.seat !== STATE.you); }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function powerOf(p, target) {
  if (target === 'leader') { const l = getCard(p.leaderId); return Math.max(0, l.power + p.leaderState.donAttached * 1000 + p.leaderState.powerMod); }
  const c = getCard(target.cardId); return Math.max(0, c.power + target.donAttached * 1000 + target.powerMod);
}
function isMyMain() { return STATE && STATE.phase === 'main' && STATE.turnPlayer === STATE.you && !STATE.pendingBattle && !STATE.pendingEffect && !STATE.pendingTrigger && STATE.winner === null; }
function canCounter(card) { return !!card && ((card.text && /\[Counter\]/.test(card.text)) || (card.type === 'Character' && !!card.counter)); }

// ---------- connection ----------
function connect() {
  const params = new URLSearchParams(location.search);
  const room = (params.get('room') || '').toUpperCase();
  document.getElementById('waiting-code').textContent = room;
  document.getElementById('waiting-copy').onclick = () => navigator.clipboard.writeText(room).then(() => toast('Room code copied!', 'ok'), () => {});
  document.getElementById('waiting-wrap').style.display = '';
  document.getElementById('board-wrap').style.display = 'none';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`);
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'state') {
      PREV = STATE;
      STATE = msg.state;
      META = msg.meta || META;
      if (META.tutorial) TUTORIAL = true;
      document.getElementById('waiting-wrap').style.display = 'none';
      document.getElementById('board-wrap').style.display = '';
      render();
    } else if (msg.type === 'waiting') {
      document.getElementById('waiting-wrap').style.display = '';
      document.getElementById('board-wrap').style.display = 'none';
    } else if (msg.type === 'error') {
      toast(msg.message);
    }
  };
  ws.onopen = () => { reconnectTries = 0; };
  ws.onclose = () => {
    if (STATE && STATE.winner !== null) return;
    if (reconnectTries >= 6) { toast('Lost connection to the table. Reload the page to try again.'); return; }
    const wait = Math.min(8000, 800 * Math.pow(2, reconnectTries++));
    toast(`Connection dropped — reconnecting in ${Math.round(wait / 1000)}s…`);
    setTimeout(connect, wait);
  };
}
let reconnectTries = 0;

function send(type, payload) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ type }, payload || {})));
}

// ---------- static (one-time) UI wiring ----------
function wireStaticUi() {
  const felt = document.getElementById('felt');
  felt.addEventListener('click', (e) => {
    if (drag.moved) return; // a drag just ended on this element — not a click
    const el = e.target.closest('[data-role]');
    if (!el) return;
    onBoardTargetClick(el.dataset.role, el.dataset.side, el.dataset.idx, el);
  });
  wirePreview(felt);
  const hand = document.getElementById('hand-row');
  hand.addEventListener('click', (e) => {
    if (drag.moved) return;
    const el = e.target.closest('.hand-card');
    if (!el) return;
    lastPlayedFromRect = el.getBoundingClientRect();
    onHandCardClick(Number(el.dataset.idx));
  });
  wirePreview(hand);

  document.getElementById('end-turn-btn').onclick = () => { if (isMyMain()) send('endMainPhase'); };
  document.getElementById('attach-don-btn').onclick = () => { attachDonMode = !attachDonMode; selectedAttacker = null; render(); };
  document.getElementById('toolbox-btn').onclick = () => setTab(toolboxMode ? 'log' : 'tools');
  document.querySelectorAll('.side-tab').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
  document.getElementById('toggle-side-btn').onclick = () => { sideHidden = !sideHidden; applyDrawer(); if (STATE) render(); };
  applyDrawer();
  wireDrawerResize();
  document.getElementById('concede-btn').onclick = () => { if (confirm('Concede this match?')) send('concede'); };
  document.getElementById('chat-send-btn').onclick = sendChat;
  const qc = document.getElementById('quick-chat');
  if (qc) qc.querySelectorAll('[data-say]').forEach((b) => { b.onclick = () => send('chat', { text: b.dataset.say }); });
  document.getElementById('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

  document.querySelectorAll('#toolbox-panel [data-tb]').forEach((b) => {
    b.onclick = () => {
      const t = b.dataset.tb;
      if (t === 'draw') send('manualAction', { action: { type: 'draw', count: 1 } });
      else if (t === 'donActivePlus') send('manualAction', { action: { type: 'donAdjust', deltaActive: 1 } });
      else if (t === 'donActiveMinus') send('manualAction', { action: { type: 'donAdjust', deltaActive: -1 } });
      else if (t === 'donDeckPlus') send('manualAction', { action: { type: 'donAdjust', deltaDeck: 1 } });
      else if (t === 'donDeckMinus') send('manualAction', { action: { type: 'donAdjust', deltaDeck: -1 } });
      else if (t === 'discardHand') { awaitingHandDiscard = true; render(); }
    };
  });

  wireDrag();
  window.addEventListener('resize', () => { if (STATE) render(); });
  setInterval(() => {
    if (!STATE || STATE.winner !== null) return;
    const el = document.querySelector(`.plate .clock[data-clock="${STATE.turnPlayer}"]`);
    if (el) el.textContent = fmtClock(Date.now() - turnClock.startedAt);
  }, 1000);
}

// Drag the drawer's right edge to resize it (remembered between sessions).
function wireDrawerResize() {
  const handle = document.getElementById('drawer-resizer');
  const arena = document.querySelector('.arena');
  const drawer = document.getElementById('side-panel');
  let saved = null;
  try { saved = parseInt(localStorage.getItem('gl_drawer_w'), 10); } catch (e) {}
  if (saved && saved >= 260 && saved <= 640) arena.style.setProperty('--side-w', saved + 'px');
  let dragging = false;
  handle.addEventListener('pointerdown', (e) => { dragging = true; drawer.classList.add('resizing'); handle.setPointerCapture(e.pointerId); e.preventDefault(); });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = Math.max(260, Math.min(640, e.clientX - drawer.getBoundingClientRect().left + 8));
    arena.style.setProperty('--side-w', w + 'px');
  });
  const stop = () => { if (!dragging) return; dragging = false; drawer.classList.remove('resizing'); try { localStorage.setItem('gl_drawer_w', parseInt(getComputedStyle(arena).getPropertyValue('--side-w'), 10)); } catch (e) {} if (STATE) render(); };
  handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop);
}

// Drawer open: preview docks at the top of the drawer. Drawer closed: preview floats on the right.
function applyDrawer() {
  const arena = document.querySelector('.arena');
  arena.classList.toggle('side-shown', !sideHidden);
  const preview = document.getElementById('card-preview');
  const drawer = document.getElementById('side-panel');
  if (!sideHidden) drawer.insertBefore(preview, drawer.firstChild.nextSibling); // after the drawer-head
  else arena.appendChild(preview);
}

function setTab(tab) {
  toolboxMode = tab === 'tools';
  tbSelectedTarget = null;
  document.querySelectorAll('.side-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('game-log').style.display = toolboxMode ? 'none' : '';
  document.getElementById('toolbox-panel').style.display = toolboxMode ? '' : 'none';
  if (toolboxMode && sideHidden) document.getElementById('toggle-side-btn').click();
  if (STATE) render();
}

function sendChat() {
  const inp = document.getElementById('chat-input');
  const text = inp.value.trim();
  if (!text) return;
  send('chat', { text });
  inp.value = '';
}

// ---------- click routing ----------
function onBoardTargetClick(role, side, idxStr, el) {
  const idx = idxStr !== undefined && idxStr !== '' ? Number(idxStr) : undefined;
  const me = currentMe(), opp = currentOpp(), meSeat = STATE.you;
  if (role === 'trash') { openPileModal(Number(el.dataset.seat)); return; }

  if (toolboxMode) {
    if (role === 'leader' || role === 'char') { tbSelectedTarget = { side, type: role, idx }; render(); }
    return;
  }

  if (attachDonMode) {
    if (side !== 'self' || (role !== 'leader' && role !== 'char')) return;
    if (me.cost.active <= 0) { toast('No active DON!! left to attach.'); return; }
    send('attachDon', { count: 1, target: role === 'leader' ? 'leader' : idx });
    return;
  }

  // Clicking one of my active DON!! cards during my main phase enters attach mode.
  if (role === 'don' && side === 'self' && isMyMain()) { attachDonMode = true; selectedAttacker = null; render(); return; }

  if (STATE.pendingBattle && STATE.pendingBattle.step === 'block' && STATE.pendingBattle.attackerSeat !== meSeat) {
    if (side === 'self' && role === 'char') {
      const c = me.characterArea[idx];
      const def = c && getCard(c.cardId);
      if (c && !c.rested && def && def.keywords.includes('Blocker')) send('respondBlock', { blockerIndex: idx });
      else toast('That character cannot block (needs to be active with [Blocker]).');
    }
    return;
  }

  if (STATE.pendingEffect && STATE.pendingEffect.seat === meSeat) {
    const wantSide = STATE.pendingEffect.side || 'self';
    if (side !== wantSide) return;
    const val = role === 'leader' ? 'leader' : idx;
    if (!STATE.pendingEffect.pool.includes(val)) return;
    toggleEffectSelection(val);
    return;
  }

  if (isMyMain()) {
    if (side === 'self' && (role === 'leader' || role === 'char')) {
      const eligible = role === 'leader' ? !me.leaderState.rested : !!(me.characterArea[idx] && !me.characterArea[idx].rested && me.characterArea[idx].canAttack);
      if (!eligible) return;
      if (selectedAttacker && selectedAttacker.type === role && selectedAttacker.idx === idx) selectedAttacker = null;
      else selectedAttacker = { type: role, idx };
      render();
      return;
    }
    if (side === 'opp' && selectedAttacker && (role === 'leader' || role === 'char')) {
      const eligible = role === 'leader' ? true : !!(opp.characterArea[idx] && opp.characterArea[idx].rested);
      if (!eligible) { toast('Only the Leader or a Rested Character can be attacked.'); return; }
      declareAttack(selectedAttacker, role === 'leader' ? 'leader' : idx);
      return;
    }
  }
}

function declareAttack(attacker, target) {
  send('declareAttack', { attacker: attacker.type === 'leader' ? 'leader' : attacker.idx, target });
  selectedAttacker = null;
}

function onHandCardClick(idx) {
  const me = currentMe(), meSeat = STATE.you;
  const card = getCard(me.hand[idx]);
  if (!card) return;
  if (awaitingHandDiscard) { send('manualAction', { action: { type: 'moveHandToTrash', handIndex: idx } }); awaitingHandDiscard = false; return; }
  if (STATE.pendingBattle && STATE.pendingBattle.step === 'counter' && other(STATE.pendingBattle.attackerSeat) === meSeat) {
    if (card.text && /\[Counter\]/.test(card.text)) { send('playCounterEvent', { handIndex: idx }); return; }
    if (card.type === 'Character' && card.counter) { send('playCounterCharacter', { handIndex: idx }); return; }
    toast('That card has no Counter to use here.');
    return;
  }
  if (isMyMain()) {
    if (card.cost === null || card.cost > me.cost.active) { toast(`Not enough DON!! (${card.name} costs ${card.cost}, you have ${me.cost.active} active).`); return; }
    if (card.type === 'Character' && !me.characterArea.some((s) => !s)) { toast('Your Character Area is full (5 max).'); return; }
    send('playCard', { handIndex: idx });
  }
}

function toggleEffectSelection(val) {
  const i = effectSelected.indexOf(val);
  if (i >= 0) effectSelected.splice(i, 1);
  else { if (effectSelected.length >= STATE.pendingEffect.max) return; effectSelected.push(val); }
  render();
}

// ---------- drag & drop ----------
// Three drags: hand card → my mat (play), my active DON!! → my Leader/Character (attach),
// my Leader/Character → opponent's Leader/rested Character (attack).
function wireDrag() {
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !STATE) return;
    const hand = e.target.closest('.hand-card.playable');
    const don = e.target.closest('.don.can-act');
    const atk = e.target.closest('#me-mat .card.can-act');
    let kind = null, src = null;
    if (hand) { kind = 'play'; src = hand; }
    else if (don) { kind = 'don'; src = don; }
    else if (atk && !attachDonMode) { kind = 'attack'; src = atk; }
    if (!kind) return;
    drag.active = true; drag.moved = false; drag.kind = kind; drag.srcEl = src; drag.startX = e.clientX; drag.startY = e.clientY; drag.pointerId = e.pointerId;
    drag.payload = kind === 'play' ? { handIndex: Number(src.dataset.idx) }
      : kind === 'don' ? {}
      : { type: src.dataset.role, idx: src.dataset.idx !== undefined ? Number(src.dataset.idx) : undefined };
    drag.srcKey = src.dataset.key || null;
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag.active) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 7) return;
      drag.moved = true;
      startDragVisuals(e);
    }
    if (drag.ghost) { drag.ghost.style.left = e.clientX + 'px'; drag.ghost.style.top = e.clientY + 'px'; }
    updateDropHover(e.clientX, e.clientY);
  });
  const finish = (e) => {
    if (!drag.active) return;
    if (drag.moved) {
      const target = dropTargetAt(e.clientX, e.clientY);
      performDrop(target);
    }
    endDragVisuals();
    const wasMoved = drag.moved;
    drag.active = false; drag.kind = null; drag.srcEl = null; drag.payload = null; drag.srcKey = null;
    // keep drag.moved true through the click event that follows pointerup, then clear
    if (wasMoved) setTimeout(() => { drag.moved = false; }, 0);
  };
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
}

function startDragVisuals(e) {
  const src = drag.srcEl;
  if (window.SFX) SFX.play('pick');
  if (drag.kind === 'play') lastPlayedFromRect = src.getBoundingClientRect();
  const ghost = src.cloneNode(true);
  ghost.classList.add('ghost');
  ghost.classList.remove('playable', 'can-act', 'hi-ok', 'hi-sel', 'rested');
  ghost.style.width = src.getBoundingClientRect().width + 'px';
  ghost.style.height = src.getBoundingClientRect().height + 'px';
  ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  src.classList.add('dragging-src');
  hideTooltip();
  // highlight valid drop zones
  const meMat = document.getElementById('me-mat'), oppMat = document.getElementById('opp-mat');
  if (drag.kind === 'play') {
    const card = getCard(currentMe().hand[drag.payload.handIndex]);
    if (card && card.type === 'Character') meMat.querySelectorAll('.char-slot:not(:has(.card))').forEach((s) => s.classList.add('drop-ok'));
    meMat.querySelector('.chars').classList.add('drop-ok');
    if (card && card.type === 'Stage') meMat.querySelector('.stage-slot').classList.add('hi-ok');
  } else if (drag.kind === 'don') {
    meMat.querySelectorAll('.card[data-role="leader"], .card[data-role="char"]').forEach((c) => c.classList.add('hi-ok'));
  } else if (drag.kind === 'attack') {
    const opp = currentOpp();
    oppMat.querySelector('.card[data-role="leader"]').classList.add('hi-target');
    opp.characterArea.forEach((c, i) => { if (c && c.rested) { const el = oppMat.querySelector(`.card[data-role="char"][data-idx="${i}"]`); if (el) el.classList.add('hi-target'); } });
  }
}

function updateDropHover(x, y) {
  document.querySelectorAll('.drop-hover').forEach((el) => el.classList.remove('drop-hover'));
  const t = dropTargetAt(x, y);
  if (t && t.el) t.el.classList.add('drop-hover');
}

function dropTargetAt(x, y) {
  if (drag.ghost) drag.ghost.style.display = 'none';
  const el = document.elementFromPoint(x, y);
  if (drag.ghost) drag.ghost.style.display = '';
  if (!el) return null;
  if (drag.kind === 'play') {
    const mat = el.closest('#me-mat');
    return mat ? { el: mat.querySelector('.chars'), kind: 'play' } : null;
  }
  if (drag.kind === 'don') {
    const c = el.closest('#me-mat .card[data-role="leader"], #me-mat .card[data-role="char"]');
    return c ? { el: c, kind: 'don', role: c.dataset.role, idx: c.dataset.idx } : null;
  }
  if (drag.kind === 'attack') {
    const c = el.closest('#opp-mat .card[data-role="leader"], #opp-mat .card[data-role="char"]');
    if (!c) return null;
    if (c.dataset.role === 'char') { const bc = currentOpp().characterArea[Number(c.dataset.idx)]; if (!bc || !bc.rested) return null; }
    return { el: c, kind: 'attack', role: c.dataset.role, idx: c.dataset.idx };
  }
  return null;
}

function performDrop(t) {
  if (!t) return;
  if (t.kind === 'play') onHandCardClick(drag.payload.handIndex);
  else if (t.kind === 'don') { if (currentMe().cost.active > 0) send('attachDon', { count: 1, target: t.role === 'leader' ? 'leader' : Number(t.idx) }); }
  else if (t.kind === 'attack') declareAttack(drag.payload, t.role === 'leader' ? 'leader' : Number(t.idx));
}

function endDragVisuals() {
  if (drag.ghost) { drag.ghost.remove(); drag.ghost = null; }
  document.querySelectorAll('.dragging-src, .drop-ok, .drop-hover').forEach((el) => el.classList.remove('dragging-src', 'drop-ok', 'drop-hover'));
  render();
}

// ---------- DOM diffing ----------
// Patch an existing container to match new HTML instead of rebuilding it, so hover
// states, CSS transitions, in-flight images and the drag source all survive the
// state updates that arrive every fraction of a second during play.
function morph(container, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  morphChildren(container, tpl.content);
}
function morphChildren(from, to) {
  const toKids = Array.from(to.childNodes);
  const fromByKey = new Map();
  Array.from(from.childNodes).forEach((n) => { if (n.nodeType === 1 && n.dataset && n.dataset.key) fromByKey.set(n.dataset.key, n); });
  toKids.forEach((tn, idx) => {
    let fn = from.childNodes[idx];
    const tKey = tn.nodeType === 1 && tn.dataset ? tn.dataset.key : undefined;
    if (tKey) {
      const keyed = fromByKey.get(tKey);
      if (keyed && keyed !== fn) { from.insertBefore(keyed, fn || null); fn = keyed; }
    }
    if (!fn) { from.appendChild(document.importNode(tn, true)); return; }
    const fKey = fn.nodeType === 1 && fn.dataset ? fn.dataset.key : undefined;
    if (fn.nodeType !== tn.nodeType || (fn.nodeType === 1 && (fn.tagName !== tn.tagName || (fKey || '') !== (tKey || '')))) {
      if (fKey && !tKey) { from.insertBefore(document.importNode(tn, true), fn); return; } // keep keyed node for later
      from.replaceChild(document.importNode(tn, true), fn);
      return;
    }
    if (tn.nodeType === 3) { if (fn.nodeValue !== tn.nodeValue) fn.nodeValue = tn.nodeValue; return; }
    if (tn.nodeType !== 1) return;
    morphEl(fn, tn);
  });
  while (from.childNodes.length > toKids.length) from.removeChild(from.lastChild);
}
function morphEl(fn, tn) {
  for (const a of Array.from(fn.attributes)) if (!tn.hasAttribute(a.name)) fn.removeAttribute(a.name);
  for (const a of Array.from(tn.attributes)) if (fn.getAttribute(a.name) !== a.value) fn.setAttribute(a.name, a.value);
  if (fn.tagName === 'IMG') return;
  morphChildren(fn, tn);
}

// ---------- rendering ----------
function render() {
  if (!STATE) return;
  if (STATE.turnPlayer !== STATE.you) { attachDonMode = false; selectedAttacker = null; }
  const effKey = STATE.pendingEffect ? `${STATE.pendingEffect.seat}:${STATE.pendingEffect.cardName}:${STATE.pendingEffect.text}` : null;
  if (effKey !== lastEffectKey) { effectSelected = []; lastEffectKey = effKey; }
  const me = currentMe(), opp = currentOpp();

  // snapshot positions for flight animations
  const before = snapshotRects();

  document.getElementById('room-code-label').textContent = STATE.roomCode;
  const ti = document.getElementById('turn-indicator');
  ti.textContent = STATE.phase === 'gameover' ? 'Game Over' : STATE.phase === 'mulligan' ? 'Mulligan — choose your opening hand' : (STATE.turnPlayer === STATE.you ? `Your turn · ${cap(STATE.phase)} Phase` : `${opp.username}'s turn · ${cap(STATE.phase)} Phase`);
  ti.classList.toggle('mine', STATE.turnPlayer === STATE.you && STATE.phase !== 'gameover');
  document.getElementById('phase-banner').textContent = `Turn ${STATE.turnNumber} · ${cap(STATE.phase)}`;
  document.getElementById('center-badge').textContent = `TURN ${STATE.turnNumber}`;

  const hl = computeHighlights(me, opp);
  if (turnClock.seat !== STATE.turnPlayer || turnClock.turnNumber !== STATE.turnNumber) turnClock = { seat: STATE.turnPlayer, turnNumber: STATE.turnNumber, startedAt: Date.now() };
  const oppMat = document.getElementById('opp-mat'), meMat = document.getElementById('me-mat');
  morph(oppMat, renderMat(opp, false, hl));
  morph(meMat, renderMat(me, true, hl));
  const live = STATE.phase !== 'mulligan' && STATE.winner === null;
  oppMat.classList.toggle('active', live && STATE.turnPlayer === opp.seat);
  oppMat.classList.toggle('idle', live && STATE.turnPlayer !== opp.seat);
  meMat.classList.toggle('active', live && STATE.turnPlayer === me.seat);
  meMat.classList.toggle('idle', live && STATE.turnPlayer !== me.seat);
  const handEl = document.getElementById('hand-row');
  handEl.classList.toggle('my-main', isMyMain());
  handEl.classList.toggle('counter-step', !!(STATE.pendingBattle && STATE.pendingBattle.step === 'counter' && other(STATE.pendingBattle.attackerSeat) === STATE.you));
  morph(document.getElementById('opp-hand'), renderOppHand(opp));
  morph(document.getElementById('hand-row'), renderHand(me));
  document.getElementById('me-name').textContent = me.username;
  document.getElementById('me-sub').textContent = `${me.cost.active} DON!! ready · ${me.hand.length} in hand · ${me.deckCount} in deck`;

  if (drag.active && drag.moved && drag.srcKey) { const el = document.querySelector(`[data-key="${drag.srcKey}"]`); if (el) el.classList.add('dragging-src'); }

  renderLog();
  renderPrompts(me, opp);
  updateActionBar(me);
  renderToolboxTargetActions();
  renderCoach(me, opp);
  updatePhaseStrips();

  document.getElementById('gameover-root').innerHTML = STATE.winner !== null ? gameOverHtml() : '';

  animateDiff(before);
  PREV = STATE;
}

function computeHighlights(me, opp) {
  const set = new Set(), sel = new Set(), targets = new Set();
  const meSeat = STATE.you;
  if (toolboxMode) { if (tbSelectedTarget) sel.add(tbKey(tbSelectedTarget)); return { set, sel, targets }; }
  if (selectedAttacker) {
    sel.add(selectedAttacker.type === 'leader' ? 'self:leader' : `self:char:${selectedAttacker.idx}`);
    targets.add('opp:leader');
    opp.characterArea.forEach((c, i) => { if (c && c.rested) targets.add(`opp:char:${i}`); });
    return { set, sel, targets };
  }
  if (attachDonMode && isMyMain()) {
    set.add('self:leader');
    me.characterArea.forEach((c, i) => { if (c) set.add(`self:char:${i}`); });
    return { set, sel, targets };
  }
  if (STATE.pendingBattle && STATE.pendingBattle.step === 'block' && STATE.pendingBattle.attackerSeat !== meSeat) {
    me.characterArea.forEach((c, i) => { if (c && !c.rested && getCard(c.cardId).keywords.includes('Blocker')) set.add(`self:char:${i}`); });
    return { set, sel, targets };
  }
  if (STATE.pendingEffect && STATE.pendingEffect.seat === meSeat) {
    const side = STATE.pendingEffect.side || 'self';
    STATE.pendingEffect.pool.forEach((v) => set.add(v === 'leader' ? `${side}:leader` : `${side}:char:${v}`));
    effectSelected.forEach((v) => sel.add(v === 'leader' ? `${side}:leader` : `${side}:char:${v}`));
    return { set, sel, targets };
  }
  if (isMyMain()) {
    if (!me.leaderState.rested) set.add('self:leader');
    me.characterArea.forEach((c, i) => { if (c && !c.rested && c.canAttack) set.add(`self:char:${i}`); });
  }
  return { set, sel, targets };
}
function tbKey(t) { return t.type === 'leader' ? `${t.side}:leader` : `${t.side}:char:${t.idx}`; }

function cardClasses(key, hl, extra) {
  let out = 'card' + (extra ? ' ' + extra : '');
  if (hl.set.has(key)) out += ' hi-ok can-act';
  if (hl.sel.has(key)) out += ' hi-sel';
  if (hl.targets.has(key)) out += ' hi-target';
  return out;
}

function cardFace(card, opts = {}) {
  const name = card ? escapeHtml(card.name) : '?';
  const img = card ? cardImgHtml(card) : `<div class="fallback">?</div>`;
  const pips = opts.don ? `<div class="don-chip"><span class="dn"></span>+${opts.don * 1000}</div><div class="don-under">${'<span class="du"></span>'.repeat(Math.min(opts.don, 6))}</div>` : '';
  const kw = opts.kw ? `<span class="kw">${opts.kw}</span>` : '';
  const ptag = opts.power !== undefined ? `<div class="ptag">${opts.power}${opts.mod ? ` <span class="mod${opts.mod < 0 ? ' neg' : ''}">${opts.mod > 0 ? '+' : ''}${opts.mod}</span>` : ''}</div>` : '';
  return img + pips + kw + ptag;
}

function renderMat(p, isMe, hl) {
  const side = isMe ? 'self' : 'opp';
  const leader = getCard(p.leaderId);
  const leaderKey = `${side}:leader`;
  const leaderHtml = `<div class="${cardClasses(leaderKey, hl, 'leader' + (p.leaderState.rested ? ' rested' : ''))}" data-role="leader" data-side="${side}" data-key="L${p.seat}" data-card-id="${p.leaderId}">
      ${cardFace(leader, { power: powerOf(p, 'leader'), mod: p.leaderState.powerMod, don: p.leaderState.donAttached })}
    </div>`;

  const slots = p.characterArea.map((c, i) => {
    if (!c) return `<div class="char-slot" data-slot="${i}" data-side="${side}"></div>`;
    const card = getCard(c.cardId);
    const key = `${side}:char:${i}`;
    const kws = card ? card.keywords.filter((k) => ['Blocker', 'Rush', 'Double Attack', 'Banish'].includes(k)) : [];
    const sick = !c.canAttack && !c.rested && p.seat === STATE.turnPlayer;
    return `<div class="char-slot" data-slot="${i}" data-side="${side}">
      <div class="${cardClasses(key, hl, (c.rested ? 'rested' : '') + (sick ? ' sick' : ''))}" data-role="char" data-side="${side}" data-idx="${i}" data-key="C${c.uid}" data-card-id="${c.cardId}">
        ${cardFace(card, { power: powerOf(p, c), mod: c.powerMod, don: c.donAttached, kw: kws[0] })}
      </div></div>`;
  }).join('');

  const stage = p.stage ? getCard(p.stage) : null;
  const trashTop = p.trash.length ? getCard(p.trash[0]) : null;
  const dons = [];
  const donAct = isMe && isMyMain() && !attachDonMode ? ' can-act' : '';
  for (let i = 0; i < p.cost.active; i++) dons.push(`<div class="don${donAct}" data-role="don" data-side="${side}" data-key="DN${p.seat}-${i}" title="Active DON!!"></div>`);
  for (let i = 0; i < p.cost.rested; i++) dons.push(`<div class="don rested" title="Rested DON!!"></div>`);
  const turnActive = STATE.turnPlayer === p.seat && STATE.phase !== 'gameover';
  const lifePips = Array.from({ length: Math.min(p.lifeCount, 8) }).map(() => '<span class="life-pip"></span>').join('');
  const plate = `<div class="plate${turnActive ? ' active-turn' : ''}" data-key="LF${p.seat}">
      <span class="avatar" style="${tintFor(leader.colors, 1, 1)}">${META.vsBot && !isMe ? 'AI' : initials(p.username)}</span>
      <span class="pname">${escapeHtml(p.username)}</span>
      <span class="sep"></span>
      <span class="stat life" title="Life cards">❤ <b>${p.lifeCount}</b> <span class="life-pips">${lifePips}</span></span>
      <span class="stat" title="Cards in hand">✋ <b>${isMe ? p.hand.length : p.handCount}</b></span>
      <span class="stat" title="Active / total DON!! on field">⚡ <b>${p.cost.active}</b>/${p.cost.active + p.cost.rested}</span>
      <span class="clock${turnActive ? '' : ' dim'}" data-clock="${p.seat}">${turnActive ? fmtClock(Date.now() - turnClock.startedAt) : '—'}</span>
    </div>`;

  const ribbon = turnActive && STATE.phase !== 'mulligan' ? `<div class="turn-ribbon" data-key="RB${p.seat}"><span class="dot"></span>${isMe ? 'Your turn' : `${escapeHtml(p.username)}'s turn`}</div>` : '';
  return `
    ${ribbon}
    <div class="row-board">
      <div class="slot leader-slot"><span class="slabel">LEADER</span>${leaderHtml}</div>
      <div class="slot stage-slot"><span class="slabel">STAGE</span>${stage ? `<div class="card" data-card-id="${p.stage}" data-key="S${p.seat}">${cardFace(stage)}</div>` : ''}</div>
      <div class="chars" data-side="${side}">${slots}</div>
      <div class="stack-col">
        <div class="mini-pile deck" data-key="D${p.seat}"><span class="plabel">Deck</span><span class="cnt">${p.deckCount}</span></div>
        <div class="mini-pile trash" data-key="T${p.seat}" data-role="trash" data-seat="${p.seat}" title="Click to look through the trash" ${trashTop ? `data-card-id="${p.trash[0]}"` : ''}><span class="plabel">Trash</span>${trashTop && !FAILED_IMGS.has(cardImgUrl(trashTop)) ? `<img src="${cardImgUrl(trashTop)}" alt="" onerror="FAILED_IMGS.add(this.src); this.remove();" />` : ''}<span class="cnt">${p.trash.length}</span></div>
      </div>
    </div>
    <div class="row-don">
      ${plate}
      <div class="don-area${dons.length ? '' : ' empty'}">${dons.join('')}</div>
      <div class="don-deck-chip" title="DON!! deck"><div class="don-deck-pile"><span class="cnt">${p.donDeckCount}</span></div></div>
    </div>`;
}

function renderOppHand(opp) {
  return Array.from({ length: opp.handCount }).map((_, i) => `<div class="card-back" data-key="OH${i}"></div>`).join('');
}

function renderHand(me) {
  const meSeat = STATE.you;
  const counterStep = STATE.pendingBattle && STATE.pendingBattle.step === 'counter' && other(STATE.pendingBattle.attackerSeat) === meSeat;
  const myMain = isMyMain();
  return me.hand.map((cardId, i) => {
    const card = getCard(cardId);
    if (!card) return '';
    let cls = 'hand-card';
    if (awaitingHandDiscard) cls += ' discard-ok';
    else if (counterStep && canCounter(card)) cls += ' counter-ok';
    else if (myMain && card.cost !== null && card.cost <= me.cost.active && (card.type !== 'Character' || me.characterArea.some((s) => !s))) cls += ' playable';
    const cost = card.cost !== null && card.cost !== undefined ? `<span class="cost-badge">${card.cost}</span>` : '';
    const cnt = card.type === 'Character' && card.counter ? `<span class="cnt-badge">+${card.counter}</span>` : (card.text && /\[Counter\]/.test(card.text) ? `<span class="cnt-badge">CTR</span>` : '');
    return `<div class="${cls}" data-role="hand" data-idx="${i}" data-key="H${i}-${cardId}" data-card-id="${cardId}">${cardImgHtml(card)}${cost}${cnt}</div>`;
  }).join('');
}

function renderLog() {
  const el = document.getElementById('game-log');
  const html = STATE.log.map((e, i) => `<div class="entry${e.ts > lastLogTs ? ' new' : ''}" data-key="lg${e.ts}-${i}">${escapeHtml(e.text)}</div>`).reverse().join('');
  morph(el, html);
  if (STATE.log.length) lastLogTs = Math.max(lastLogTs, STATE.log[STATE.log.length - 1].ts);
}

function renderPrompts(me, opp) {
  const root = document.getElementById('prompt-root');
  const meSeat = STATE.you;
  let html = '';
  const oppName = escapeHtml(opp.username);
  if (STATE.winner !== null) html = '';
  else if (STATE.phase === 'mulligan' && !me.mulliganDone) {
    html = `<div class="prompt-banner"><span class="txt">Keep this opening hand, or mulligan for a fresh 5?</span>
      <button class="btn small gold" id="prompt-keep">Keep Hand</button><button class="btn small secondary" id="prompt-mull">Mulligan</button></div>`;
  } else if (STATE.phase === 'mulligan') {
    html = `<div class="prompt-banner"><span class="txt">Waiting for ${oppName} to decide on their mulligan…</span></div>`;
  } else if (STATE.pendingTrigger && STATE.pendingTrigger.seat === meSeat) {
    const c = getCard(STATE.pendingTrigger.cardId);
    html = `<div class="prompt-banner"><span class="txt">Life card revealed: <b>${c ? escapeHtml(c.name) : '?'}</b> has [Trigger]! Activate it, or add it to your hand?</span>
      <button class="btn small gold" id="prompt-trig-yes">Activate Trigger</button><button class="btn small secondary" id="prompt-trig-no">Add to Hand</button></div>`;
  } else if (STATE.pendingTrigger) {
    html = `<div class="prompt-banner"><span class="txt">${oppName} revealed a [Trigger] card — deciding…</span></div>`;
  } else if (STATE.pendingEffect && STATE.pendingEffect.seat === meSeat) {
    const max = STATE.pendingEffect.max;
    html = `<div class="prompt-banner"><span class="txt"><b>${escapeHtml(STATE.pendingEffect.cardName)}:</b> ${escapeHtml(STATE.pendingEffect.text)}<br>Click up to ${max} highlighted target${max === 1 ? '' : 's'} (${effectSelected.length}/${max} selected).</span>
      <button class="btn small gold" id="prompt-effect-confirm">Confirm</button></div>`;
  } else if (STATE.pendingEffect) {
    html = `<div class="prompt-banner"><span class="txt">${oppName} is resolving ${escapeHtml(STATE.pendingEffect.cardName)}…</span></div>`;
  } else if (STATE.pendingBattle) {
    const b = STATE.pendingBattle;
    const iDefend = other(b.attackerSeat) === meSeat;
    if (b.step === 'block' && iDefend) {
      const n = me.characterArea.filter((c) => c && !c.rested && getCard(c.cardId).keywords.includes('Blocker')).length;
      html = `<div class="prompt-banner"><span class="txt">You're being attacked! ${n ? `Click a highlighted <b>[Blocker]</b> to redirect the attack, or let it through.` : 'No active Blocker available.'}</span>
        <button class="btn small ${n ? 'secondary' : 'gold'}" id="prompt-noblock">${n ? "Don't Block" : 'Continue'}</button></div>`;
    } else if (b.step === 'block') {
      html = `<div class="prompt-banner"><span class="txt">Attack declared — ${oppName} is deciding whether to block…</span></div>`;
    } else if (b.step === 'counter' && iDefend) {
      html = `<div class="prompt-banner"><span class="txt"><b>Counter Step:</b> click blue-highlighted cards in your hand to add power${b.counterPower ? ` (+${b.counterPower} so far)` : ''}, then confirm.</span>
        <button class="btn small gold" id="prompt-counter-done">${b.counterPower ? 'Done Countering' : 'No Counter'}</button></div>`;
    } else if (b.step === 'counter') {
      html = `<div class="prompt-banner"><span class="txt">Waiting for ${oppName}'s Counter Step…</span></div>`;
    }
  } else if (selectedAttacker) {
    html = `<div class="prompt-banner"><span class="txt">Choose a target: ${oppName}'s <b>Leader</b> or a <b>rested</b> Character (red glow). Tip: you can also just drag your card onto the target.</span>
      <button class="btn small secondary" id="prompt-cancel-attack">Cancel</button></div>`;
  } else if (attachDonMode) {
    html = `<div class="prompt-banner"><span class="txt">Click your Leader or a Character to attach 1 DON!! (+1000 power this turn). ${me.cost.active} active DON!! left.</span>
      <button class="btn small secondary" id="prompt-stop-attach">Done</button></div>`;
  } else if (awaitingHandDiscard) {
    html = `<div class="prompt-banner"><span class="txt">Click a card in your hand to discard it.</span><button class="btn small secondary" id="prompt-cancel-discard">Cancel</button></div>`;
  }
  if (root.dataset.last !== html) { root.innerHTML = html; root.dataset.last = html; }
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('prompt-keep', () => send('mulligan', { keep: true }));
  on('prompt-mull', () => send('mulligan', { keep: false }));
  on('prompt-trig-yes', () => send('respondTrigger', { activate: true }));
  on('prompt-trig-no', () => send('respondTrigger', { activate: false }));
  on('prompt-effect-confirm', () => { send('resolveEffectTargets', { selected: effectSelected }); effectSelected = []; });
  on('prompt-noblock', () => send('respondBlock', { blockerIndex: null }));
  on('prompt-counter-done', () => send('respondCounter', { boost: 0 }));
  on('prompt-cancel-attack', () => { selectedAttacker = null; render(); });
  on('prompt-stop-attach', () => { attachDonMode = false; render(); });
  on('prompt-cancel-discard', () => { awaitingHandDiscard = false; render(); });
}

function updateActionBar(me) {
  const over = STATE.winner !== null;
  const myMain = isMyMain();
  const endBtn = document.getElementById('end-turn-btn');
  endBtn.disabled = over || !myMain;
  const anyPlayable = myMain && me.hand.some((id) => { const c = getCard(id); return c && c.cost !== null && c.cost <= me.cost.active; });
  const anyAttack = myMain && (!me.leaderState.rested || me.characterArea.some((c) => c && !c.rested && c.canAttack));
  endBtn.classList.toggle('pulse', myMain && !anyPlayable && !anyAttack);
  const ad = document.getElementById('attach-don-btn');
  ad.disabled = over || (!myMain && !attachDonMode) || (myMain && me.cost.active === 0 && !attachDonMode);
  ad.textContent = attachDonMode ? 'Done Attaching' : 'Attach DON!!';
  document.getElementById('toolbox-btn').classList.toggle('primary', toolboxMode);
  document.getElementById('concede-btn').disabled = over;
}

function renderToolboxTargetActions() {
  const info = document.getElementById('tb-target-info');
  const actions = document.getElementById('tb-target-actions');
  if (!toolboxMode || !tbSelectedTarget) { info.textContent = toolboxMode ? 'Click any Leader or Character on the table to target it.' : ''; actions.innerHTML = ''; return; }
  const { side, type, idx } = tbSelectedTarget;
  const owner = side === 'self' ? currentMe() : currentOpp();
  const who = side === 'self' ? 'Your' : `${escapeHtml(owner.username)}'s`;
  info.textContent = `Selected: ${who} ${type === 'leader' ? 'Leader' : 'Character #' + (Number(idx) + 1)}`;
  actions.innerHTML = `<button class="pill sm" data-tbact="power+">+1000 Power</button>
    <button class="pill sm" data-tbact="power-">−1000 Power</button>
    <button class="pill sm" data-tbact="rest">Toggle Rest</button>
    ${type === 'char' ? '<button class="pill sm danger" data-tbact="ko">K.O.</button>' : ''}`;
  actions.querySelectorAll('[data-tbact]').forEach((b) => { b.onclick = () => applyTbAction(b.dataset.tbact); });
}
function applyTbAction(act) {
  if (!tbSelectedTarget) return;
  const { side, type, idx } = tbSelectedTarget;
  const target = type === 'leader' ? 'leader' : Number(idx);
  if (act === 'power+') send('manualAction', { action: { type: 'adjustPower', side, target, amount: 1000 } });
  else if (act === 'power-') send('manualAction', { action: { type: 'adjustPower', side, target, amount: -1000 } });
  else if (act === 'rest') send('manualAction', { action: { type: 'toggleRest', side, target } });
  else if (act === 'ko') send('manualAction', { action: { type: 'ko', side, target } });
}

function gameOverHtml() {
  const won = STATE.winner === STATE.you;
  const lastLine = STATE.log.length ? STATE.log[STATE.log.length - 1].text : '';
  return `<div class="gameover-overlay"><div class="go-card"><h1 class="${won ? 'win' : ''}">${won ? '🏆 Victory!' : '💀 Defeat'}</h1><p>${escapeHtml(lastLine)}</p>
    <div style="display:flex; gap:10px; justify-content:center;"><a class="pill primary" href="/play.html">Back to Lobby</a>${META.vsBot ? '<a class="pill" href="/play.html">Rematch</a>' : ''}</div></div></div>`;
}

// ---------- phase strip ----------
function updatePhaseStrips() {
  const seat = STATE.turnPlayer;
  const sweeping = phaseSweep && phaseSweep.seat === seat && Date.now() - phaseSweep.startedAt < 1100;
  const step = sweeping ? Math.min(3, Math.floor((Date.now() - phaseSweep.startedAt) / 260)) : (STATE.phase === 'main' ? 3 : STATE.phase === 'end' ? 4 : 3);
  const strip = document.getElementById('phase-pips');
  if (!strip.children.length) strip.innerHTML = PHASES.map((ph) => `<span class="ps">${ph}</span>`).join('');
  const active = STATE.phase !== 'mulligan' && STATE.winner === null;
  strip.querySelectorAll('.ps').forEach((el, i) => {
    el.classList.toggle('on', active && i === step);
    el.classList.toggle('done', active && i < step);
  });
  if (sweeping) setTimeout(updatePhaseStrips, 90);
}

// ---------- animations (diff PREV → STATE) ----------
function snapshotRects() {
  const m = new Map();
  document.querySelectorAll('#board-wrap [data-key]').forEach((el) => m.set(el.dataset.key, el.getBoundingClientRect()));
  return m;
}
function rectOf(key) { const el = document.querySelector(`#board-wrap [data-key="${key}"]`); return el ? el.getBoundingClientRect() : null; }
function elOf(key) { return document.querySelector(`#board-wrap [data-key="${key}"]`); }
function centerRect(r, w, h) { return { left: r.left + r.width / 2 - w / 2, top: r.top + r.height / 2 - h / 2, width: w, height: h }; }

function flyCard({ from, to, card, back, delay = 0, duration = 420, fadeOut = false }) {
  if (!from || !to) return;
  const el = document.createElement('div');
  el.className = 'fly' + (back ? ' card-back' : '');
  if (back) el.style.backgroundColor = '#101838';
  el.style.transitionDuration = duration + 'ms';
  el.style.left = from.left + 'px'; el.style.top = from.top + 'px';
  el.style.width = from.width + 'px'; el.style.height = from.height + 'px';
  if (card && !back) el.innerHTML = `<img src="${cardImgUrl(card)}" alt="" onerror="this.style.display='none'" />`;
  document.getElementById('fly-layer').appendChild(el);
  setTimeout(() => {
    void el.offsetWidth;
    const sx = to.width / from.width, sy = to.height / from.height;
    el.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${sx}, ${sy})`;
    el.style.transformOrigin = 'top left';
    if (fadeOut) el.style.opacity = '0.2';
    setTimeout(() => el.remove(), duration + 60);
  }, delay);
}
function floatText(el, text, neg) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const t = document.createElement('div');
  t.className = 'float-text' + (neg ? ' neg' : '');
  t.textContent = text;
  t.style.left = (r.left + r.width / 2) + 'px'; t.style.top = (r.top + r.height * 0.3) + 'px';
  document.getElementById('fly-layer').appendChild(t);
  setTimeout(() => t.remove(), 950);
}
function pulseClass(el, cls, ms) { if (!el) return; el.classList.add(cls); setTimeout(() => el.classList.remove(cls), ms); }
function showTurnBanner(text) {
  const b = document.getElementById('turn-banner');
  b.textContent = text; b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
}

function animateDiff(before) {
  const S = STATE, P = PREV;
  if (!P || P.roomCode !== S.roomCode) { // first render: just pop everything in
    document.querySelectorAll('#board-wrap .card').forEach((c) => c.classList.add('pop-in'));
    if (window.SFX) SFX.play('shuffle');
    if (S.phase !== 'mulligan') phaseSweep = { seat: S.turnPlayer, startedAt: Date.now() - 2000 };
    return;
  }
  const newLog = S.log.filter((l) => !P.log.some((pl) => pl.ts === l.ts && pl.text === l.text)).map((l) => l.text).join(' | ');
  if (/mulligans their hand/.test(newLog)) if (window.SFX) SFX.play('shuffle');
  if (/💬/.test(newLog)) if (window.SFX) SFX.play('chat');
  if (S.winner !== null && P.winner === null) if (window.SFX) SFX.play(S.winner === S.you ? 'win' : 'lose');

  // turn changed → banner + phase sweep
  if (P.turnPlayer !== S.turnPlayer || P.turnNumber !== S.turnNumber || (P.phase === 'mulligan' && S.phase !== 'mulligan')) {
    if (S.phase !== 'mulligan' && S.winner === null) {
      if (window.SFX) SFX.play(S.turnPlayer === S.you ? 'turn' : 'oppTurn');
      showTurnBanner(S.turnPlayer === S.you ? 'Your Turn' : `${currentOpp().username}'s Turn`);
      phaseSweep = { seat: S.turnPlayer, startedAt: Date.now() };
      updatePhaseStrips();
    }
  }

  for (const p of S.players) {
    const pp = P.players.find((x) => x.seat === p.seat);
    const isMe = p.seat === S.you;
    const prevUids = new Map(); pp.characterArea.forEach((c, i) => { if (c) prevUids.set(c.uid, i); });
    const nowUids = new Map(); p.characterArea.forEach((c, i) => { if (c) nowUids.set(c.uid, i); });

    // played characters: fly from hand → slot
    for (const [uid, i] of nowUids) {
      if (prevUids.has(uid)) continue;
      const to = rectOf(`C${uid}`);
      const from = isMe ? (lastPlayedFromRect || before.get('HA0')) : (before.get('HA1') && centerRect(before.get('HA1'), to ? to.width : 60, to ? to.height : 84));
      const el = elOf(`C${uid}`);
      if (el) { el.style.visibility = 'hidden'; setTimeout(() => { el.style.visibility = ''; el.classList.add('pop-in'); }, 400); }
      flyCard({ from, to, card: getCard(p.characterArea[i].cardId), duration: 420 });
      setTimeout(() => { if (window.SFX) SFX.play('place'); }, 380);
      if (isMe) lastPlayedFromRect = null;
    }
    // K.O.'d / removed characters: fly last position → trash
    for (const [uid] of prevUids) {
      if (nowUids.has(uid)) continue;
      const from = before.get(`C${uid}`), to = rectOf(`T${p.seat}`);
      const cid = pp.characterArea[prevUids.get(uid)].cardId;
      flyCard({ from, to, card: getCard(cid), duration: 480, fadeOut: true });
      if (window.SFX) SFX.play('trash');
    }
    // stage played
    if (p.stage && p.stage !== pp.stage) {
      const to = rectOf(`S${p.seat}`);
      flyCard({ from: isMe ? (lastPlayedFromRect || before.get('HA0')) : before.get('HA1'), to, card: getCard(p.stage) });
      if (isMe) lastPlayedFromRect = null;
    }
    // life lost: card back flies from life column to hand (or trash if banished)
    if (p.lifeCount < pp.lifeCount) {
      const from = before.get(`LF${p.seat}`);
      const toHand = rectOf(`HA${isMe ? 0 : 1}`);
      const gotTrashed = p.trash.length > pp.trash.length && (isMe ? p.hand.length : p.handCount) <= (isMe ? pp.hand.length : pp.handCount);
      const to = gotTrashed ? rectOf(`T${p.seat}`) : toHand;
      const n = pp.lifeCount - p.lifeCount;
      for (let k = 0; k < n; k++) flyCard({ from: from && centerRect(from, 46, 64), to: to && centerRect(to, 60, 84), back: true, delay: k * 160, duration: 520 });
      pulseClass(elOf(`L${p.seat}`), 'hit-flash', 500);
      pulseClass(elOf(`L${p.seat}`), 'shake', 400);
      if (window.SFX) SFX.play('hit');
    }
    // drew a card (hand grew without life loss / not from mulligan)
    const handNow = isMe ? p.hand.length : p.handCount, handPrev = isMe ? pp.hand.length : pp.handCount;
    if (handNow > handPrev && p.lifeCount === pp.lifeCount && S.phase !== 'mulligan') {
      const from = before.get(`D${p.seat}`), to = rectOf(`HA${isMe ? 0 : 1}`);
      const n = Math.min(handNow - handPrev, 3);
      for (let k = 0; k < n; k++) flyCard({ from, to: to && centerRect(to, 60, 84), back: !isMe, card: isMe ? getCard(p.hand[p.hand.length - n + k]) : null, delay: k * 120, duration: 380 });
      if (window.SFX) SFX.play('draw');
    }
    // DON!! attached → float +1000
    if (p.leaderState.donAttached > pp.leaderState.donAttached) { floatText(elOf(`L${p.seat}`), `+${(p.leaderState.donAttached - pp.leaderState.donAttached) * 1000}`); if (window.SFX) SFX.play('don'); }
    if (p.cost.active + p.cost.rested + p.leaderState.donAttached > pp.cost.active + pp.cost.rested + pp.leaderState.donAttached && p.donDeckCount < pp.donDeckCount) if (window.SFX) SFX.play('donGain');
    p.characterArea.forEach((c) => { if (!c) return; const prev = pp.characterArea.find((x) => x && x.uid === c.uid); if (prev && c.donAttached > prev.donAttached) { floatText(elOf(`C${c.uid}`), `+${(c.donAttached - prev.donAttached) * 1000}`); if (window.SFX) SFX.play('don'); } if (prev && c.powerMod !== prev.powerMod) floatText(elOf(`C${c.uid}`), `${c.powerMod - prev.powerMod > 0 ? '+' : ''}${c.powerMod - prev.powerMod}`, c.powerMod < prev.powerMod); });
    if (p.leaderState.powerMod !== pp.leaderState.powerMod) floatText(elOf(`L${p.seat}`), `${p.leaderState.powerMod - pp.leaderState.powerMod > 0 ? '+' : ''}${p.leaderState.powerMod - pp.leaderState.powerMod}`, p.leaderState.powerMod < pp.leaderState.powerMod);
  }

  // attack declared → lunge
  if (S.pendingBattle && !P.pendingBattle) {
    const b = S.pendingBattle;
    const atkSeat = b.attackerSeat, defSeat = other(atkSeat);
    const atkP = S.players.find((x) => x.seat === atkSeat);
    const atkEl = b.attacker === 'leader' ? elOf(`L${atkSeat}`) : (atkP.characterArea[b.attacker] && elOf(`C${atkP.characterArea[b.attacker].uid}`));
    const defP = S.players.find((x) => x.seat === defSeat);
    const defEl = b.target === 'leader' ? elOf(`L${defSeat}`) : (defP.characterArea[b.target] && elOf(`C${defP.characterArea[b.target].uid}`));
    if (atkEl && defEl) {
      const a = atkEl.getBoundingClientRect(), d = defEl.getBoundingClientRect();
      const dx = (d.left - a.left) * 0.35, dy = (d.top - a.top) * 0.35;
      atkEl.style.setProperty('--lx', dx + 'px'); atkEl.style.setProperty('--ly', dy + 'px');
      pulseClass(atkEl, 'lunge', 460);
      setTimeout(() => defEl.classList.add('hi-target'), 200);
      if (window.SFX) SFX.play('attack');
    }
  }
  // battle resolved
  if (P.pendingBattle && !S.pendingBattle && S.winner === null) {
    const b = P.pendingBattle;
    const defSeat = other(b.attackerSeat);
    const defP = S.players.find((x) => x.seat === defSeat);
    const defEl = b.target === 'leader' ? elOf(`L${defSeat}`) : (defP.characterArea[b.target] && elOf(`C${defP.characterArea[b.target].uid}`));
    if (/attack fails/.test(newLog)) { floatText(defEl, 'Attack fails', false); if (window.SFX) SFX.play('miss'); }
    else if (/attacker wins/.test(newLog) && b.target !== 'leader') { pulseClass(defEl, 'hit-flash', 500); if (window.SFX) SFX.play('hit'); }
  }
  if (/blocks with/.test(newLog)) { const s = S.pendingBattle ? other(S.pendingBattle.attackerSeat) : null; if (s !== null) floatText(elOf(`L${s}`), 'Blocked!', false); if (window.SFX) SFX.play('block'); }
  if (/as a Counter/.test(newLog)) { const s = S.pendingBattle ? other(S.pendingBattle.attackerSeat) : null; if (s !== null) floatText(elOf(`L${s}`), 'Counter!', false); if (window.SFX) SFX.play('counter'); }
  if (/reveals a card with \[Trigger\]/.test(newLog)) if (window.SFX) SFX.play('trigger');
  // a decision landed on me → gentle prompt chime
  const needsMe = (S.pendingBattle && other(S.pendingBattle.attackerSeat) === S.you && S.pendingBattle.step === 'block' && !(P.pendingBattle && P.pendingBattle.step === 'block'))
    || (S.pendingTrigger && S.pendingTrigger.seat === S.you && !P.pendingTrigger)
    || (S.pendingEffect && S.pendingEffect.seat === S.you && !P.pendingEffect);
  if (needsMe) if (window.SFX) SFX.play('prompt');
}

// ---------- card preview pane (large art + text, top of the sidebar) ----------
let previewPinnedId = null;
function wirePreview(container) {
  container.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-card-id]');
    if (!el || previewPinnedId) return;
    showPreview(el.dataset.cardId);
  });
  container.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('[data-card-id]');
    if (!el) return;
    e.preventDefault();
    // right-click pins / unpins a card in the preview so you can read it while moving the mouse
    previewPinnedId = previewPinnedId === el.dataset.cardId ? null : el.dataset.cardId;
    showPreview(el.dataset.cardId);
    document.getElementById('card-preview').classList.toggle('pinned', !!previewPinnedId);
  });
}
function showPreview(cardId) {
  const card = getCard(cardId);
  if (!card) return;
  const img = document.getElementById('cp-img');
  if (img.getAttribute('src') !== cardImgUrl(card)) { img.src = cardImgUrl(card); img.alt = card.name; }
  document.getElementById('cp-name').textContent = card.name;
  const stats = [
    card.type,
    card.cost !== null && card.cost !== undefined ? `Cost ${card.cost}` : null,
    card.power !== null && card.power !== undefined ? `Power ${card.power}` : null,
    card.counter ? `Counter +${card.counter}` : null,
    card.life ? `Life ${card.life}` : null,
    card.colors && card.colors.join('/'),
    card.attribute,
    card.types && card.types.length ? card.types.join(' / ') : null,
    card.id,
  ].filter(Boolean).join(' · ');
  document.getElementById('cp-meta').textContent = stats;
  document.getElementById('cp-text').textContent = card.text || '';
}

// ---------- trash pile viewer ----------
function openPileModal(seat) {
  const p = STATE.players.find((x) => x.seat === seat);
  if (!p) return;
  closePileModal();
  if (window.SFX) SFX.play('open');
  const wrap = document.createElement('div');
  wrap.className = 'pile-modal-backdrop';
  wrap.id = 'pile-modal';
  const cards = p.trash.map((id) => getCard(id)).filter(Boolean);
  wrap.innerHTML = `<div class="pile-modal">
      <div class="pm-head"><b>${escapeHtml(p.username)}'s Trash</b> <span class="chip">${cards.length} card${cards.length === 1 ? '' : 's'}</span><button class="pill sm ghost" id="pm-close">Close</button></div>
      <div class="pm-grid">${cards.length ? cards.map((c) => `<div class="card pm-card" data-card-id="${c.id}">${cardFace(c)}</div>`).join('') : '<p class="pm-empty">Nothing here yet.</p>'}</div>
    </div>`;
  document.body.appendChild(wrap);
  wirePreview(wrap);
  wrap.querySelector('#pm-close').onclick = closePileModal;
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closePileModal(); });
}
function closePileModal() { const m = document.getElementById('pile-modal'); if (m) { m.remove(); if (window.SFX) SFX.play('close'); } }

// ---------- keyboard shortcuts ----------
document.addEventListener('keydown', (e) => {
  if (!STATE) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (e.key === 'Escape') {
    if (document.getElementById('pile-modal')) { closePileModal(); return; }
    selectedAttacker = null; attachDonMode = false; awaitingHandDiscard = false; render();
  } else if (e.key === 'e' || e.key === 'E') {
    if (isMyMain()) { send('endMainPhase'); }
  } else if (e.key === 'l' || e.key === 'L') {
    document.getElementById('toggle-side-btn').click();
  } else if (e.key === 'Enter') {
    const primary = document.querySelector('#prompt-root .btn.gold');
    if (primary) primary.click();
  }
});

// ---------- tutorial coach ----------
let coachOpen = false;
let coachLastAction = '';
function renderCoach(me, opp) {
  const panel = document.getElementById('coach-panel');
  const wrap = document.getElementById('felt');
  if (!TUTORIAL || coachDismissed) { panel.style.display = 'none'; wrap.classList.remove('has-coach'); return; }
  const c = coachContent(me, opp);
  panel.style.display = '';
  wrap.classList.add('has-coach');
  const line = c.action || c.body;
  const html = `
    <div class="cs-line" id="cs-line">
      <span class="cs-badge">COACH · ${c.title}</span>
      <span class="cs-do">${line}</span>
      <button class="cs-more" id="cs-more">${coachOpen ? 'less ▴' : 'more ▾'}</button>
      <button class="cs-close" id="cs-close" title="Hide coach">✕</button>
    </div>
    <div class="cs-body">
      <p>${c.body}</p>
      ${c.action ? `<p><b style="color:var(--lime)">Do this:</b> ${c.action}</p>` : ''}
      ${c.tip ? `<div class="cs-tip">💡 ${c.tip}</div>` : ''}
    </div>`;
  if (panel.dataset.last !== html) {
    panel.innerHTML = html;
    panel.dataset.last = html;
    document.getElementById('cs-line').onclick = (e) => { if (e.target.id === 'cs-close') return; coachOpen = !coachOpen; panel.classList.toggle('open', coachOpen); document.getElementById('cs-more').textContent = coachOpen ? 'less ▴' : 'more ▾'; };
    document.getElementById('cs-close').onclick = (e) => { e.stopPropagation(); coachDismissed = true; renderCoach(me, opp); toast('Coach hidden. Reload the page to bring it back.', 'ok'); };
  }
  panel.classList.toggle('open', coachOpen);
  if (line !== coachLastAction) { coachLastAction = line; panel.classList.remove('fresh'); void panel.offsetWidth; panel.classList.add('fresh'); }
}

function coachContent(me, opp) {
  const meSeat = STATE.you;
  const oppName = escapeHtml(opp.username);
  const myTurn = STATE.turnPlayer === meSeat;
  const leader = getCard(me.leaderId);

  if (STATE.winner !== null) {
    return STATE.winner === meSeat
      ? { title: 'Victory', body: `You reduced ${oppName}'s Life to zero and landed one more hit on their Leader — that's how every game of One Piece ends.`, action: 'Head back to the lobby and try again with a different starter deck, or build your own in the Deck Builder.' }
      : { title: 'Defeat', body: `${oppName} got through your Life cards first. Totally normal for a first game — the bot is aggressive on purpose so you see lots of combat.`, action: 'Play again. Try to keep a Blocker on the board and hold a couple of Counter cards in hand for the turns you\'re at low Life.', tip: 'Losing Life isn\'t all bad: each Life card taken goes into your hand, so you\'re drawing extra cards while defending.' };
  }
  if (STATE.phase === 'mulligan') {
    if (!me.mulliganDone) {
      const cheap = me.hand.filter((id) => { const c = getCard(id); return c && c.type === 'Character' && c.cost !== null && c.cost <= 3; }).length;
      return { title: 'Opening hand', body: `Your side of the table is at the bottom, laid out like a real playmat: Life column on the left, Character Area on top, Leader/Stage/Deck in the middle, DON!! Cost Area along the bottom. You drew 5 cards (bottom of the screen). Once per game you may <b>mulligan</b>: shuffle them back and draw a fresh 5. A good keep has 2–3 cheap Characters (cost 1–3). You have <b>${cheap}</b> right now.`, action: cheap >= 2 ? 'This is a fine hand — click <b>Keep Hand</b>.' : 'This hand is slow — try <b>Mulligan</b> for a better start.', tip: 'Hover any card to read its full text and stats.' };
    }
    return { title: 'Waiting', body: `${oppName} is deciding on their mulligan.` };
  }
  if (STATE.pendingTrigger && STATE.pendingTrigger.seat === meSeat) {
    const c = getCard(STATE.pendingTrigger.cardId);
    return { title: 'Trigger!', body: `You took damage and the Life card you revealed — <b>${c ? escapeHtml(c.name) : '?'}</b> — has a <b>[Trigger]</b> effect. You can activate it for free instead of adding it to your hand.`, action: 'Read the [Trigger] text (hover the card in the log or your hand later). If it helps right now, click <b>Activate Trigger</b>; otherwise <b>Add to Hand</b>.', tip: 'Some effects are too unique to auto-resolve — the log will tell you if you need to apply one by hand with the Toolbox.' };
  }
  if (STATE.pendingTrigger) return { title: 'Trigger', body: `${oppName} revealed a Trigger card and is choosing whether to activate it.` };
  if (STATE.pendingEffect && STATE.pendingEffect.seat === meSeat) {
    return { title: 'Choose a target', body: `<b>${escapeHtml(STATE.pendingEffect.cardName)}</b>'s effect needs a target: <i>${escapeHtml(STATE.pendingEffect.text)}</i>`, action: `Click up to ${STATE.pendingEffect.max} green-highlighted card${STATE.pendingEffect.max === 1 ? '' : 's'}, then press <b>Confirm</b>. (You may pick fewer, or none.)` };
  }
  if (STATE.pendingEffect) return { title: 'Effect', body: `${oppName} is choosing targets for ${escapeHtml(STATE.pendingEffect.cardName)}.` };

  if (STATE.pendingBattle) {
    const b = STATE.pendingBattle;
    const iAmDefender = other(b.attackerSeat) === meSeat;
    const attackerP = b.attackerSeat === meSeat ? me : opp;
    const atkCard = b.attacker === 'leader' ? getCard(attackerP.leaderId) : getCard(attackerP.characterArea[b.attacker].cardId);
    const atkPower = powerOf(attackerP, b.attacker === 'leader' ? 'leader' : attackerP.characterArea[b.attacker]);
    const defenderP = iAmDefender ? me : opp;
    const defBase = powerOf(defenderP, b.target === 'leader' ? 'leader' : defenderP.characterArea[b.target]);
    const defNow = defBase + (b.counterPower || 0);
    const targetName = b.target === 'leader' ? 'your Leader' : escapeHtml(getCard(defenderP.characterArea[b.target].cardId).name);
    if (iAmDefender && b.step === 'block') {
      const blockers = me.characterArea.filter((c) => c && !c.rested && getCard(c.cardId).keywords.includes('Blocker')).length;
      return { title: 'You\'re being attacked', body: `${oppName}'s <b>${escapeHtml(atkCard.name)}</b> (${atkPower} power) is attacking ${targetName} (${defBase} power). The attacker wins ties, so ${atkPower} ≥ ${defBase} connects. First comes the <b>Block Step</b>: a Character with <b>[Blocker]</b> can rest itself to take the hit instead.`, action: blockers ? `You have ${blockers} active Blocker${blockers === 1 ? '' : 's'} (green glow). Click one to block, or <b>Don't Block</b>.` : 'You have no active Blocker — click <b>Continue</b> to move to the Counter Step.', tip: 'Blocking with a Character you don\'t mind losing is a great way to protect your Leader\'s Life.' };
    }
    if (iAmDefender && b.step === 'counter') {
      const usable = me.hand.filter((id) => canCounter(getCard(id))).length;
      const need = atkPower - defNow + 1;
      return { title: 'Counter Step', body: `Boost the defender's power for this battle only. It's <b>${atkPower} vs ${defNow}</b>${need > 0 ? ` — you need <b>+${need}</b> or more to survive` : ' — you\'re already safe'}. Discard a Character from hand for its printed <b>counter value</b> (the blue badge), or play an Event with <b>[Counter]</b> text.`, action: need > 0 && usable ? `${usable} card${usable === 1 ? '' : 's'} in your hand can counter (blue glow). Click them until you're above ${atkPower}, then <b>Done</b>.` : 'Click <b>No Counter</b>.', tip: 'Countering costs you cards. Don\'t burn them to save 1 Life early — save them for when you\'re low.' };
    }
    if (!iAmDefender) return { title: 'Attacking', body: `Your <b>${escapeHtml(atkCard.name)}</b> (${atkPower} power) is attacking. ${oppName} is deciding whether to block${b.step === 'counter' ? ' and counter' : ''}.`, tip: 'If your power is ≥ the defender\'s after their counters, you win: a Character target is K.O.\'d, or a Leader hit takes 1 Life.' };
    return { title: 'Battle', body: 'Resolving…' };
  }

  if (myTurn && STATE.phase === 'main') {
    const active = me.cost.active;
    const playable = me.hand.filter((id) => { const c = getCard(id); return c && c.cost !== null && c.cost <= active && (c.type !== 'Character' || me.characterArea.some((s) => !s)); });
    const canAttack = (!me.leaderState.rested ? 1 : 0) + me.characterArea.filter((c) => c && !c.rested && c.canAttack).length;
    const oppRested = opp.characterArea.filter((c) => c && c.rested).length;
    if (attachDonMode) return { title: 'Attaching DON!!', body: `Each DON!! you attach gives that card <b>+1000 power</b> for the rest of this turn (they return to your Cost Area next turn). You have ${active} active DON!! left.`, action: 'Click your Leader or a Character to attach 1 DON!!. Then click <b>Done</b>.' };
    if (selectedAttacker) return { title: 'Choose a target', body: `You can attack the opponent's <b>Leader</b> (hits their Life) or one of their <b>rested</b> Characters (K.O.s it if you win). Active Characters can't be attacked directly.`, action: `Click a red-glowing target. ${oppName} has ${oppRested} rested Character${oppRested === 1 ? '' : 's'} right now.` };
    if (STATE.turnNumber <= 2) {
      return { title: 'Your first Main Phase', body: `The game did Refresh, Draw and DON!! for you — see the phase strip next to your Leader. You have <b>${active} active DON!!</b> (the gold cards in your Cost Area). DON!! is your currency: play a card by paying its cost, or attach DON!! to a card for +1000 power. Every turn you get 2 more.`, action: playable.length ? `${playable.length} card${playable.length === 1 ? '' : 's'} in your hand ${playable.length === 1 ? 'is' : 'are'} affordable (green glow). <b>Drag one onto your Character Area</b> — or just click it. When you're done, hit <b>End Turn</b>.` : 'Nothing affordable yet — that\'s normal on turn 1. Click <b>End Turn</b>.', tip: 'Characters can\'t attack the turn they\'re played (they show "zz") unless they have [Rush]. Your Leader can attack every turn from turn 2 on.' };
    }
    return { title: 'Your Main Phase', body: `You have <b>${active} active DON!!</b>. Playable cards glow green in your hand; ${canAttack ? `<b>${canAttack}</b> of your cards can attack (green glow on the table)` : 'nothing can attack right now'}. Good order: play Characters first, then attach leftover DON!!, then attack.`, action: playable.length ? 'Drag or click a Character to play it.' : canAttack ? `Drag a DON!! card onto your attacker to power it up, then <b>drag your Leader/Character onto ${oppName}'s Leader</b> to attack (their Leader has ${getCard(opp.leaderId).power} power — you need at least that much).` : 'Nothing left to do — click <b>End Turn</b>.', tip: opp.lifeCount <= 1 ? `${oppName} is at ${opp.lifeCount} Life — one more Leader hit after their Life runs out wins the game!` : `Your Leader ${escapeHtml(leader.name)} has ${leader.power} base power. Attacks that fall short do nothing but rest the attacker.` };
  }
  if (!myTurn) return { title: `${oppName}'s turn`, body: `Watch the table and the log — the bot plays Characters, attaches DON!!, and attacks. When it attacks you, you'll get to Block and Counter.`, tip: 'Your rested Characters can be attacked on the opponent\'s turn. Attacking with a Character rests it — so every attack is a small risk.' };
  return { title: 'Playing', body: 'Follow the highlights.' };
}

init();
