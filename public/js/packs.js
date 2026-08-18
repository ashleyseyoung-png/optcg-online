// Rip Packs — pick a set, tear a pack, flip the cards, bank the hits.
let ALL_CARDS = [], BY_ID = new Map(), SETS = [], MODEL = null;
let selectedSet = null, qty = 1;
let queue = [];         // packs still to open in this session (arrays of {id, tier, hit})
let sessionPacks = [];  // everything opened this session (for the results screen)
let current = null;     // the pack being revealed
let flipped = 0, flipping = false, autoTimer = null, saved = false;

const TIER_LABEL = { C: 'Common', UC: 'Uncommon', R: 'Rare', L: 'Leader', SR: 'Super Rare', SEC: 'Secret Rare', parallel: 'Alternate Art', manga: 'Manga Rare', sp: 'Special Rare (SP)', tr: 'Treasure Rare' };
const TIER_LEVEL = { C: 0, UC: 0, R: 1, L: 1, SR: 2, parallel: 3, sp: 3, tr: 4, SEC: 4, manga: 5 };
function getCard(id) { return BY_ID.get(id); }

async function init() {
  const [{ cards }, setsResp] = await Promise.all([API.get('/api/cards'), API.get('/api/packs/sets')]);
  ALL_CARDS = cards; BY_ID = new Map(cards.map((c) => [c.id, c]));
  SETS = setsResp.sets; MODEL = setsResp.model;
  await loadUser();
  renderSets();
  renderStats();
  wire();
  loadRecent();
  const pre = new URLSearchParams(location.search).get('set');
  if (pre && SETS.some((s) => s.set === pre.toUpperCase())) chooseSet(pre.toUpperCase());
}

// ---------------------------------------------------------------------------------------
// stage 1: sets
// ---------------------------------------------------------------------------------------
function renderSets() {
  const grid = document.getElementById('set-grid');
  grid.innerHTML = SETS.map((s) => {
    const cover = getCard(s.cover);
    const c = s.counts;
    return `<div class="set-tile" data-set="${s.set}">
      <div class="set-cover">${cover ? cardImgHtml(cover, 'loading="lazy"') : ''}<span class="set-code">${s.set.replace(/^(OP|EB)(\d\d)$/, '$1-$2')}</span></div>
      <div class="set-info">
        <div class="set-name">${escapeHtml(s.name)}</div>
        <div class="set-rar"><span>${c.C} C</span>${c.UC ? `<span>${c.UC} UC</span>` : ''}<span>${c.R} R</span><span class="sr">${c.SR} SR</span><span class="sec">${c.SEC} SEC</span><span class="l">${c.L} L</span>${c.parallel ? `<span class="alt">${c.parallel} alt</span>` : ''}${c.manga ? `<span class="manga">${c.manga} manga</span>` : ''}${c.tr ? `<span class="tr">${c.tr} TR</span>` : ''}</div>
        <div class="set-you">${s.opened ? `You've opened <b>${s.opened}</b> pack${s.opened === 1 ? '' : 's'} · <b>${s.hits}</b> hit${s.hits === 1 ? '' : 's'}` : 'Not opened yet'}</div>
      </div>
      <button class="btn small gold">Open packs</button>
    </div>`;
  }).join('');
  grid.querySelectorAll('.set-tile').forEach((t) => { t.onclick = () => chooseSet(t.dataset.set); });
}
function renderStats() {
  const packs = SETS.reduce((a, s) => a + s.opened, 0), hits = SETS.reduce((a, s) => a + s.hits, 0);
  document.getElementById('packs-stats').innerHTML = packs ? `<span class="ds-chip"><b>${packs}</b>packs ripped</span><span class="ds-chip"><b>${hits}</b>hits</span><a class="btn small secondary" href="/collection.html">My collection →</a>` : `<span class="ds-muted">Your rip stats show up here.</span>`;
}

function wire() {
  document.getElementById('back-to-sets').onclick = () => { stopAuto(); showStage('sets'); };
  document.querySelectorAll('.qty-chip').forEach((b) => { b.onclick = () => { qty = Number(b.dataset.qty); document.querySelectorAll('.qty-chip').forEach((x) => x.classList.toggle('on', x === b)); }; });
  document.getElementById('rip-btn').onclick = rip;
  document.getElementById('reveal-btn').onclick = () => reveal();
  document.getElementById('reveal-all-btn').onclick = revealAll;
  document.getElementById('auto-flip').onchange = (e) => { if (e.target.checked) startAuto(); else stopAuto(); };
  document.getElementById('odds-link').onclick = openOddsModal;
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (document.getElementById('card-modal')) return; // the big viewer has its own keys
    if (document.getElementById('stage-open').style.display === 'none') return;
    const packVisible = document.getElementById('pack-stage').style.display !== 'none';
    if (e.key === ' ') { e.preventDefault(); if (packVisible) rip(); else reveal(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (packVisible) rip(); else revealAll(); }
    else if (e.key === 'Escape') { const m = document.getElementById('results-modal') || document.getElementById('odds-modal'); if (m) m.remove(); }
  });
  // click a card anywhere on this page → big viewer
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-card-id]');
    if (!el || el.closest('#card-modal')) return;
    if (el.classList.contains('scard') && !el.classList.contains('up')) return; // face-down: not yet
    if (el.classList.contains('scard') && el.classList.contains('top') && !el.classList.contains('swiped')) return; // top of stack: press reveals
    const card = getCard(el.dataset.cardId);
    if (!card) return;
    const listEl = el.closest('[data-card-list]');
    if (listEl) {
      const items = [...listEl.querySelectorAll('[data-card-id]')].filter((x) => !x.classList.contains('scard') || x.classList.contains('up')).map((x) => ({ id: x.dataset.cardId, tier: x.dataset.tier || null }));
      const index = items.findIndex((x) => x.id === card.id);
      openCardModal(card, { list: items, index: Math.max(0, index), getCard });
      if (el.dataset.tier) _cardModalState.tierClass = 'tier-' + el.dataset.tier;
      renderCardModal(card);
    } else openCardModal(card, { getCard });
  });
  // tilt the pack with the mouse (little bit of physicality)
  const pack = document.getElementById('pack');
  const stage = document.getElementById('pack-stage');
  stage.addEventListener('pointermove', (e) => {
    if (pack.classList.contains('ripping')) return;
    const r = pack.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / r.width, dy = (e.clientY - (r.top + r.height / 2)) / r.height;
    pack.style.setProperty('--tx', `${(-dy * 14).toFixed(2)}deg`); pack.style.setProperty('--ty', `${(dx * 18).toFixed(2)}deg`);
    pack.style.setProperty('--gx', `${(50 + dx * 60).toFixed(1)}%`);
  });
  stage.addEventListener('pointerleave', () => { pack.style.setProperty('--tx', '0deg'); pack.style.setProperty('--ty', '0deg'); });
}
function showStage(which) {
  document.getElementById('stage-sets').style.display = which === 'sets' ? '' : 'none';
  document.getElementById('stage-open').style.display = which === 'open' ? '' : 'none';
  if (which === 'sets') { if (window.BGM) BGM.duck(false); renderSets(); renderStats(); }
}

// ---------------------------------------------------------------------------------------
// stage 2: the pack
// ---------------------------------------------------------------------------------------
function chooseSet(code) {
  selectedSet = SETS.find((s) => s.set === code);
  if (!selectedSet) return;
  queue = []; sessionPacks = []; current = null;
  showStage('open');
  const cover = getCard(selectedSet.cover);
  document.getElementById('open-title').innerHTML = `<b>${escapeHtml(selectedSet.name)}</b> <span>${selectedSet.set.replace(/^(OP|EB)(\d\d)$/, '$1-$2')} · ${selectedSet.total} cards in set</span>`;
  document.getElementById('pack-set-name').textContent = selectedSet.name;
  document.getElementById('pack-set-code').textContent = selectedSet.set.replace(/^(OP|EB)(\d\d)$/, '$1-$2');
  document.getElementById('pack-art').innerHTML = cover ? cardImgHtml(cover) : '';
  const col = cover && cover.colors && cover.colors[0] ? cover.colors[0] : 'Red';
  const pack = document.getElementById('pack');
  pack.dataset.color = col;
  // official pack photo (relayed by our server) — the foil design is the fallback
  pack.classList.remove('has-photo');
  const top = document.getElementById('pack-photo-top'), body = document.getElementById('pack-photo-body');
  top.removeAttribute('src'); body.removeAttribute('src');
  if (selectedSet.packImage) {
    let done = false;
    body.onload = () => { if (!done) { done = true; top.src = body.src; pack.classList.add('has-photo'); } };
    body.onerror = () => { pack.classList.remove('has-photo'); };
    body.src = selectedSet.packImage;
  }
  resetPackVisual();
  document.getElementById('open-qty').style.display = '';
  document.getElementById('rip-btn').textContent = 'Rip it open!';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function resetPackVisual() {
  const pack = document.getElementById('pack');
  pack.classList.remove('grab', 'tearing', 'torn', 'cards-out', 'gone', 'ripping');
  document.getElementById('pack-stage').style.display = '';
  document.getElementById('reveal-stage').style.display = 'none';
  document.getElementById('pack-summary').style.display = 'none';
  document.getElementById('pack-grid').style.display = 'none';
  document.getElementById('stack').innerHTML = '';
  document.getElementById('rip-btn').disabled = false;
}

async function rip() {
  if (!selectedSet || flipping) return;
  const btn = document.getElementById('rip-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  if (!queue.length) {
    try {
      const resp = await API.post('/api/packs/open', { set: selectedSet.set, count: qty });
      queue = resp.packs; saved = resp.saved; sessionPacks = [];
      if (!saved) toast('Heads up: you’re not signed in, so these pulls won’t be saved to a collection.', 'warn');
    } catch (e) { toast(e.message || 'Could not open packs'); btn.disabled = false; return; }
    document.getElementById('open-qty').style.display = 'none';
  }
  current = queue.shift();
  sessionPacks.push(current);
  flipped = 0; revealedUp = -1;
  if (window.BGM) BGM.duck(true);
  await ripAnimation();
  showStack();
}
// the rip: grab → tear runs across the top → the strip peels off → cards rise out → pack drops away
async function ripAnimation() {
  const pack = document.getElementById('pack');
  pack.classList.add('ripping', 'grab'); PackFX.play('shake');
  await sleep(380);
  pack.classList.add('tearing'); PackFX.play('tear');
  await sleep(620);
  pack.classList.add('torn'); PackFX.play('slide');
  await sleep(520);
  pack.classList.add('cards-out');
  await sleep(700);
  pack.classList.add('gone');
  await sleep(320);
  document.getElementById('pack-stage').style.display = 'none';
}

// ---------------------------------------------------------------------------------------
// the stack: one pile, face-down. Reveal = flip the top card; next Reveal swipes it right
// and flips the next one. The last card gets the build-up.
// ---------------------------------------------------------------------------------------
let revealedUp = -1; // index of the card currently face-up on top (-1 = none yet)
function showStack() {
  const stage = document.getElementById('reveal-stage');
  stage.style.display = '';
  document.getElementById('pack-summary').style.display = 'none';
  document.getElementById('pack-grid').style.display = 'none';
  const stack = document.getElementById('stack');
  const n = current.length;
  stack.innerHTML = current.map((c, i) => {
    const card = getCard(c.id);
    const jitter = ((i * 37) % 7) - 3; // deterministic tiny rotation so the pile looks real
    return `<div class="scard tier-${c.tier} ${i === 0 ? 'top' : ''}" data-idx="${i}" data-card-id="${c.id}" data-tier="${c.tier}" style="--z:${n - i}; --lift:${(n - 1 - i) * 0.9}px; --j:${jitter * 0.4}deg; --i:${i}">
      <div class="scard-inner">
        <div class="face back"><img src="/img/cardback.svg" alt="" draggable="false" /></div>
        <div class="face front">${card ? cardImgHtml(card) : '<div class="fallback">?</div>'}<span class="tier-tag">${TIER_LABEL[c.tier] || c.tier}</span></div>
      </div>
    </div>`;
  }).join('');
  stack.dataset.cardList = '1';
  document.getElementById('pile-label').textContent = '';
  updateProgress();
  const btn = document.getElementById('reveal-btn');
  btn.disabled = false; btn.textContent = 'Reveal (Space)';
  if (document.getElementById('auto-flip').checked) startAuto();
}
function updateProgress() {
  const left = queue.length;
  document.getElementById('reveal-progress').innerHTML = `<span>Pack ${sessionPacks.length}${sessionPacks.length + left > 1 ? ` of ${sessionPacks.length + left}` : ''}</span><span class="dots">${current.map((c, i) => `<i class="${i < flipped ? 'on tier-' + c.tier : ''}"></i>`).join('')}</span><span>${flipped}/${current.length} revealed</span>`;
}

// One press: swipe the face-up card off to the right (if any), then flip the next one.
async function reveal() {
  if (!current || flipping) return;
  const n = current.length;
  if (revealedUp >= n - 1 && flipped >= n) { await finishPack(); return; }
  flipping = true;
  const btn = document.getElementById('reveal-btn'); btn.disabled = true;
  // 1) swipe the current face-up card to the pile
  if (revealedUp >= 0) {
    const cur = document.querySelector(`.scard[data-idx="${revealedUp}"]`);
    if (cur) { cur.classList.remove('top'); cur.classList.add('swiped'); cur.style.setProperty('--px', `${revealedUp * 9}px`); cur.style.setProperty('--py', `${(revealedUp % 3) * 4}px`); cur.style.setProperty('--r', `${((revealedUp * 53) % 17) - 8}deg`); }
    PackFX.play('slide');
    await sleep(revealedUp === n - 1 ? 350 : 220);
    document.getElementById('pile-label').textContent = `${revealedUp + 1} card${revealedUp === 0 ? '' : 's'} on the pile`;
  }
  // 2) flip the next card
  const idx = revealedUp + 1;
  const el = document.querySelector(`.scard[data-idx="${idx}"]`);
  const c = current[idx];
  el.classList.add('top');
  const isLast = idx === n - 1;
  const level = TIER_LEVEL[c.tier] || 0;
  if (isLast) { el.classList.add('charging'); PackFX.play('riser', 1.5); await sleep(1500); el.classList.remove('charging'); }
  else if (level >= 2) { el.classList.add('charging'); PackFX.play('riser', 0.9); await sleep(900); el.classList.remove('charging'); }
  el.classList.add('up');
  if (isLast && level <= 1 && c.tier !== 'L') PackFX.play('womp'); else PackFX.play('flip', c.tier);
  if (level >= 2) hitEffects(el, c.tier, level);
  revealedUp = idx; flipped = idx + 1;
  updateProgress();
  await sleep(level >= 3 ? 700 : 300);
  flipping = false;
  btn.disabled = false;
  btn.textContent = flipped >= n ? 'Done — see the pack (Space)' : 'Reveal (Space)';
  if (flipped >= n && document.getElementById('auto-flip').checked) { setTimeout(() => { if (!flipping) finishPack(); }, 900); }
}
async function revealAll() {
  stopAuto();
  while (current && flipped < current.length) { await reveal(); }
  await finishPack();
}
function startAuto() { stopAuto(); autoTimer = setInterval(() => { if (!flipping && current && flipped < current.length) reveal(); }, 900); }
function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }

// after the last card: swipe it, lay all 12 out (clickable), show the summary
async function finishPack() {
  if (!current || flipping) return;
  flipping = true;
  stopAuto();
  const last = document.querySelector(`.scard[data-idx="${current.length - 1}"]`);
  if (last && !last.classList.contains('swiped')) { last.classList.remove('top'); last.classList.add('swiped'); last.style.setProperty('--px', `${(current.length - 1) * 9}px`); PackFX.play('slide'); await sleep(350); }
  document.getElementById('stack-area').style.display = 'none';
  const grid = document.getElementById('pack-grid');
  grid.style.display = '';
  grid.dataset.cardList = '1';
  grid.innerHTML = current.map((c, i) => { const card = getCard(c.id); return `<div class="pcard tier-${c.tier}" data-card-id="${c.id}" data-tier="${c.tier}" style="--i:${i}" title="Click to view">${card ? cardImgHtml(card) : ''}<span class="tier-tag">${TIER_LABEL[c.tier] || c.tier}</span></div>`; }).join('');
  flipping = false;
  packDone();
}

function hitEffects(el, tier, level) {
  confetti(el, level, tier);
  if (level >= 3) flash(tier);
  el.classList.add('hit-pop');
  setTimeout(() => el.classList.remove('hit-pop'), 900);
}
const TIER_COLORS = { SR: ['#ffd166', '#fff3b0', '#ff9f43'], parallel: ['#6fc3ff', '#b58cff', '#ffffff'], sp: ['#6fc3ff', '#b58cff', '#ffffff'], SEC: ['#ff6fae', '#ffd166', '#ffffff'], tr: ['#ffd166', '#5ad07f', '#ffffff'], manga: ['#ffffff', '#ff6fae', '#ffd166', '#6fc3ff', '#b6f36b'] };
function confetti(el, level, tier) {
  const layer = document.getElementById('fx-layer');
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const n = 18 + level * 16;
  const cols = TIER_COLORS[tier] || ['#ffd166', '#b6f36b', '#6fc3ff'];
  for (let i = 0; i < n; i++) {
    const s = document.createElement('i');
    const ang = Math.random() * Math.PI * 2, dist = 80 + Math.random() * (140 + level * 40);
    s.style.cssText = `left:${cx}px; top:${cy}px; --dx:${Math.cos(ang) * dist}px; --dy:${Math.sin(ang) * dist - 60}px; --rot:${Math.random() * 720 - 360}deg; background:${cols[i % cols.length]}; width:${6 + Math.random() * 8}px; height:${6 + Math.random() * 10}px; animation-duration:${0.9 + Math.random() * 0.7}s;`;
    layer.appendChild(s);
    setTimeout(() => s.remove(), 1800);
  }
}
function flash(tier) {
  const f = document.getElementById('flash-layer');
  f.style.background = tier === 'manga' ? 'radial-gradient(circle, #fff, #ff6fae 60%, transparent 70%)' : tier === 'SEC' || tier === 'tr' ? 'radial-gradient(circle, #fff, #ffd166 60%, transparent 70%)' : 'radial-gradient(circle, #fff, #6fc3ff 60%, transparent 70%)';
  f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
}

function packDone() {
  stopAuto();
  const hits = current.filter((c) => c.hit);
  const best = current[current.length - 1];
  const sum = document.getElementById('pack-summary');
  sum.style.display = '';
  const left = queue.length;
  sum.innerHTML = `
    <div class="ps-line">${hits.length ? `<b>${hits.length} hit${hits.length === 1 ? '' : 's'}!</b> ${hits.map((h) => `<span class="ps-hit tier-${h.tier}">${escapeHtml(getCard(h.id) ? getCard(h.id).name : h.id)} · ${TIER_LABEL[h.tier]}</span>`).join('')}` : `<b>No hits this time</b> — best card: ${escapeHtml(getCard(best.id) ? getCard(best.id).name : best.id)} (${TIER_LABEL[best.tier]}).`}${saved ? '' : ' <span class="ds-muted">(not saved — sign in to keep pulls)</span>'}</div>
    <div class="ps-actions">
      ${left ? `<button class="btn gold" id="next-pack-btn">Next pack (${left} left) →</button><button class="btn small secondary" id="rip-rest-btn">Rip the rest quickly</button>` : `<button class="btn gold" id="again-btn">Open more ${escapeHtml(selectedSet.name)}</button>`}
      ${sessionPacks.length > 1 || left === 0 ? `<button class="btn small secondary" id="results-btn">Session results (${sessionPacks.length} pack${sessionPacks.length === 1 ? '' : 's'})</button>` : ''}
      <a class="btn small secondary" href="/collection.html">Collection →</a>
    </div>`;
  const on = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = fn; };
  on('next-pack-btn', () => { resetPackVisual(); document.getElementById('stack-area').style.display = ''; rip(); });
  on('again-btn', () => { resetPackVisual(); document.getElementById('stack-area').style.display = ''; document.getElementById('open-qty').style.display = ''; document.getElementById('rip-btn').textContent = 'Rip another!'; });
  on('results-btn', showResults);
  on('rip-rest-btn', ripRest);
  loadRecent();
  if (!left) { if (window.BGM) BGM.duck(false); if (sessionPacks.length > 1) setTimeout(showResults, 400); }
}
async function ripRest() {
  // fast mode for boxes: remaining packs get laid out straight away (hits still get their fanfare)
  const auto = document.getElementById('auto-flip');
  while (queue.length) {
    resetPackVisual();
    current = queue.shift(); sessionPacks.push(current); flipped = current.length; revealedUp = current.length - 1;
    document.getElementById('pack-stage').style.display = 'none';
    document.getElementById('reveal-stage').style.display = '';
    document.getElementById('stack-area').style.display = 'none';
    updateProgress();
    const grid = document.getElementById('pack-grid');
    grid.style.display = ''; grid.dataset.cardList = '1';
    grid.innerHTML = current.map((c, i) => { const card = getCard(c.id); return `<div class="pcard tier-${c.tier}" data-card-id="${c.id}" data-tier="${c.tier}" style="--i:${i}">${card ? cardImgHtml(card) : ''}<span class="tier-tag">${TIER_LABEL[c.tier] || c.tier}</span></div>`; }).join('');
    for (let i = 0; i < current.length; i++) {
      const lvl = TIER_LEVEL[current[i].tier] || 0;
      if (lvl >= 2) { const el = grid.querySelector(`.pcard[style*="--i:${i}"]`) || grid.children[i]; PackFX.play('flip', current[i].tier); hitEffects(el, current[i].tier, lvl); await sleep(650); }
    }
    await sleep(450);
  }
  auto.checked = false;
  packDone();
}

function showResults() {
  const all = sessionPacks.flat();
  const hits = all.filter((c) => c.hit);
  const byTier = {};
  for (const c of all) byTier[c.tier] = (byTier[c.tier] || 0) + 1;
  const order = ['manga', 'SEC', 'tr', 'sp', 'parallel', 'SR', 'L', 'R', 'UC', 'C'];
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop'; wrap.id = 'results-modal';
  const sortedHits = hits.slice().sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
  wrap.innerHTML = `<div class="modal results-modal">
    <span class="close-x" data-close>✕</span>
    <h2>${sessionPacks.length} pack${sessionPacks.length === 1 ? '' : 's'} of ${escapeHtml(selectedSet.name)} <small>${all.length} cards</small></h2>
    <div class="res-tiers">${order.filter((t) => byTier[t]).map((t) => `<span class="ds-tag tier-${t}">${TIER_LABEL[t]} <b>${byTier[t]}</b></span>`).join('')}</div>
    <h3>${hits.length ? `Hits (${hits.length})` : 'No hits — the Grand Line is cruel'}</h3>
    <div class="res-grid" data-card-list="1">${sortedHits.map((h) => { const c = getCard(h.id); return c ? `<div class="res-card tier-${h.tier}" data-card-id="${c.id}" data-tier="${h.tier}" title="Click to view">${cardImgHtml(c, 'loading="lazy"')}<span class="tier-tag">${TIER_LABEL[h.tier]}</span></div>` : ''; }).join('')}</div>
    <div class="ps-actions" style="margin-top:14px;"><button class="btn gold" data-close>Keep ripping</button><a class="btn secondary" href="/collection.html">Go to my collection</a></div>
  </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) wrap.remove(); });
  if (hits.length) PackFX.play('coin');
}

async function loadRecent() {
  try {
    const { recent, signedIn } = await API.get('/api/collection');
    const box = document.getElementById('recent-hits');
    if (!signedIn || !recent.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="rh-title">Recent hits <span class="ds-muted">· click to view</span></div><div class="rh-row" data-card-list="1">${recent.slice(0, 14).map((r) => { const c = getCard(r.id); return c ? `<div class="rh-card tier-${r.tier}" data-card-id="${c.id}" data-tier="${r.tier}" title="${escapeHtml(c.name)} · ${TIER_LABEL[r.tier] || r.tier}">${cardImgHtml(c, 'loading="lazy"')}</div>` : ''; }).join('')}</div>`;
  } catch (e) { /* ignore */ }
}

function openOddsModal() {
  const M = MODEL || {};
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop'; wrap.id = 'odds-modal';
  wrap.innerHTML = `<div class="modal odds-modal">
    <span class="close-x" data-close>✕</span>
    <h2>How the pack odds work</h2>
    <p>Bandai doesn't publish official pull rates, so packs here follow the rates the community has documented from opening lots of product. Every card comes from the real card list of the set you picked (alternate arts are that set's own parallel prints).</p>
    <ul>
      <li><b>${M.cardsPerPack} cards per pack</b>, ${M.packsPerBox} packs per box.</li>
      <li>Every pack has at least <b>1 Rare</b>. In <b>${pct(M.srChance)}</b> of packs the second Rare becomes a <b>Super Rare</b> (≈8 per box); in <b>${pct(M.secChance)}</b> it's a <b>Secret Rare</b> (≈1 per box).</li>
      <li><b>${pct(M.leaderChance)}</b> of packs carry a <b>Leader</b> (≈12 per box). About <b>${M.uncommons} Uncommons</b>; Commons fill the rest.</li>
      <li><b>Alternate art</b> (parallel) in <b>${pct(M.parallelChance)}</b> of packs (≈2 per box) — it replaces the regular print of that card when it's in the pack.</li>
      <li>Chase: <b>Manga Rare</b> ${pct(M.mangaChance)} (≈1 per 864 packs), <b>Treasure Rare</b> ${pct(M.trChance)} (OP-13+), <b>SP</b> ${pct(M.spChance)} where a set's SP prints are known.</li>
      <li>Box toppers, promos and reprint sets aren't in packs. Extra Boosters use the same model (their real slot structure differs a little).</li>
    </ul>
    <p class="ds-muted">Sources: tcgtalk.com box pull-rate guide, cardgamer.com rarities guide, tcgking.nl rarities guide, slab-z.com pull-rate guide (2026). Real product varies box to box.</p>
    <div class="ps-actions"><button class="btn gold" data-close>Got it</button></div>
  </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) wrap.remove(); });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
init();
