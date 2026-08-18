// Tiny persistence layer built on Node's built-in SQLite.
// No ORM, no external deps — just a handful of prepared statements.
//
// NOTE ON NODE VERSION: `node:sqlite` only works without a CLI flag from Node
// v22.13.0 / v23.4.0 onward (it existed behind --experimental-sqlite since
// v22.5.0). Older Node here means a confusing "no such built-in module" crash,
// so we catch it and say exactly what's wrong.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error(`
┌───────────────────────────────────────────────────────────────────┐
│  Grand Line TCG can't start: this Node.js is too old.             │
│                                                                   │
│  Running:  ${process.version.padEnd(54)}│
│  Needs:    v22.13.0 or newer (v22.13 is the first release where   │
│            Node's built-in SQLite works without a special flag)   │
│                                                                   │
│  Fix: install the latest Node 22 LTS from https://nodejs.org      │
│  (Hosting? Set the NODE_VERSION environment variable to 22.)      │
└───────────────────────────────────────────────────────────────────┘
`);
  process.exit(1);
}

// Where accounts/decks live. Defaults to a per-user folder OUTSIDE the project
// (~/.grand-line-tcg) so your data survives unzipping a new version of the app
// into a different folder. Override with DATA_DIR=/some/path (e.g. a mounted
// volume on a host). Falls back to a temp folder if neither is writable, so the
// app still runs (in-memory-ish) rather than crashing on a locked-down host.
function pickDataDir() {
  const candidates = [
    process.env.DATA_DIR,
    path.join(os.homedir() || '.', '.grand-line-tcg'),
    path.join(os.tmpdir(), 'grand-line-tcg'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (e) {
      console.warn(`Can't use ${dir} for data (${e.code || e.message}) — trying the next location.`);
    }
  }
  throw new Error('No writable folder found for the database. Set DATA_DIR to a writable path.');
}

const DATA_DIR = pickDataDir();
const DB_PATH = path.join(DATA_DIR, 'optcg.sqlite');

// One-time migration: if an older copy of the app left a database next to the code, adopt it.
const LEGACY_DB = path.join(__dirname, '..', 'data-store', 'optcg.sqlite');
if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB)) {
  try { fs.copyFileSync(LEGACY_DB, DB_PATH); console.log(`Migrated existing database from ${LEGACY_DB}`); } catch (e) { /* ignore */ }
}
console.log(`Accounts & decks database: ${DB_PATH}`);

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    username_lower TEXT UNIQUE NOT NULL,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER,
    guest_name TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS decks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_key TEXT NOT NULL,
    name TEXT NOT NULL,
    leader_id TEXT NOT NULL,
    cards_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_decks_owner ON decks(owner_key);
`);

module.exports = { db, DB_PATH, DATA_DIR };
