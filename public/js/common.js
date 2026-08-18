// Shared across every page: API helper, current-user state, nav auth widget, card tooltip.
const API = {
  async get(path) { return handle(await fetch(path)); },
  async post(path, body) { return handle(await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })); },
  async put(path, body) { return handle(await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })); },
  async del(path) { return handle(await fetch(path, { method: 'DELETE' })); },
};
async function handle(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data });
  return data;
}

let CURRENT_USER = null;
async function loadUser() {
  const { user } = await API.get('/api/auth/me');
  CURRENT_USER = user;
  renderUserBox();
  return user;
}

function renderUserBox() {
  const box = document.getElementById('user-box');
  if (!box) return;
  const sfxBtn = `<button class="btn small secondary sfx-btn" data-sfx-toggle title="Toggle sounds">${window.SFX && SFX.muted ? '🔇' : '🔊'}</button>`;
  if (!CURRENT_USER) {
    box.innerHTML = `${sfxBtn}<button class="btn small" id="nav-signin">Sign in</button>`;
    document.getElementById('nav-signin').onclick = () => openAuthModal();
  } else {
    box.innerHTML = `${sfxBtn}
      <span>${CURRENT_USER.guest ? '<span class="guest-tag">GUEST</span> ' : ''}${escapeHtml(CURRENT_USER.username)}</span>
      <button class="btn small secondary" id="nav-signout">Sign out</button>`;
    document.getElementById('nav-signout').onclick = async () => { await API.post('/api/auth/logout'); location.reload(); };
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function openAuthModal(onDone) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal">
      <span class="close-x">&times;</span>
      <h2 id="auth-title">Sign in</h2>
      <div class="error-msg" id="auth-err"></div>
      <div class="field"><label>Username</label><input id="auth-user" autocomplete="username" /></div>
      <div class="field" id="auth-pw-field"><label>Password</label><input id="auth-pw" type="password" autocomplete="current-password" /></div>
      <button class="btn gold" style="width:100%" id="auth-submit">Sign in</button>
      <div class="switcher">No account? <a href="#" id="auth-switch">Register</a> · <a href="#" id="auth-guest">Play as guest</a></div>
    </div>`;
  document.body.appendChild(wrap);
  let mode = 'login';
  const title = wrap.querySelector('#auth-title');
  const submit = wrap.querySelector('#auth-submit');
  const switcher = wrap.querySelector('#auth-switch');
  const err = wrap.querySelector('#auth-err');
  function close() { wrap.remove(); }
  wrap.querySelector('.close-x').onclick = close;
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  switcher.onclick = (e) => {
    e.preventDefault();
    mode = mode === 'login' ? 'register' : 'login';
    title.textContent = mode === 'login' ? 'Sign in' : 'Create your account';
    submit.textContent = mode === 'login' ? 'Sign in' : 'Register';
    switcher.textContent = mode === 'login' ? 'Register' : 'Sign in';
    err.textContent = '';
  };
  wrap.querySelector('#auth-guest').onclick = async (e) => {
    e.preventDefault();
    const { user } = await API.post('/api/auth/guest');
    CURRENT_USER = user;
    renderUserBox();
    close();
    if (onDone) onDone(user);
  };
  submit.onclick = async () => {
    err.textContent = '';
    const username = wrap.querySelector('#auth-user').value.trim();
    const password = wrap.querySelector('#auth-pw').value;
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const { user } = await API.post(path, { username, password });
      CURRENT_USER = user;
      renderUserBox();
      close();
      if (onDone) onDone(user);
    } catch (e) {
      err.textContent = e.message;
    }
  };
}

async function requireUser() {
  if (CURRENT_USER) return CURRENT_USER;
  return new Promise((resolve) => openAuthModal(resolve));
}

// ---------- card art / tooltip helpers (shared by deck builder + board) ----------
// ---- Card art -------------------------------------------------------------------------
// Every card has up to three places its picture can come from:
//   1. card.image   — optcgapi.com (primary)
//   2. card.image2  — the official Bandai card list
//   3. /api/card-image/:id — our own server fetches + caches it (works even when a player's
//      network/ISP/browser blocks the art hosts, which is why a friend might see no pictures)
// The <img> walks that chain on error; the first source that works is remembered per card so
// re-renders go straight to it, and only if all three fail do we draw a text tile.
const IMG_STAGE = new Map(); // card id -> index of the source known to work (-1 = none work)
function cardImgSources(card) {
  const srcs = [card.image];
  if (card.image2 && card.image2 !== card.image) srcs.push(card.image2);
  srcs.push('/api/card-image/' + encodeURIComponent(card.id));
  return srcs.filter(Boolean);
}
// Best URL to try first for this card right now (used by the few places that set <img src> directly).
function cardImgUrl(card) {
  const srcs = cardImgSources(card);
  const stage = IMG_STAGE.get(card.id);
  return srcs[stage > 0 && stage < srcs.length ? stage : 0];
}
const FAILED_IMGS = new Set(); // URLs known to be dead (kept for older call sites)
function cardImgFallback(img) {
  FAILED_IMGS.add(img.getAttribute('src'));
  const cid = img.dataset.cid;
  const next = (img.dataset.next || '').split('|').filter(Boolean);
  if (next.length) {
    img.dataset.next = next.slice(1).join('|');
    img.dataset.stage = String((parseInt(img.dataset.stage || '0', 10) || 0) + 1);
    img.src = next[0];
    return;
  }
  if (cid) IMG_STAGE.set(cid, -1);
  const d = document.createElement('div');
  d.className = 'fallback';
  d.textContent = img.getAttribute('alt') || '?';
  img.replaceWith(d);
}
function cardImgLoaded(img) {
  const cid = img.dataset.cid;
  const stage = parseInt(img.dataset.stage || '0', 10) || 0;
  if (cid && stage > 0) IMG_STAGE.set(cid, stage);
}
// <img> for a card (with the fallback chain wired), or the text tile straight away if every
// source is known to be unavailable. Reads the name from <img alt> so it's safe for names
// with quotes/apostrophes (Kin'emon) — never interpolate names into inline JS.
function cardImgHtml(card, extraAttrs = '') {
  const srcs = cardImgSources(card);
  const name = escapeHtml(card.name);
  let stage = IMG_STAGE.get(card.id) ?? 0;
  if (stage < 0 || stage >= srcs.length) return `<div class="fallback">${name}</div>`;
  const rest = srcs.slice(stage + 1).join('|');
  return `<img src="${srcs[stage]}" alt="${name}" draggable="false" data-cid="${escapeHtml(card.id)}" data-stage="${stage}" data-next="${escapeHtml(rest)}" ${extraAttrs} onerror="cardImgFallback(this)" onload="cardImgLoaded(this)" />`;
}
// For an <img> that already exists (e.g. the big preview): point it at a card, walking the chain.
function setCardImg(img, card) {
  if (!card) { img.removeAttribute('src'); return; }
  const srcs = cardImgSources(card);
  let stage = IMG_STAGE.get(card.id) ?? 0;
  if (stage < 0 || stage >= srcs.length) stage = 0;
  img.dataset.cid = card.id; img.dataset.stage = String(stage); img.dataset.next = srcs.slice(stage + 1).join('|');
  img.alt = card.name;
  img.onerror = () => { const cid = img.dataset.cid; const next = (img.dataset.next || '').split('|').filter(Boolean); if (next.length) { img.dataset.next = next.slice(1).join('|'); img.dataset.stage = String((+img.dataset.stage || 0) + 1); img.src = next[0]; } else { if (cid) IMG_STAGE.set(cid, -1); img.removeAttribute('src'); } };
  img.onload = () => cardImgLoaded(img);
  if (img.getAttribute('src') !== srcs[stage]) img.src = srcs[stage];
}

// "Alternate Art" -> "ALT", "Parallel · Manga" -> "MANGA", "Reprint · PRB-01" -> "PRB-01", promos -> "PROMO"...
function variantShort(v) {
  if (!v) return '';
  const s = v.toLowerCase();
  if (s.includes('manga')) return 'MANGA';
  if (/\bspr\b/.test(s)) return 'SPR';
  if (/\bsp\b/.test(s)) return 'SP';
  if (s.includes('box topper')) return 'TOPPER';
  if (s.includes('full art')) return 'FULL ART';
  if (s.includes('wanted')) return 'WANTED';
  if (s.includes('treasure')) return 'TR';
  if (s.includes('reprint')) { const m = v.match(/PRB-?\d+/i); return m ? m[0].toUpperCase() : 'REPRINT'; }
  if (s.includes('parallel') || s.includes('alternate')) return 'ALT';
  if (s.includes('winner') || s.includes('finalist') || s.includes('champion')) return 'WINNER';
  return 'PROMO';
}

function cardColorClass(card) { return 'color-' + (card.colors && card.colors[0] || 'Red'); }

function miniCardHtml(card, opts = {}) {
  const cost = card.cost !== null && card.cost !== undefined ? card.cost : (card.type === 'Leader' ? 'L' : '');
  return `
    <div class="mini-card ${cardColorClass(card)} ${opts.extraClass || ''}" data-card-id="${card.id}">
      ${cost !== '' ? `<span class="badge-cost">${cost}</span>` : ''}
      ${opts.count ? `<span class="count-badge">x${opts.count}</span>` : ''}
      ${card.variant ? `<span class="badge-variant" title="${escapeHtml(card.variant)}">${escapeHtml(variantShort(card.variant))}</span>` : ''}
      ${cardImgHtml(card, 'loading="lazy"')}
      ${card.power !== null && card.power !== undefined ? `<span class="badge-power">${card.power}</span>` : ''}
      <div class="name-tag">${escapeHtml(card.name)}</div>
    </div>`;
}

let tooltipEl = null;
function attachCardTooltips(container, getCardById) {
  container.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-card-id]');
    if (!el) return;
    const card = getCardById(el.dataset.cardId);
    if (!card) return;
    showTooltip(card, e.clientX, e.clientY);
  });
  container.addEventListener('mousemove', (e) => {
    if (tooltipEl) positionTooltip(e.clientX, e.clientY);
  });
  container.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-card-id]')) hideTooltip();
  });
}
function showTooltip(card, x, y) {
  hideTooltip();
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'card-tooltip';
  const stats = [
    card.cost !== null && card.cost !== undefined ? `Cost ${card.cost}` : null,
    card.power !== null && card.power !== undefined ? `Power ${card.power}` : null,
    card.counter ? `Counter +${card.counter}` : null,
    card.life ? `Life ${card.life}` : null,
    card.colors && card.colors.join('/'),
    card.attribute,
  ].filter(Boolean).join(' · ');
  tooltipEl.innerHTML = `
    <img src="${cardImgUrl(card)}" onerror="this.style.display='none'" />
    <div class="ct-name">${escapeHtml(card.name)}</div>
    <div class="ct-meta">${escapeHtml(stats)}${card.types && card.types.length ? '<br>' + escapeHtml(card.types.join(' / ')) : ''}</div>
    <div class="ct-text">${escapeHtml(card.text || '')}</div>`;
  document.body.appendChild(tooltipEl);
  positionTooltip(x, y);
}
function positionTooltip(x, y) {
  if (!tooltipEl) return;
  const pad = 16;
  let left = x + pad, top = y + pad;
  if (left + 280 > window.innerWidth) left = x - 280 - pad;
  if (top + 380 > window.innerHeight) top = Math.max(10, window.innerHeight - 390);
  tooltipEl.style.left = left + 'px';
  tooltipEl.style.top = top + 'px';
}
function hideTooltip() { if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; } }

function toast(msg, kind) {
  if (window.SFX) SFX.play(kind === 'ok' ? 'toggle' : 'error');
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

document.addEventListener('DOMContentLoaded', () => { loadUser(); });

// ---- Big card viewer (click a card → admire the artwork) -------------------------------
// openCardModal(card, { list, index }) — with a list you get ◀ ▶ / arrow keys to browse.
let _cardModalState = null;
function openCardModal(card, opts = {}) {
  if (!card) return;
  closeCardModal();
  _cardModalState = { list: opts.list || null, index: opts.index || 0, getCard: opts.getCard || null };
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop card-viewer'; wrap.id = 'card-modal';
  wrap.innerHTML = `<div class="cv-inner">
      <button class="cv-nav prev" data-cv-prev title="Previous (←)">‹</button>
      <div class="cv-card" id="cv-card"></div>
      <div class="cv-info" id="cv-info"></div>
      <button class="cv-nav next" data-cv-next title="Next (→)">›</button>
      <button class="cv-close" data-cv-close title="Close (Esc)">✕</button>
    </div>`;
  document.body.appendChild(wrap);
  renderCardModal(card);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-cv-close]')) { closeCardModal(); return; }
    if (e.target.closest('[data-cv-prev]')) cardModalStep(-1);
    if (e.target.closest('[data-cv-next]')) cardModalStep(1);
  });
  if (window.SFX) SFX.play('open');
}
function renderCardModal(card) {
  const st = _cardModalState;
  const box = document.getElementById('cv-card');
  box.innerHTML = `<div class="cv-frame ${cardColorClass(card)} ${st && st.tierClass ? st.tierClass : ''}">${cardImgHtml(card)}</div>`;
  const stats = [
    card.type,
    card.cost !== null && card.cost !== undefined ? `Cost ${card.cost}` : null,
    card.power !== null && card.power !== undefined ? `Power ${card.power}` : null,
    card.counter ? `Counter +${card.counter}` : null,
    card.life ? `Life ${card.life}` : null,
    card.colors && card.colors.join('/'),
    card.attribute,
    card.rarity,
  ].filter(Boolean).join(' · ');
  document.getElementById('cv-info').innerHTML = `
    <div class="cv-name">${escapeHtml(card.name)}${card.variant ? ` <span class="badge-variant">${escapeHtml(variantShort(card.variant))}</span>` : ''}</div>
    <div class="cv-meta">${escapeHtml(card.id)}${card.variant ? ' · ' + escapeHtml(card.variant) : ''}${card.types && card.types.length ? ' · ' + escapeHtml(card.types.join(' / ')) : ''}</div>
    <div class="cv-stats">${escapeHtml(stats)}</div>
    <div class="cv-text">${escapeHtml(card.text || '')}</div>
    ${st && st.list ? `<div class="cv-count">${st.index + 1} / ${st.list.length}</div>` : ''}`;
  const hasList = st && st.list && st.list.length > 1;
  document.querySelectorAll('#card-modal .cv-nav').forEach((b) => { b.style.display = hasList ? '' : 'none'; });
}
function cardModalStep(dir) {
  const st = _cardModalState;
  if (!st || !st.list || st.list.length < 2) return;
  st.index = (st.index + dir + st.list.length) % st.list.length;
  const item = st.list[st.index];
  const card = typeof item === 'string' ? (st.getCard ? st.getCard(item) : null) : (item && item.id && st.getCard ? st.getCard(item.id) : item);
  if (card) { st.tierClass = item && item.tier ? 'tier-' + item.tier : ''; renderCardModal(card); if (window.SFX) SFX.play('flip'); }
}
function closeCardModal() { const m = document.getElementById('card-modal'); if (m) m.remove(); _cardModalState = null; }
document.addEventListener('keydown', (e) => {
  if (!document.getElementById('card-modal')) return;
  if (e.key === 'Escape') { closeCardModal(); e.stopPropagation(); }
  else if (e.key === 'ArrowLeft') cardModalStep(-1);
  else if (e.key === 'ArrowRight') cardModalStep(1);
});
