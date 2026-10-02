/**
 * server/db.js — one SQLite file. Reservations and redemptions only: what is IN the
 * vault is never stored here, it is read from the chain every time.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS vault_reservations (
    id TEXT PRIMARY KEY,
    vault TEXT,                    -- the vault wallet this row belongs to (one DB, N vaults)
    mint TEXT NOT NULL,
    integrator TEXT NOT NULL,
    winner TEXT NOT NULL,
    exit_price_usd REAL NOT NULL,
    status TEXT NOT NULL,          -- reserved | settling | settled | expired | cancelled | delivery_failed
    expires_at INTEGER NOT NULL,
    payment_sig TEXT UNIQUE,       -- a payment settles ONE reservation, ever (the last lock)
    payment_tx_b64 TEXT,           -- the payment tx we BUILT for the integrator (unsigned)
    idempotency_key TEXT UNIQUE,   -- Idempotency-Key of the POST that created it
    delivery_sig TEXT,
    delivery_tx_b64 TEXT,          -- the SIGNED delivery, persisted BEFORE it is broadcast
    fail_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_res_mint ON vault_reservations (mint, status);
  CREATE INDEX IF NOT EXISTS idx_res_integrator ON vault_reservations (integrator, status);

  CREATE TABLE IF NOT EXISTS vault_redemptions (
    id TEXT PRIMARY KEY,
    vault TEXT,
    mint TEXT NOT NULL,
    recipient TEXT NOT NULL,
    burn_sig TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,          -- verifying | delivered | rejected
    tokens_burned REAL,
    price_usd_at_burn REAL,
    delivery_sig TEXT,
    delivery_tx_b64 TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vault_admissions (
    id TEXT PRIMARY KEY,
    vault TEXT,
    mint TEXT NOT NULL,
    owner TEXT NOT NULL,               -- the creator who sent the item
    signature TEXT NOT NULL UNIQUE,    -- the transfer the creator signed
    value_usd REAL NOT NULL,           -- custodian value at admission
    owed_usd REAL,                     -- (legacy, 1 Oct) nothing is owed per item since 2 Oct
    lock_months INTEGER,
    status TEXT NOT NULL,              -- pending (sent) | admitted (custody owns it) | rejected
    tokens_sig TEXT,                   -- (legacy)
    tokens_amount REAL,
    unlock_at INTEGER,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adm_status ON vault_admissions (status);

  -- vaults opened through the Create door (the file registry holds the operator's)
  CREATE TABLE IF NOT EXISTS vaults (
    id TEXT PRIMARY KEY,               -- the symbol, lower-case
    name TEXT NOT NULL,
    operator TEXT NOT NULL,            -- short form of the creator wallet
    wallet TEXT NOT NULL UNIQUE,       -- the creator's wallet: it IS the vault
    pool TEXT NOT NULL UNIQUE,
    base_mint TEXT NOT NULL UNIQUE,
    config TEXT NOT NULL,
    graduation_usd REAL NOT NULL,
    token_name TEXT NOT NULL,
    token_symbol TEXT NOT NULL UNIQUE,
    rules TEXT NOT NULL,               -- key into VAULT_RULES
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    launch_sig TEXT,
    closed_at INTEGER
  );
  -- what a created vault declares as backing (at creation, then each verified admission)
  CREATE TABLE IF NOT EXISTS vault_items (
    vault TEXT NOT NULL,
    mint TEXT NOT NULL,
    source TEXT NOT NULL,              -- creation | admission
    added_at INTEGER NOT NULL,
    PRIMARY KEY (vault, mint)
  );
`;

/** Columns added after the first deploy: add them if an older file lacks them. */
function migrate(db) {
  for (const t of ['vault_reservations', 'vault_redemptions', 'vault_admissions']) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (!cols.includes('vault')) db.exec(`ALTER TABLE ${t} ADD COLUMN vault TEXT`);
    if (t === 'vault_admissions' && !cols.includes('unlock_at')) db.exec(`ALTER TABLE ${t} ADD COLUMN unlock_at INTEGER`);
  }
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

let _db = null;
function getDb() {
  if (!_db) _db = open(require('./config').DB_PATH);
  return _db;
}
const getTestDb = () => open(':memory:');

module.exports = { open, getDb, getTestDb };
