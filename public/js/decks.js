let ALL_CARDS = [];
let BY_ID = new Map();
let deck = { name: 'New Deck', leaderId: null, cards: {} };
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
  renderDeckPanel();
  wireUi();
}

function getCard(id) { return BY_ID.get(id); }

async function populateStarters() {
  const sel = document.getElementById('starter-select');
  try {
    const { decks } = await API.get('/api/starter-decks');
    for (const d of decks) {
      const opt = document.createElement('option');
      opt.value = d.id; opt.textContent = d.name;
      sel.appendChild(opt);
    }
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
    renderDeckPanel(); renderGrid();
    toast('Starter deck loaded — tweak it and hit Save to keep your own copy.', 'ok');
  });
}

function populateSetFilter() {
  const sets = [...new Set(ALL_CARDS.map((c) => c.set))].sort();
  const sel = document.getElementById('filter-set');
  for (const s of sets) {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    sel.appendChild(opt);
  }
}

function wireUi() {
  ['search', 'filter-leader-color', 'filter-type', 'filter-cost', 'filter-set'].forEach((id) => {
    document.getElementById(id).addEventListener('input', renderGrid);
    document.getElementById(id).addEventListener('change', renderGrid);
  });
  document.getElementById('deck-name').addEventListener('input', (e) => { deck.name = e.target.value; });
  document.getElementById('new-deck-btn').onclick = () => {
    deck = { name: 'New Deck', leaderId: null, cards: {} };
    currentDeckId = null;
    document.getElementById('deck-name').value = deck.name;
    document.getElementById('my-decks-select').value = '';
    document.getElementById('delete-deck-btn').style.display = 'none';
    renderDeckPanel(); renderGrid();
  };
  document.getElementById('clear-deck-btn').onclick = () => {
    deck.cards = {};
    renderDeckPanel(); renderGrid();
  };
  document.getElementById('save-deck-btn').onclick = saveDeck;
  document.getElementById('delete-deck-btn').onclick = deleteCurrentDeck;
  document.getElementById('my-decks-select').addEventListener('change', (e) => {
    const id = e.target.value;
    if (!id) return;
    loadDeckIntoBuilder(id);
  });

  const grid = document.getElementById('card-grid');
  attachCardTooltips(grid, getCard);
  grid.addEventListener('click', (e) => {
    const el = e.target.closest('[data-card-id]');
    if (!el) return;
    onCardClick(el.dataset.cardId);
  });
  const deckList = document.getElementById('deck-list');
  deckList.addEventListener('click', (e) => {
    const dec = e.target.closest('[data-dec]');
    const inc = e.target.closest('[data-inc]');
    if (dec) changeCount(dec.dataset.dec, -1);
    if (inc) changeCount(inc.dataset.inc, 1);
  });
}

function onCardClick(id) {
  const card = getCard(id);
  if (!card) return;
  if (card.type === 'Leader') {
    if (window.SFX) SFX.play('flip');
    deck.leaderId = id;
    // drop now-illegal cards
    for (const cid of Object.keys(deck.cards)) {
      const c = getCard(cid);
      if (!c.colors.some((col) => card.colors.includes(col))) delete deck.cards[cid];
    }
    renderDeckPanel(); renderGrid();
    return;
  }
  changeCount(id, 1);
}

function changeCount(id, delta) {
  const current = deck.cards[id] || 0;
  const next = Math.max(0, Math.min(MAX_COPIES, current + delta));
  if (window.SFX) SFX.play(next > current ? 'place' : next < current ? 'trash' : 'error');
  if (next === 0) delete deck.cards[id]; else deck.cards[id] = next;
  renderDeckPanel(); refreshGridBadges();
}

function deckTotal() { return Object.values(deck.cards).reduce((a, b) => a + b, 0); }

let gridList = [];       // full filtered list
let gridRendered = 0;    // how many are in the DOM so far
const GRID_CHUNK = 120;
let gridObserver = null;

function renderGrid() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  const colorFilter = document.getElementById('filter-leader-color').value;
  const typeFilter = document.getElementById('filter-type').value;
  const costFilter = document.getElementById('filter-cost').value;
  const setFilter = document.getElementById('filter-set').value;
  const leader = deck.leaderId ? getCard(deck.leaderId) : null;

  gridList = ALL_CARDS.filter((c) => {
    if (q && !(c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) || (c.text || '').toLowerCase().includes(q) || (c.types || []).some((t) => t.toLowerCase().includes(q)))) return false;
    if (typeFilter && c.type !== typeFilter) return false;
    if (setFilter && c.set !== setFilter) return false;
    if (costFilter) {
      const cost = c.cost ?? -1;
      if (costFilter === '8') { if (cost < 8) return false; } else if (cost !== parseInt(costFilter, 10)) return false;
    }
    if (colorFilter !== 'all' && leader && c.type !== 'Leader') {
      if (!c.colors.some((col) => leader.colors.includes(col))) return false;
    }
    return true;
  });
  const grid = document.getElementById('card-grid');
  grid.innerHTML = '';
  gridRendered = 0;
  document.getElementById('grid-count').textContent = `${gridList.length} card${gridList.length === 1 ? '' : 's'}`;
  if (!gridList.length) { grid.innerHTML = `<p style="color:var(--paper-2)">No cards match those filters.</p>`; return; }
  appendGridChunk();
  // sentinel: when it scrolls into view, render the next chunk (so ALL cards are reachable)
  const sentinel = document.createElement('div');
  sentinel.id = 'grid-sentinel';
  sentinel.style.cssText = 'grid-column: 1 / -1; height: 1px;';
  grid.appendChild(sentinel);
  if (gridObserver) gridObserver.disconnect();
  gridObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && gridRendered < gridList.length) {
      appendGridChunk();
      grid.appendChild(sentinel); // keep sentinel last
    }
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

// Refresh only the count badges / dim state of already-rendered cards (cheap; keeps scroll position).
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

function renderDeckPanel() {
  const leaderSlot = document.getElementById('leader-slot');
  const leader = deck.leaderId ? getCard(deck.leaderId) : null;
  leaderSlot.innerHTML = leader
    ? `<img src="${cardImgUrl(leader)}" onerror="this.style.display='none'" />
       <div><b>${escapeHtml(leader.name)}</b><br><span style="color:var(--paper-2); font-size:0.8rem;">${leader.colors.join('/')} · Life ${leader.life} · ${leader.power} power</span></div>`
    : `<div style="color:var(--paper-2); font-size:0.85rem;">No Leader chosen — click a Leader card on the left.</div>`;

  const total = deckTotal();
  const countEl = document.getElementById('deck-count');
  countEl.textContent = `${total} / ${DECK_SIZE}`;
  countEl.className = 'deck-count' + (total > DECK_SIZE ? ' over' : '');

  const rows = Object.entries(deck.cards).sort((a, b) => {
    const ca = getCard(a[0]), cb = getCard(b[0]);
    return (ca.cost ?? 0) - (cb.cost ?? 0) || ca.name.localeCompare(cb.name);
  });
  document.getElementById('deck-list').innerHTML = rows.map(([id, count]) => {
    const c = getCard(id);
    return `<div class="deck-list-row">
      <span>${escapeHtml(c.name)} <span style="color:var(--grey)">(${c.cost ?? '-'})</span></span>
      <span class="qty-controls">
        <button data-dec="${id}">−</button>
        <b>${count}</b>
        <button data-inc="${id}">+</button>
      </span>
    </div>`;
  }).join('') || `<p style="color:var(--grey); font-size:0.85rem;">No cards yet — click cards on the left to add them.</p>`;

  document.getElementById('legal-errors').innerHTML = validateLocal().map((e) => `<div>⚠ ${escapeHtml(e)}</div>`).join('');
}

function validateLocal() {
  const errors = [];
  const leader = deck.leaderId ? getCard(deck.leaderId) : null;
  if (!leader) errors.push('Choose a Leader.');
  for (const [id, count] of Object.entries(deck.cards)) {
    const c = getCard(id);
    if (count > MAX_COPIES) errors.push(`${c.name}: max ${MAX_COPIES} copies.`);
    if (leader && !c.colors.some((col) => leader.colors.includes(col))) errors.push(`${c.name} doesn't match your Leader's color.`);
  }
  const total = deckTotal();
  if (total !== DECK_SIZE) errors.push(`Deck must have exactly ${DECK_SIZE} cards (currently ${total}).`);
  return errors;
}

async function saveDeck() {
  const errors = validateLocal();
  if (errors.length) { toast('Fix deck issues before saving: ' + errors[0]); return; }
  const user = await requireUser();
  try {
    if (currentDeckId) {
      await API.put(`/api/decks/${currentDeckId}`, { name: deck.name, leaderId: deck.leaderId, cards: deck.cards });
    } else {
      const { id } = await API.post('/api/decks', { name: deck.name, leaderId: deck.leaderId, cards: deck.cards });
      currentDeckId = id;
    }
    toast('Deck saved!', 'ok');
    await refreshMyDecks();
    document.getElementById('my-decks-select').value = currentDeckId;
    document.getElementById('delete-deck-btn').style.display = '';
  } catch (e) {
    toast(e.data && e.data.details ? e.data.details[0] : e.message);
  }
}

async function deleteCurrentDeck() {
  if (!currentDeckId) return;
  if (!confirm('Delete this deck?')) return;
  await API.del(`/api/decks/${currentDeckId}`);
  currentDeckId = null;
  deck = { name: 'New Deck', leaderId: null, cards: {} };
  document.getElementById('deck-name').value = deck.name;
  document.getElementById('delete-deck-btn').style.display = 'none';
  await refreshMyDecks();
  renderDeckPanel(); renderGrid();
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
  renderDeckPanel(); renderGrid();
}

init();
