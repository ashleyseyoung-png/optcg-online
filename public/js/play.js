// Lobby: pick a deck (saved or starter), then start a tutorial match, a bot match,
// or create/join a room with a friend.
let MY_DECKS = [];
let STARTERS = [];

async function init() {
  await loadUser();
  if (!CURRENT_USER) {
    // Friendly gate instead of a modal that blocks the whole page.
    document.getElementById('gate').style.display = '';
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('gate-guest').onclick = async () => { const { user } = await API.post('/api/auth/guest'); CURRENT_USER = user; renderUserBox(); document.getElementById('gate').style.display = 'none'; document.getElementById('lobby').style.display = ''; init(); };
    document.getElementById('gate-signin').onclick = () => openAuthModal(() => { document.getElementById('gate').style.display = 'none'; document.getElementById('lobby').style.display = ''; init(); });
    return;
  }
  document.getElementById('gate').style.display = 'none';
  document.getElementById('lobby').style.display = '';
  const [mine, starters] = await Promise.all([API.get('/api/decks'), API.get('/api/starter-decks')]);
  MY_DECKS = mine.decks;
  STARTERS = starters.decks;
  fillDeckSelects();
  wireUi();
}

function fillDeckSelects() {
  const mineOpts = MY_DECKS.map((d) => `<option value="deck:${d.id}">${escapeHtml(d.name)}</option>`).join('');
  const starterOpts = STARTERS.map((d) => `<option value="starter:${d.id}">${escapeHtml(d.name)}</option>`).join('');
  const html =
    (MY_DECKS.length ? `<optgroup label="My saved decks">${mineOpts}</optgroup>` : '') +
    `<optgroup label="Starter decks (ready to play)">${starterOpts}</optgroup>`;
  for (const id of ['tutorial-deck-select', 'bot-deck-select', 'friend-deck-select']) {
    document.getElementById(id).innerHTML = html;
  }
}

// Turn a select value into the body the rooms API expects.
function deckBody(selectId) {
  const v = document.getElementById(selectId).value;
  if (!v) return null;
  const [kind, id] = v.split(':');
  return kind === 'deck' ? { deckId: id } : { starterId: v.slice('starter:'.length) };
}

function showErr(e) { toast(e.data && e.data.details ? e.data.details[0] : e.message); }

function wireUi() {
  document.getElementById('tutorial-btn').onclick = async () => {
    const body = deckBody('tutorial-deck-select');
    if (!body) return;
    try {
      const { roomCode } = await API.post('/api/rooms', Object.assign({ vsBot: true, tutorial: true }, body));
      location.href = `/game.html?room=${roomCode}&tutorial=1`;
    } catch (e) { showErr(e); }
  };

  document.getElementById('bot-btn').onclick = async () => {
    const body = deckBody('bot-deck-select');
    if (!body) return;
    try {
      const { roomCode } = await API.post('/api/rooms', Object.assign({ vsBot: true }, body));
      location.href = `/game.html?room=${roomCode}`;
    } catch (e) { showErr(e); }
  };

  document.getElementById('create-room-btn').onclick = async () => {
    const body = deckBody('friend-deck-select');
    if (!body) return;
    try {
      const { roomCode } = await API.post('/api/rooms', body);
      document.getElementById('room-code-display').textContent = roomCode;
      document.getElementById('create-result').style.display = '';
      document.getElementById('enter-room-btn').onclick = () => { location.href = `/game.html?room=${roomCode}`; };
      document.getElementById('copy-code-btn').onclick = () => {
        navigator.clipboard.writeText(roomCode).then(() => toast('Room code copied!', 'ok'), () => toast('Code: ' + roomCode));
      };
    } catch (e) { showErr(e); }
  };

  document.getElementById('join-room-btn').onclick = async () => {
    const body = deckBody('friend-deck-select');
    const code = document.getElementById('join-code-input').value.trim().toUpperCase();
    if (!body || !code) { toast('Pick a deck and enter a room code.'); return; }
    try {
      await API.post(`/api/rooms/${code}/join`, body);
      location.href = `/game.html?room=${code}`;
    } catch (e) { showErr(e); }
  };

  document.getElementById('join-code-input').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
  document.getElementById('join-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('join-room-btn').click(); });
}

init();
