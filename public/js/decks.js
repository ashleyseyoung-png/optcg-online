let ALL_CARDS = [];
let BY_ID = new Map();
let deck = { name: '', leaderId: null, cards: {} };
let currentDeckId = null;

const MAX_COPIES = 4;
const DECK_SIZE = 50;

async function init() {
  const { cards } = await API.get('/api/cards');
  ALL_CARDS = cards;
  BY_ID = new Map(cards.map((c) => [c.id, c]));
  populateSetFilter();
  await loadUser();
  await refreshMyDecks();
  await populateStarters();
  renderGrid();
  renderDeck();
  wireUi();
}

function getCard(id) { return BY_ID.get(id); }
function deckTotal() { return Object.values(deck.cards).reduce((a, b) => a + b, 0); }
// Copies are counted per card NUMBER: an alt art / parallel / promo is the same card as its
// regular print, so all art versions of e.g. OP01-024 share the 4-copy limit.
function baseOf(id) { const c = getCard(id); return (c && c.baseId) || id; }
function baseCount(baseId) { let n = 0; for (const [cid, cnt] of Object.entries(deck.cards)) if (baseOf(cid) === baseId) n += cnt; return n; }
function printingsOf(baseId) { return ALL_CARDS.filter((c) => c.baseId === baseId).sort((a, b) => (a.id === a.baseId ? -1 : b.id === b.baseId ? 1 : a.id < b.id ? -1 : 1)); }

// ---------------------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------------------
async function populateStarters() {
  const sel = document.getElementById('starter-select');
  try {
    const { decks } = await API.get('/api/starter-decks');
    for (const d of decks) { const opt = document.createElement('option'); opt.value = d.id; opt.textContent = d.name; sel.appendChild(opt); }
  } catch (e) { /* non-fatal */ }
  sel.addEventListener('change', async (e) => {
    const id = e.target.value;
    if (!id) return;
    const d = await API.get(`/api/starter-decks/${id}`);
    deck = { name: d.name + ' (copy)', leaderId: d.leaderId, cards: Object.assign({}, d.cards) };
    currentDeckId = null; // it's a fresh, unsaved copy
    document.getElementById('deck-name').value = deck.name;
    document.getElementById('my-decks-select').value = '';
    document.getElementById('delete-deck-btn').style.display = 'none';
    e.target.value = '';
    renderDeck(); renderGrid();
    toast('Starter deck loaded — tweak it, name it and hit Save to keep your own copy.', 'ok');
  });
}

function populateSetFilter() {
  const sets = [...new Set(ALL_CARDS.map((c) => c.set))].sort();
  const sel = document.getElementById('filter-set');
  for (const s of sets) { const opt = document.createElement('option'); opt.value = s; opt.textContent = s; sel.appendChild(opt); }
}

function wireUi() {
  ['search', 'filter-leader-color', 'filter-type', 'filter-cost', 'filter-set', 'filter-art'].forEach((id) => {
    document.getElementById(id).addEventListener('input', renderGrid);
    document.getElementById(id).addEventListener('change', renderGrid);
  });
  document.getElementById('deck-name').addEventListener('input', (e) => { deck.name = e.target.value; });
  document.getElementById('new-deck-btn').onclick = () => {
    deck = { name: '', leaderId: null, cards: {} };
    currentDeckId = null;
    document.getElementById('deck-name').value = '';
    document.getElementById('my-decks-select').value = '';
    document.getElementById('delete-deck-btn').style.display = 'none';
    renderDeck(); renderGrid();
    document.getElementById('deck-name').focus();
  };
  document.getElementById('clear-deck-btn').onclick = () => { deck.cards = {}; renderDeck(); refreshGridBadges(); };
  document.getElementById('save-deck-btn').onclick = saveDeck;
  document.getElementById('delete-deck-btn').onclick = deleteCurrentDeck;
  document.getElementById('copy-deck-btn').onclick = copyDeckList;
  document.getElementById('import-deck-btn').onclick = () => openImportModal();
  document.getElementById('my-decks-select').addEventListener('change', (e) => { const id = e.target.value; if (id) loadDeckIntoBuilder(id); });

  const grid = document.getElementById('card-grid');
  attachCardTooltips(grid, getCard);
  grid.addEventListener('click', (e) => { const el = e.target.closest('[data-card-id]'); if (el) onCardClick(el.dataset.cardId); });
  grid.addEventListener('contextmenu', (e) => { const el = e.target.closest('[data-card-id]'); if (!el) return; e.preventDefault(); const c = getCard(el.dataset.cardId); if (c && c.type !== 'Leader') changeCount(el.dataset.cardId, -1); });

  const deckList = document.getElementById('deck-list');
  deckList.addEventListener('click', (e) => {
    const dec = e.target.closest('[data-dec]'), inc = e.target.closest('[data-inc]'), art = e.target.closest('[data-art]');
    if (dec) changeCount(dec.dataset.dec, -1);
    if (inc) changeCount(inc.dataset.inc, 1);
    if (art) openArtPicker(art.dataset.art);
  });

  const visual = document.getElementById('deck-visual');
  attachCardTooltips(visual, getCard);
  visual.addEventListener('click', (e) => {
    const dec = e.target.closest('[data-dec]'), inc = e.target.closest('[data-inc]');
    if (dec) { e.stopPropagation(); changeCount(dec.dataset.dec, -1); return; }
    if (inc) { e.stopPropagation(); changeCount(inc.dataset.inc, 1); return; }
    const st = e.target.closest('[data-stack]');
    if (st) openArtPicker(st.dataset.stack);
  });
  visual.addEventListener('contextmenu', (e) => { const st = e.target.closest('[data-stack]'); if (!st) return; e.preventDefault(); changeCount(st.dataset.stack, -1); });
  document.getElementById('dv-leader').addEventListener('click', (e) => { if (deck.leaderId && e.target.closest('[data-card-id]')) openArtPicker(deck.leaderId); });
  attachCardTooltips(document.getElementById('dv-leader'), getCard);
  document.getElementById('deck-stats').addEventListener('click', (e) => {
    const t = e.target.closest('[data-turnorder]');
    if (t) { statsGoingFirst = t.dataset.turnorder === 'first'; renderStats(); }
  });
}

// ---------------------------------------------------------------------------------------
// editing
// ---------------------------------------------------------------------------------------
function onCardClick(id) {
  const card = getCard(id);
  if (!card) return;
  if (card.type === 'Leader') {
    if (window.SFX) SFX.play('flip');
    deck.leaderId = id;
    for (const cid of Object.keys(deck.cards)) { const c = getCard(cid); if (!c.colors.some((col) => card.colors.includes(col))) delete deck.cards[cid]; }
    renderDeck(); renderGrid();
    return;
  }
  changeCount(id, 1);
}

function changeCount(id, delta) {
  const current = deck.cards[id] || 0;
  const others = baseCount(baseOf(id)) - current; // copies of the same card in other art versions
  const next = Math.max(0, Math.min(MAX_COPIES - others, current + delta));
  if (next === current && delta > 0) { const c = getCard(id); toast(`${c ? c.name : id}: max ${MAX_COPIES} copies (counting all art versions).`, 'warn'); }
  if (window.SFX) SFX.play(next > current ? 'place' : next < current ? 'trash' : 'error');
  if (next === 0) delete deck.cards[id]; else deck.cards[id] = next;
  renderDeck(); refreshGridBadges();
}

// swap every copy of one printing for another printing of the same card (art picker)
function swapPrinting(fromId, toId) {
  if (fromId === toId) return;
  if (deck.leaderId === fromId) { deck.leaderId = toId; if (window.SFX) SFX.play('flip'); renderDeck(); renderGrid(); return; }
  const n = deck.cards[fromId] || 0;
  if (!n) return;
  delete deck.cards[fromId];
  deck.cards[toId] = (deck.cards[toId] || 0) + n;
  if (window.SFX) SFX.play('flip');
  renderDeck(); refreshGridBadges();
}

// ---------------------------------------------------------------------------------------
// card search grid (infinite scroll)
// ---------------------------------------------------------------------------------------
let gridList = [];
let gridRendered = 0;
const GRID_CHUNK = 120;
let gridObserver = null;

function renderGrid() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  const colorFilter = document.getElementById('filter-leader-color').value;
  const typeFilter = document.getElementById('filter-type').value;
  const costFilter = document.getElementById('filter-cost').value;
  const setFilter = document.getElementById('filter-set').value;
  const artFilter = (document.getElementById('filter-art') || {}).value || '';
  const leader = deck.leaderId ? getCard(deck.leaderId) : null;
  const qCode = q.replace(/\s+/g, '');
  const qCodeNoDash = qCode.replace(/-/g, '');

  gridList = ALL_CARDS.filter((c) => {
    if (artFilter === 'base' && c.variant) return false;
    if (artFilter === 'alt' && !c.variant) return false;
    if (q) {
      const idL = c.id.toLowerCase(), baseL = (c.baseId || c.id).toLowerCase();
      const hit = c.name.toLowerCase().includes(q) || idL.includes(qCode) || baseL.includes(qCode) || (qCodeNoDash.length >= 4 && idL.replace(/-/g, '').includes(qCodeNoDash))
        || (c.variant || '').toLowerCase().includes(q) || (c.printSet || '').toLowerCase().includes(q)
        || (c.text || '').toLowerCase().includes(q) || (c.types || []).some((t) => t.toLowerCase().includes(q));
      if (!hit) return false;
    }
    if (typeFilter && c.type !== typeFilter) return false;
    if (setFilter && c.set !== setFilter && c.printSet !== setFilter) return false;
    if (costFilter) { const cost = c.cost ?? -1; if (costFilter === '8') { if (cost < 8) return false; } else if (cost !== parseInt(costFilter, 10)) return false; }
    if (colorFilter !== 'all' && leader && c.type !== 'Leader') { if (!c.colors.some((col) => leader.colors.includes(col))) return false; }
    return true;
  });
  const grid = document.getElementById('card-grid');
  grid.innerHTML = '';
  gridRendered = 0;
  document.getElementById('grid-count').textContent = `${gridList.length} card${gridList.length === 1 ? '' : 's'}`;
  if (!gridList.length) { grid.innerHTML = `<p style="color:var(--paper-2)">No cards match those filters.</p>`; return; }
  appendGridChunk();
  const sentinel = document.createElement('div');
  sentinel.id = 'grid-sentinel';
  sentinel.style.cssText = 'grid-column: 1 / -1; height: 1px;';
  grid.appendChild(sentinel);
  if (gridObserver) gridObserver.disconnect();
  gridObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && gridRendered < gridList.length) { appendGridChunk(); grid.appendChild(sentinel); }
  }, { root: grid, rootMargin: '400px' });
  gridObserver.observe(sentinel);
}

function appendGridChunk() {
  const grid = document.getElementById('card-grid');
  const leader = deck.leaderId ? getCard(deck.leaderId) : null;
  const slice = gridList.slice(gridRendered, gridRendered + GRID_CHUNK);
  const html = slice.map((c) => {
    const count = deck.cards[c.id];
    const legal = c.type === 'Leader' || !leader || c.colors.some((col) => leader.colors.includes(col));
    return miniCardHtml(c, { count, extraClass: (!legal ? 'dim' : '') + (c.id === deck.leaderId ? ' selected' : '') });
  }).join('');
  const frag = document.createElement('template');
  frag.innerHTML = html;
  const sentinel = document.getElementById('grid-sentinel');
  if (sentinel) grid.insertBefore(frag.content, sentinel); else grid.appendChild(frag.content);
  gridRendered += slice.length;
}

function refreshGridBadges() {
  const leader = deck.leaderId ? getCard(deck.leaderId) : null;
  document.querySelectorAll('#card-grid .mini-card').forEach((el) => {
    const c = getCard(el.dataset.cardId);
    if (!c) return;
    const count = deck.cards[c.id];
    let badge = el.querySelector('.count-badge');
    if (count) { if (!badge) { badge = document.createElement('span'); badge.className = 'count-badge'; el.appendChild(badge); } badge.textContent = 'x' + count; }
    else if (badge) badge.remove();
    const legal = c.type === 'Leader' || !leader || c.colors.some((col) => leader.colors.includes(col));
    el.classList.toggle('dim', !legal);
    el.classList.toggle('selected', c.id === deck.leaderId);
  });
}

// ---------------------------------------------------------------------------------------
// the deck: side panel list + visual stacks + stats
// ---------------------------------------------------------------------------------------
function renderDeck() { renderDeckPanel(); renderDeckVisual(); renderStats(); }

function sortedDeckRows() {
  return Object.entries(deck.cards).sort((a, b) => {
    const ca = getCard(a[0]), cb = getCard(b[0]);
    const ta = ca.type === 'Character' ? 0 : ca.type === 'Event' ? 1 : 2, tb = cb.type === 'Character' ? 0 : cb.type === 'Event' ? 1 : 2;
    return (ca.cost ?? 0) - (cb.cost ?? 0) || ta - tb || ca.name.localeCompare(cb.name) || a[0].localeCompare(b[0]);
  });
}

function renderDeckPanel() {
  const leaderSlot = document.getElementById('leader-slot');
  const leader = deck.leaderId ? getCard(deck.leaderId) : null;
  leaderSlot.innerHTML = leader
    ? `<div data-card-id="${leader.id}">${cardImgHtml(leader)}</div>
       <div><b>${escapeHtml(leader.name)}</b><br><span style="color:var(--paper-2); font-size:0.8rem;">${leader.colors.join('/')} · Life ${leader.life} · ${leader.power} power${leader.variant ? ' · ' + escapeHtml(leader.variant) : ''}</span></div>`
    : `<div style="color:var(--paper-2); font-size:0.85rem;">No Leader chosen — click a Leader card in the search below.</div>`;

  const total = deckTotal();
  const countEl = document.getElementById('deck-count');
  countEl.textContent = `${total} / ${DECK_SIZE}`;
  countEl.className = 'deck-count' + (total > DECK_SIZE ? ' over' : total === DECK_SIZE ? ' full' : '');

  document.getElementById('deck-list').innerHTML = sortedDeckRows().map(([id, count]) => {
    const c = getCard(id);
    const alts = printingsOf(c.baseId || c.id).length;
    return `<div class="deck-list-row">
      <span class="dl-name"><span class="dl-cost">${c.cost ?? '-'}</span> ${escapeHtml(c.name)}${c.variant ? ` <span class="row-variant" title="${escapeHtml(c.variant)}">${escapeHtml(variantShort(c.variant))}</span>` : ''}${alts > 1 ? ` <button class="row-art" data-art="${id}" title="Choose artwork (${alts} versions)">🎨</button>` : ''}</span>
      <span class="qty-controls">
        <button data-dec="${id}">−</button>
        <b>${count}</b>
        <button data-inc="${id}">+</button>
      </span>
    </div>`;
  }).join('') || `<p style="color:var(--grey); font-size:0.85rem;">No cards yet — click cards in the search below to add them (right-click removes one).</p>`;

  document.getElementById('legal-errors').innerHTML = validateLocal().map((e) => `<div>⚠ ${escapeHtml(e)}</div>`).join('');
}

function renderDeckVisual() {
  const leader = deck.leaderId ? getCard(deck.leaderId) : null;
  const lv = document.getElementById('dv-leader');
  lv.innerHTML = leader
    ? `<div class="dv-leader-card ${cardColorClass(leader)}" data-card-id="${leader.id}" title="Click to choose this Leader's artwork">${cardImgHtml(leader)}<span class="dv-leader-tag">LEADER</span>${leader.variant ? `<span class="badge-variant">${escapeHtml(variantShort(leader.variant))}</span>` : ''}</div>
       <div class="dv-leader-name">${escapeHtml(leader.name)}<span>${leader.colors.join(' / ')} · Life ${leader.life} · ${leader.power}</span></div>`
    : `<div class="dv-leader-card empty"><span>Pick a<br>Leader</span></div><div class="dv-leader-name">No Leader yet<span>Click a Leader in the search below</span></div>`;

  const rows = sortedDeckRows();
  const wrap = document.getElementById('deck-visual');
  if (!rows.length) { wrap.innerHTML = `<div class="dv-empty">Your deck shows up here, laid out like on a table — click cards in the search below to add them.</div>`; return; }
  wrap.innerHTML = rows.map(([id, count]) => {
    const c = getCard(id);
    const alts = printingsOf(c.baseId || c.id).length;
    const layers = Array.from({ length: count }, (_, i) => `<div class="dv-card ${cardColorClass(c)}" style="--i:${i}">${cardImgHtml(c, 'loading="lazy"')}</div>`).join('');
    return `<div class="dv-stack" data-stack="${id}" data-card-id="${id}" style="--n:${count}" title="${escapeHtml(c.name)} ×${count}${alts > 1 ? ' — click to change artwork' : ''}">
      ${layers}
      <span class="dv-count">x${count}</span>
      <span class="badge-cost">${c.cost ?? (c.type === 'Leader' ? 'L' : '')}</span>
      ${c.variant ? `<span class="badge-variant">${escapeHtml(variantShort(c.variant))}</span>` : ''}
      <span class="dv-ctrls"><button data-dec="${id}" title="Remove one">−</button><button data-inc="${id}" title="Add one">+</button></span>
      <span class="dv-name">${escapeHtml(c.name)}</span>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------------------
// deck stats — everything here is computed from the actual cards in the deck.
// Draw odds are hypergeometric (no replacement) over the whole deck; turn structure is
// the official one: 5-card opening hand, the player going first skips their first draw
// and gets 1 DON!! on turn 1 (then 2 per turn, max 10); the player going second draws on
// turn 1 and gets 2 DON!! per turn. Mulligans and card effects are not modelled.
// ---------------------------------------------------------------------------------------
let statsGoingFirst = true;

// P(at least one of K "hits" among n cards drawn from a deck of N) = 1 − C(N−K, n) / C(N, n)
function pAtLeastOne(N, K, n) {
  if (K <= 0 || N <= 0 || n <= 0) return 0;
  if (K >= N) return 1;
  if (n >= N) return 1;
  let pNone = 1;
  for (let i = 0; i < n; i++) { const num = N - K - i, den = N - i; if (num <= 0) return 1; pNone *= num / den; }
  return 1 - pNone;
}
function turnPlan(goingFirst) {
  const rows = [];
  for (let t = 1; t <= 6; t++) {
    const don = goingFirst ? Math.min(10, 2 * t - 1) : Math.min(10, 2 * t);
    const seen = goingFirst ? 5 + (t - 1) : 5 + t;
    rows.push({ t, don, seen });
  }
  return rows;
}

function computeStats() {
  const leader = deck.leaderId ? getCard(deck.leaderId) : null;
  const cards = [];
  for (const [id, n] of Object.entries(deck.cards)) { const c = getCard(id); if (c) for (let i = 0; i < n; i++) cards.push(c); }
  const total = cards.length;
  const byType = { Character: 0, Event: 0, Stage: 0 };
  const costHist = new Array(11).fill(0);   // 0..9, 10+
  const powerHist = new Array(11).fill(0);  // 0,1k..9k,10k+ (Characters only)
  let costSum = 0, costN = 0, powerSum = 0, powerN = 0;
  const counter = { c1000: 0, c2000: 0, none: 0, events: 0, sum: 0 };
  const kw = {};
  const KW = ['Blocker', 'Trigger', 'Rush', 'On Play', 'When Attacking', 'On K.O.', 'Activate: Main', 'Double Attack', 'Banish', 'On Block', 'Your Turn', "Opponent's Turn", 'End of Your Turn', 'Counter'];
  const types = {}, attrs = {}, colors = {};
  for (const c of cards) {
    byType[c.type] = (byType[c.type] || 0) + 1;
    if (c.cost !== null && c.cost !== undefined) { costHist[Math.min(10, c.cost)]++; costSum += c.cost; costN++; }
    if (c.type === 'Character' && c.power !== null && c.power !== undefined) { powerHist[Math.min(10, Math.round(c.power / 1000))]++; powerSum += c.power; powerN++; }
    if (c.counter === 2000) { counter.c2000++; counter.sum += 2000; } else if (c.counter === 1000) { counter.c1000++; counter.sum += 1000; } else if (c.counter) { counter.sum += c.counter; } else counter.none++;
    if (c.type === 'Event' && /\[Counter\]/.test(c.text || '')) counter.events++;
    for (const k of KW) if ((c.text || '').includes(`[${k}]`)) kw[k] = (kw[k] || 0) + 1;
    for (const t of c.types || []) types[t] = (types[t] || 0) + 1;
    if (c.attribute) attrs[c.attribute] = (attrs[c.attribute] || 0) + 1;
    for (const col of c.colors || []) colors[col] = (colors[col] || 0) + 1;
  }
  const N = total; // odds are over the deck as it is right now (50 when legal)
  const curve = turnPlan(statsGoingFirst).map((r) => {
    const K = r.don >= 10 ? costHist[10] : (costHist[r.don] || 0);           // cost == DON!! that turn (10 DON!! → cost 10+)
    const Kplay = costHist.slice(0, Math.min(r.don, 9) + 1).reduce((a, b) => a + b, 0) + (r.don >= 10 ? costHist[10] : 0); // cost ≤ DON!!
    return Object.assign({}, r, { K, p: pAtLeastOne(N, K, r.seen), Kplay, pPlay: pAtLeastOne(N, Kplay, r.seen) });
  });
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  return { leader, total, byType, costHist, powerHist, avgCost: costN ? costSum / costN : 0, avgPower: powerN ? powerSum / powerN : 0, counter, kw: top(kw, 8), types: top(types, 6), attrs: top(attrs, 6), colors, curve };
}

function barChart(hist, labels, opts = {}) {
  const max = Math.max(1, ...hist);
  const W = 240, H = 78, pad = 2, bw = W / hist.length;
  const bars = hist.map((v, i) => {
    const h = v ? Math.max(3, (v / max) * (H - 22)) : 0;
    const x = i * bw + pad, y = H - 14 - h;
    return `<g class="bar"><rect x="${x}" y="${y}" width="${bw - pad * 2}" height="${h}" rx="3" class="${v ? 'on' : ''}"><title>${labels[i]}: ${v} card${v === 1 ? '' : 's'}</title></rect>${v ? `<text x="${x + (bw - pad * 2) / 2}" y="${y - 3}" text-anchor="middle" class="bar-val">${v}</text>` : ''}<text x="${x + (bw - pad * 2) / 2}" y="${H - 3}" text-anchor="middle" class="bar-lbl">${labels[i]}</text></g>`;
  }).join('');
  return `<svg class="mini-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.title || ''}">${bars}</svg>`;
}

function renderStats() {
  const s = computeStats();
  const box = document.getElementById('deck-stats');
  if (!s.total && !s.leader) { box.innerHTML = `<div class="ds-empty"><b>Deck stats</b><span>Cost curve, power curve, counters, keywords and turn-by-turn draw odds appear here as you build — all computed live from the cards you add.</span></div>`; return; }
  const chip = (label, val, cls = '') => `<span class="ds-chip ${cls}"><b>${val}</b>${label}</span>`;
  const colorDots = Object.entries(s.colors).sort((a, b) => b[1] - a[1]).map(([c, n]) => `<span class="ds-color color-${c}" title="${c}: ${n} cards">${n}</span>`).join('');
  const kwChips = s.kw.map(([k, n]) => `<span class="ds-kw kw-${k.replace(/[^A-Za-z]/g, '')}">${escapeHtml(k)} <b>${n}</b></span>`).join('') || '<span class="ds-muted">—</span>';
  const typeChips = s.types.map(([k, n]) => `<span class="ds-tag">${escapeHtml(k)} <b>${n}</b></span>`).join('') || '<span class="ds-muted">—</span>';
  const attrChips = s.attrs.map(([k, n]) => `<span class="ds-tag alt">${escapeHtml(k)} <b>${n}</b></span>`).join('');
  const avgCounter = s.total ? s.counter.sum / s.total : 0;
  const curveRows = s.curve.map((r) => `<tr><td>${r.t}</td><td>${r.don}</td><td>${r.seen}</td><td>${r.K}</td><td><span class="ds-p" style="--p:${Math.round(r.p * 100)}">${(r.p * 100).toFixed(0)}%</span></td><td><span class="ds-p soft" style="--p:${Math.round(r.pPlay * 100)}">${(r.pPlay * 100).toFixed(0)}%</span></td></tr>`).join('');
  box.innerHTML = `
    <div class="ds-row ds-top">
      <span class="ds-title">Deck stats</span>
      ${s.leader ? chip('life', s.leader.life) : ''}
      ${chip('cards', `${s.total}<small>/${DECK_SIZE}</small>`, s.total === DECK_SIZE ? 'ok' : s.total > DECK_SIZE ? 'bad' : '')}
      ${chip('char', s.byType.Character || 0)}${chip('event', s.byType.Event || 0)}${chip('stage', s.byType.Stage || 0)}
      ${chip('avg cost', s.avgCost.toFixed(1))}
      <span class="ds-colors">${colorDots}</span>
    </div>
    <div class="ds-row ds-charts">
      <div class="ds-chart"><div class="ds-chart-title">Cost curve</div>${barChart(s.costHist, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10+'], { title: 'Cost curve' })}</div>
      <div class="ds-chart"><div class="ds-chart-title">Power (Characters) <span>avg ${s.avgPower ? (s.avgPower / 1000).toFixed(1) + 'k' : '—'}</span></div>${barChart(s.powerHist, ['0', '1k', '2k', '3k', '4k', '5k', '6k', '7k', '8k', '9k', '10k+'], { title: 'Power curve' })}</div>
      <div class="ds-counter">
        <div class="ds-chart-title">Counters</div>
        <div class="ds-counter-big"><b>${s.total ? (avgCounter / 1000).toFixed(2) + 'k' : '—'}</b><span>avg / card</span></div>
        <div class="ds-counter-row"><span class="ds-tag c2">+2000 <b>${s.counter.c2000}</b></span><span class="ds-tag c1">+1000 <b>${s.counter.c1000}</b></span><span class="ds-tag">none <b>${s.counter.none}</b></span>${s.counter.events ? `<span class="ds-tag ev">[Counter] events <b>${s.counter.events}</b></span>` : ''}</div>
      </div>
    </div>
    <div class="ds-row ds-kws"><span class="ds-label">Keywords</span>${kwChips}</div>
    <div class="ds-row ds-kws"><span class="ds-label">Types</span>${typeChips}${attrChips ? `<span class="ds-sep"></span>${attrChips}` : ''}</div>
    <div class="ds-row ds-curve">
      <div class="ds-curve-head">
        <span class="ds-label">On-curve odds
          <span class="ds-info" tabindex="0">ⓘ<span class="ds-tip"><b>How this is calculated.</b> Cards seen = 5-card opening hand + 1 draw per turn (the player going first skips their first draw). DON!! = 1 on turn 1 going first, otherwise +2 per turn, max 10 (official turn structure). <b>On-curve</b> = number of cards in your deck whose cost equals that turn's DON!!. <b>P(≥1)</b> = chance at least one of them is among the cards you've seen: hypergeometric, 1 − C(N−K, n)/C(N, n) over your whole ${s.total}-card deck. <b>P(play)</b> = same, for any card costing ≤ that turn's DON!!. Mulligans, searches and draw effects aren't modelled — real odds are a bit better.</span></span>
        </span>
        <span class="ds-toggle"><button class="${statsGoingFirst ? 'on' : ''}" data-turnorder="first">Going 1st</button><button class="${!statsGoingFirst ? 'on' : ''}" data-turnorder="second">Going 2nd</button></span>
      </div>
      <table class="ds-table"><thead><tr><th>Turn</th><th>DON!!</th><th>Seen</th><th>On-curve</th><th>P(≥1)</th><th>P(play)</th></tr></thead><tbody>${curveRows}</tbody></table>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// artwork picker: every printing of one card
// ---------------------------------------------------------------------------------------
function openArtPicker(id) {
  const c = getCard(id);
  if (!c) return;
  const prints = printingsOf(c.baseId || c.id);
  if (prints.length < 2) { toast(`${c.name} only has one artwork in the card pool right now.`); return; }
  closeModal('art-modal');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop'; wrap.id = 'art-modal';
  wrap.innerHTML = `<div class="modal art-modal">
      <span class="close-x" data-close>✕</span>
      <h2>${escapeHtml(c.name)} <small>${escapeHtml(c.baseId || c.id)} · ${prints.length} artworks</small></h2>
      <p class="art-hint">Same card, different art — pick the one you own (or wish you did). Every copy in your deck switches to it.</p>
      <div class="art-grid">${prints.map((p) => `<div class="art-opt ${p.id === id ? 'current' : ''}" data-pick="${p.id}"><div class="mini-card ${cardColorClass(p)}">${cardImgHtml(p)}<span class="badge-variant">${p.variant ? escapeHtml(variantShort(p.variant)) : 'REGULAR'}</span></div><div class="art-label">${escapeHtml(p.variant || 'Regular art')}<span>${escapeHtml(p.id)}${p.printSet ? ' · ' + escapeHtml(p.printSet) : ''}${p.rarity ? ' · ' + escapeHtml(p.rarity) : ''}</span></div></div>`).join('')}</div>
    </div>`;
  document.body.appendChild(wrap);
  if (window.SFX) SFX.play('open');
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) { closeModal('art-modal'); return; }
    const opt = e.target.closest('[data-pick]');
    if (opt) { swapPrinting(id, opt.dataset.pick); closeModal('art-modal'); }
  });
}
function closeModal(id) { const m = document.getElementById(id); if (m) m.remove(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal('art-modal'); closeModal('import-modal'); } });

// ---------------------------------------------------------------------------------------
// deck list text: copy / import (OPTCGSim-style "4xOP01-016" lines; also "4 OP01-016",
// "OP01-016 x4", "4x OP01-016 Nami")
// ---------------------------------------------------------------------------------------
function deckListText() {
  const lines = [];
  if (deck.leaderId) lines.push(`1x${deck.leaderId}`);
  for (const [id, n] of sortedDeckRows()) lines.push(`${n}x${id}`);
  return lines.join('\n');
}
async function copyDeckList() {
  const text = deckListText();
  if (!text) { toast('Nothing to copy yet — add a Leader and some cards first.'); return; }
  try { await navigator.clipboard.writeText(text); toast('Deck list copied to clipboard!', 'ok'); }
  catch (e) { openImportModal(text); toast('Clipboard blocked by the browser — copy the text from the box.'); }
}
const LINE_RE_A = /^\s*(\d+)\s*[x×X]?\s*([A-Za-z]{1,4}\d{0,2}-\d{3}(?:_[A-Za-z]+\d+)?)/;
const LINE_RE_B = /^\s*([A-Za-z]{1,4}\d{0,2}-\d{3}(?:_[A-Za-z]+\d+)?)\s*[x×X]?\s*(\d+)?/;
function parseDeckList(text) {
  const counts = {}; let leaderId = null; const unknown = [];
  for (const raw of text.split(/\r?\n|,|;/)) {
    const line = raw.trim();
    if (!line || /^#|^\/\//.test(line)) continue;
    let n = 1, id = null, m;
    if ((m = LINE_RE_A.exec(line))) { n = parseInt(m[1], 10); id = m[2]; }
    else if ((m = LINE_RE_B.exec(line))) { id = m[1]; n = m[2] ? parseInt(m[2], 10) : 1; }
    if (!id) continue;
    id = id.toUpperCase().replace(/_([A-Z]+)(\d+)$/, (s, a, b) => '_' + a.toLowerCase() + b);
    let card = getCard(id);
    if (!card) { const alt = id.replace(/^([A-Z]+)(\d)-/, '$10$2-'); if (getCard(alt)) { id = alt; card = getCard(alt); } } // "ST1-001" → "ST01-001"
    if (!card) { unknown.push(id); continue; }
    if (card.type === 'Leader') { if (!leaderId) leaderId = id; continue; }
    counts[id] = (counts[id] || 0) + n;
  }
  return { counts, leaderId, unknown };
}
function openImportModal(prefill) {
  closeModal('import-modal');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop'; wrap.id = 'import-modal';
  wrap.innerHTML = `<div class="modal import-modal">
      <span class="close-x" data-close>✕</span>
      <h2>${prefill ? 'Deck list' : 'Import a deck list'}</h2>
      <p class="art-hint">${prefill ? 'Select all and copy.' : 'Paste a list — one card per line, like <code>4xOP01-016</code> (OPTCGSim format), <code>4 OP01-016</code> or <code>OP01-016 x4</code>. The Leader is picked up automatically. Alt-art codes like <code>OP01-024_p1</code> work too.'}</p>
      <textarea id="import-text" rows="12" spellcheck="false" placeholder="1xST01-001&#10;4xST01-002&#10;4xST01-003&#10;…">${prefill ? escapeHtml(prefill) : ''}</textarea>
      <div class="import-actions">${prefill ? '' : '<button class="btn gold" id="import-go">Import</button>'}<button class="btn secondary" data-close>Close</button></div>
      <div class="import-result" id="import-result"></div>
    </div>`;
  document.body.appendChild(wrap);
  const ta = document.getElementById('import-text');
  if (prefill) { ta.focus(); ta.select(); }
  else { ta.focus(); if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then((t) => { if (t && /[A-Za-z]{1,4}\d{0,2}-\d{3}/.test(t) && !ta.value) ta.value = t; }).catch(() => {}); }
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) closeModal('import-modal'); });
  const go = document.getElementById('import-go');
  if (go) go.onclick = () => {
    const { counts, leaderId, unknown } = parseDeckList(ta.value);
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!n && !leaderId) { document.getElementById('import-result').innerHTML = `<div class="err">Couldn't find any card codes in that text.</div>`; return; }
    deck.cards = counts; if (leaderId) deck.leaderId = leaderId;
    currentDeckId = null; document.getElementById('my-decks-select').value = ''; document.getElementById('delete-deck-btn').style.display = 'none';
    renderDeck(); renderGrid();
    closeModal('import-modal');
    toast(`Imported ${n} cards${leaderId ? ' + Leader' : ''}${unknown.length ? ` — ${unknown.length} unknown code${unknown.length === 1 ? '' : 's'} skipped (${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? '…' : ''})` : ''}.`, unknown.length ? 'warn' : 'ok');
  };
}

// ---------------------------------------------------------------------------------------
// validate / save / load
// ---------------------------------------------------------------------------------------
function validateLocal() {
  const errors = [];
  const leader = deck.leaderId ? getCard(deck.leaderId) : null;
  if (!leader) errors.push('Choose a Leader.');
  const perBase = new Map();
  for (const [id, count] of Object.entries(deck.cards)) {
    const c = getCard(id);
    if (!c) { errors.push(`Unknown card ${id}.`); continue; }
    const b = baseOf(id);
    perBase.set(b, (perBase.get(b) || 0) + count);
    if (leader && !c.colors.some((col) => leader.colors.includes(col))) errors.push(`${c.name} doesn't match your Leader's color.`);
  }
  for (const [b, n] of perBase) {
    if (n > MAX_COPIES) { const c = getCard(b) || getCard(Object.keys(deck.cards).find((id) => baseOf(id) === b)); errors.push(`${c ? c.name : b} (${b}): max ${MAX_COPIES} copies counting all art versions (has ${n}).`); }
  }
  const total = deckTotal();
  if (total !== DECK_SIZE) errors.push(`Deck must have exactly ${DECK_SIZE} cards (currently ${total}).`);
  return errors;
}

function suggestDeckName() {
  const l = deck.leaderId ? getCard(deck.leaderId) : null;
  return l ? `${l.colors.join('/')} ${l.name}` : 'My Deck';
}

async function saveDeck() {
  const errors = validateLocal();
  if (errors.length) { toast('Fix deck issues before saving: ' + errors[0]); return; }
  let name = (document.getElementById('deck-name').value || '').trim();
  if (!name || /^new deck$/i.test(name)) {
    const typed = window.prompt('Name your deck:', suggestDeckName());
    if (typed === null) return;
    name = typed.trim() || suggestDeckName();
    document.getElementById('deck-name').value = name;
  }
  deck.name = name;
  await requireUser();
  try {
    if (currentDeckId) {
      await API.put(`/api/decks/${currentDeckId}`, { name: deck.name, leaderId: deck.leaderId, cards: deck.cards });
    } else {
      const { id } = await API.post('/api/decks', { name: deck.name, leaderId: deck.leaderId, cards: deck.cards });
      currentDeckId = id;
    }
    toast(`"${deck.name}" saved!`, 'ok');
    await refreshMyDecks();
    document.getElementById('my-decks-select').value = currentDeckId;
    document.getElementById('delete-deck-btn').style.display = '';
  } catch (e) {
    toast(e.data && e.data.details ? e.data.details[0] : e.message);
  }
}

async function deleteCurrentDeck() {
  if (!currentDeckId) return;
  if (!confirm(`Delete "${deck.name || 'this deck'}"?`)) return;
  await API.del(`/api/decks/${currentDeckId}`);
  currentDeckId = null;
  deck = { name: '', leaderId: null, cards: {} };
  document.getElementById('deck-name').value = '';
  document.getElementById('delete-deck-btn').style.display = 'none';
  await refreshMyDecks();
  renderDeck(); renderGrid();
}

async function refreshMyDecks() {
  const sel = document.getElementById('my-decks-select');
  sel.innerHTML = '<option value="">My decks…</option>';
  if (!CURRENT_USER) return;
  const { decks } = await API.get('/api/decks');
  for (const d of decks) {
    const opt = document.createElement('option');
    opt.value = d.id; opt.textContent = `${d.name} (${getCard(d.leaderId) ? getCard(d.leaderId).name : d.leaderId})`;
    sel.appendChild(opt);
  }
}

async function loadDeckIntoBuilder(id) {
  const d = await API.get(`/api/decks/${id}`);
  deck = { name: d.name, leaderId: d.leaderId, cards: d.cards };
  currentDeckId = d.id;
  document.getElementById('deck-name').value = deck.name;
  document.getElementById('delete-deck-btn').style.display = '';
  renderDeck(); renderGrid();
}

init();
