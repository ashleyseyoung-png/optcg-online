// My Collection — every card pulled from packs, with counts, filters and recent hits.
let BY_ID = new Map(), OWNED = [], STATS = [], RECENT = [];
const RARITY_ORDER = { manga: 0, SEC: 1, tr: 2, sp: 3, parallel: 4, SR: 5, L: 6, R: 7, UC: 8, C: 9 };
function getCard(id) { return BY_ID.get(id); }
function tierOfCard(c) {
  if (!c) return 'C';
  if (c.variant) { const v = c.variant.toLowerCase(); if (/manga/.test(v)) return 'manga'; if (/treasure/.test(v)) return 'tr'; if (/\bsp\b/.test(v) && !/spr/.test(v)) return 'sp'; return 'parallel'; }
  return c.rarity || 'C';
}
const TIER_LABEL = { C: 'Common', UC: 'Uncommon', R: 'Rare', L: 'Leader', SR: 'Super Rare', SEC: 'Secret Rare', parallel: 'Alt Art', manga: 'Manga Rare', sp: 'SP', tr: 'Treasure Rare' };

async function init() {
  const [{ cards }, coll] = await Promise.all([API.get('/api/cards'), API.get('/api/collection')]);
  BY_ID = new Map(cards.map((c) => [c.id, c]));
  OWNED = coll.cards.filter((r) => getCard(r.id)); STATS = coll.stats; RECENT = coll.recent;
  await loadUser();
  if (!coll.signedIn) {
    document.getElementById('coll-sub').innerHTML = 'Sign in (or play as guest) and rip some packs — your pulls will show up here. <a href="/packs.html">Go rip packs →</a>';
  }
  const sets = [...new Set(OWNED.map((r) => getCard(r.id).set))].sort();
  const sel = document.getElementById('coll-set');
  for (const s of sets) { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); }
  ['coll-search', 'coll-set', 'coll-tier', 'coll-sort'].forEach((id) => { const el = document.getElementById(id); el.addEventListener('input', render); el.addEventListener('change', render); });
  // click a card → big viewer (with ◀ ▶ through what's on screen)
  const clickToView = (container) => container.addEventListener('click', (e) => {
    const el = e.target.closest('[data-card-id]'); if (!el) return;
    const items = [...container.querySelectorAll('[data-card-id]')].map((x) => ({ id: x.dataset.cardId, tier: x.dataset.tier || null }));
    const index = items.findIndex((x) => x.id === el.dataset.cardId);
    openCardModal(getCard(el.dataset.cardId), { list: items, index: Math.max(0, index), getCard });
    if (el.dataset.tier) { _cardModalState.tierClass = 'tier-' + el.dataset.tier; renderCardModal(getCard(el.dataset.cardId)); }
  });
  clickToView(document.getElementById('coll-grid'));
  clickToView(document.getElementById('coll-recent'));
  renderStats(); renderRecent(); render();
}

function renderStats() {
  const total = OWNED.reduce((a, r) => a + r.count, 0);
  const packs = STATS.reduce((a, s) => a + s.packs, 0), hits = STATS.reduce((a, s) => a + s.hits, 0);
  const uniq = OWNED.length;
  const chip = (v, l) => `<span class="ds-chip"><b>${v}</b>${l}</span>`;
  document.getElementById('coll-stats').innerHTML = total ? `${chip(total, 'cards')}${chip(uniq, 'unique')}${chip(packs, 'packs ripped')}${chip(hits, 'hits')}<a class="btn small gold" href="/packs.html">Rip more →</a>` : `<a class="btn small gold" href="/packs.html">Rip your first pack →</a>`;
}
function renderRecent() {
  const box = document.getElementById('coll-recent');
  if (!RECENT.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="rh-title">Recent hits</div><div class="rh-row">${RECENT.slice(0, 16).map((r) => { const c = getCard(r.id); return c ? `<div class="rh-card tier-${r.tier}" data-card-id="${c.id}" data-tier="${r.tier}" title="${escapeHtml(c.name)} · ${TIER_LABEL[r.tier] || r.tier} · ${r.set}">${cardImgHtml(c, 'loading="lazy"')}</div>` : ''; }).join('')}</div>`;
}
function render() {
  const q = document.getElementById('coll-search').value.trim().toLowerCase();
  const set = document.getElementById('coll-set').value;
  const tier = document.getElementById('coll-tier').value;
  const sort = document.getElementById('coll-sort').value;
  let rows = OWNED.map((r) => ({ r, c: getCard(r.id), t: tierOfCard(getCard(r.id)) }));
  if (q) rows = rows.filter(({ c }) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q.replace(/\s+/g, '')));
  if (set) rows = rows.filter(({ c }) => c.set === set);
  if (tier === 'hits') rows = rows.filter(({ t }) => ['SR', 'SEC', 'parallel', 'manga', 'sp', 'tr'].includes(t));
  else if (tier === 'alt') rows = rows.filter(({ t }) => ['parallel', 'manga', 'sp', 'tr'].includes(t));
  else if (tier) rows = rows.filter(({ t }) => t === tier);
  rows.sort((a, b) => sort === 'recent' ? b.r.updated_at - a.r.updated_at : sort === 'count' ? b.r.count - a.r.count || a.c.id.localeCompare(b.c.id) : sort === 'code' ? a.c.id.localeCompare(b.c.id) : (RARITY_ORDER[a.t] - RARITY_ORDER[b.t]) || a.c.id.localeCompare(b.c.id));
  document.getElementById('coll-count').textContent = `${rows.length} card${rows.length === 1 ? '' : 's'}`;
  const grid = document.getElementById('coll-grid');
  grid.innerHTML = rows.length ? rows.map(({ r, c, t }) => miniCardHtml(c, { count: r.count, extraClass: 'owned tier-' + t }).replace('data-card-id=', `data-tier="${t}" data-card-id=`)).join('') : `<p style="color:var(--paper-2)">${OWNED.length ? 'Nothing matches those filters.' : 'No cards yet — go rip some packs!'}</p>`;
}
init();
