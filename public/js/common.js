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
function cardImgUrl(card) { return card.image; }

// If a hotlinked card image fails to load, swap in a text tile with the card's name.
// Reads the name from the <img alt> so it's safe for names with quotes/apostrophes
// (e.g. Kin'emon) — never interpolate names into inline JS. Failed URLs are remembered
// so re-renders draw the tile directly instead of re-requesting (and flickering).
const FAILED_IMGS = new Set();
function cardImgFallback(img) {
  FAILED_IMGS.add(img.getAttribute('src'));
  const d = document.createElement('div');
  d.className = 'fallback';
  d.textContent = img.getAttribute('alt') || '?';
  img.replaceWith(d);
}
// <img> for a card, or the text tile straight away if that art is known to be unavailable.
function cardImgHtml(card, extraAttrs = '') {
  const url = cardImgUrl(card);
  const name = escapeHtml(card.name);
  if (FAILED_IMGS.has(url)) return `<div class="fallback">${name}</div>`;
  return `<img src="${url}" alt="${name}" draggable="false" ${extraAttrs} onerror="cardImgFallback(this)" />`;
}

function cardColorClass(card) { return 'color-' + (card.colors && card.colors[0] || 'Red'); }

function miniCardHtml(card, opts = {}) {
  const cost = card.cost !== null && card.cost !== undefined ? card.cost : (card.type === 'Leader' ? 'L' : '');
  return `
    <div class="mini-card ${cardColorClass(card)} ${opts.extraClass || ''}" data-card-id="${card.id}">
      ${cost !== '' ? `<span class="badge-cost">${cost}</span>` : ''}
      ${opts.count ? `<span class="count-badge">x${opts.count}</span>` : ''}
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
