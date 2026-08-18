# Grand Line TCG — One Piece Card Game Online Simulator

A fan-made, unofficial web app for learning and playing the **One Piece Card Game (OPTCG)**:

- **Learn to Play** — a full rules reference (zones, turn structure, DON!!, keywords, deck building) sourced from Bandai's official Comprehensive Rules.
- **Deck Builder** — browse and filter the full card pool (every OP/EB/PRB booster, ST starter deck and promo, **including alternate arts, parallels, SP/SPR, manga arts and box toppers as separately selectable printings** — 3,400+ printings of 2,650+ cards, and it refreshes itself from the public card database so new sets show up on their own) and build/save legal 50-card decks. Search by name, card ID, type, or text; the 4-copy limit is counted per card number across all art versions, as in the real rules.
- **Tutorial Match** — a real game against the bot with a live coach panel that explains each phase, what you can click, and why, as it comes up.
- **Play vs Bot** — practice any time against Captain Bot, which plays a random starter deck and takes its own turns (plays Characters, attaches DON!!, attacks, blocks, counters).
- **Play a Friend** — create a room, send a 5-letter code, and play a full real-time match. The server handles shuffling, drawing, DON!!, life, combat resolution, and a large set of common card-effect text patterns automatically, with a manual "toolbox" fallback for the many effects too unique to fully automate.
- **20 Starter Decks** — ready-to-play decks generated from the official ST sets, usable in any mode with no deck-building required (and loadable into the Deck Builder as a starting point).
- **Accounts or Guest** — register with just a username/password, or jump in instantly as a random guest with no signup at all.

Card art is hotlinked from public card databases at render time — no card images are stored or redistributed by this app. Each picture has a fallback chain: the primary database → the official Bandai card list → a small relay on your own server (`/api/card-image/:id`, cached on disk under the data folder) so a friend whose network blocks the art hosts still sees every card. Card backs and DON!! cards are drawn as SVGs (`public/img/cardback.svg`, `public/img/don.svg`); if you'd rather use real scans, drop `cardback.png` and/or `don.png` into `public/img/` and they'll be used automatically.

## Why zero dependencies?

Everything runs on Node's **built-ins only** — no `npm install` step, nothing to go out of date:

- `node:http` — a small hand-rolled router (`server/http-helpers.js`) instead of Express
- `node:sqlite` (`DatabaseSync`) — Node's built-in SQLite instead of `better-sqlite3`
- A hand-rolled RFC 6455 WebSocket server (`server/ws-server.js`) instead of `ws`/`socket.io` — browsers already speak WebSocket natively, so no client library is needed either
- `node:crypto`'s `scrypt` for password hashing instead of `bcrypt`

This also happens to be the simplest possible backend to run: clone it, run `node server/index.js`, done.

**Requires Node.js 22.5 or newer** (for `node:sqlite`). Check with `node --version`.

## Where your data lives

Accounts and saved decks are stored in a small SQLite file at `~/.grand-line-tcg/optcg.sqlite` (your home folder — outside the app folder), so they survive unzipping a new version of the app. Set the `DATA_DIR` environment variable to put it somewhere else (e.g. a persistent volume when hosting). If an older copy left a `data-store/` folder next to the code, it's migrated automatically on first start.

## Sounds

All sound effects are synthesized in the browser with WebAudio (`public/js/sfx.js`) — no audio files. They're intentionally soft and short. The 🔊 button in the nav / game top bar mutes them, and the choice is remembered.

## Running it locally

```bash
node server/index.js
```

Then open `http://localhost:3000`. That's the entire setup.

## Playing with friends

- **Right now, from your PC:** `npm run share` — starts the game and prints a public https link (via a free Cloudflare quick tunnel) that friends can open while your window stays open.
- **A permanent URL:** see `SHARE.md` (Render free tier via the included `render.yaml` blueprint, or Railway via the included `Dockerfile`/`railway.json`). `DEPLOY.md` has the longer-form hosting notes.

## Project layout

```
public/            All static frontend files (plain HTML/CSS/JS, no build step)
  index.html        Landing page
  learn.html        Rules reference
  decks.html        Deck builder
  play.html         Online lobby (create/join a room)
  game.html         The live game board
  data/cards.json   The full card database (generated — see data/parse_cards.py; refreshed by scripts/sync-cards.js)
server/
  index.js          Entry point — wires up HTTP routes, static files, and WebSocket
  auth.js           Accounts, guest sessions, cookies, password hashing
  cards.js          Serves the card database, the card-art relay, and the once-a-day background card refresh
  decks.js          Deck CRUD + legality validation
  starter-decks.js  Generates the 20 ready-made starter decks from the ST sets
  db.js             node:sqlite setup (users, sessions, decks tables)
  http-helpers.js   Tiny router + static file server (replaces Express)
  ws-server.js      Hand-rolled WebSocket server (replaces ws/socket.io)
  game/
    engine.js       The authoritative game state machine (turns, combat, DON!!, life...)
    effects.js       Regex-based auto-resolver for common card-effect text
    bot.js           The AI opponent (drives a seat through the same Game methods a player uses)
    rooms.js         Room creation/joining, bot rooms, and WebSocket message routing
scripts/
  sync-cards.js     `npm run sync-cards` — pulls any printings we don't have yet (new sets, alt arts) from
                    optcgapi.com into cards.json. Runs automatically at deploy time (Render build / Docker
                    build) and once a day in the background while the server runs. Offline? It just skips.
data/
  parse_cards.py    Script that built the shipped public/data/cards.json from raw card dumps
  raw/*.txt          Raw per-set card data used to build the database
```

## A note on scope

OPTCG has 2,000+ cards with wildly varied, often unique effect text — there is no realistic way to hand-code a client-server rules engine that perfectly automates every single card. This app automates all of the *structural* game mechanics (drawing, DON!!, life, turn phases, combat math, mulligans, triggers) plus a curated set of the most common effect-text patterns (draw N, K.O./rest up to N opponent characters under a cost/power threshold, power buffs/debuffs, DON!! from deck, trashing). For anything else, the printed card text is shown to both players and a small manual "toolbox" lets you apply the effect by hand — and it only allows rule-shaped moves (draw from your deck, ±1000/2000 power for the turn, rest/activate, K.O., move DON!! between the DON!! deck / cost area / cards with the 10-DON!! total enforced, trash from hand), only on your own turn or during a battle that involves you, and every use is written to the shared log so play stays fair and in sync — same idea as how OPTCGSim and similar simulators handle it, just with more of the common cases automated for you.
