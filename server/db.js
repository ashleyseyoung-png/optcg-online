// Tiny persistence layer built on Node's built-in SQLite (node:sqlite, Node >=22.5).
// No ORM, no external deps — just a handful of prepared statements.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

// Where accounts/decks live. Defaults to a per-user folder OUTSIDE the project
// (~/.grand-line-tcg) so your data survives unzipping a new version of the app
// into a different folder. Override with DATA_DIR=/some/path (e.g. a mounted
// volume on a host).
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.grand-line-tcg');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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

module.exports = { db, DB_PATH };
