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
    owner TEXT NOT NULL,               -- who sent the item (and is owed tokens)
    signature TEXT NOT NULL UNIQUE,    -- the transfer the sender signed
    value_usd REAL NOT NULL,           -- custodian value at admission
    owed_usd REAL NOT NULL,            -- value × realisable × admission (80%)
    lock_months INTEGER NOT NULL,
    status TEXT NOT NULL,              -- pending (sent) | admitted (vault owns it) | rejected
    tokens_sig TEXT,                   -- the buy on the curve + lock, once the vault has USDC
    tokens_amount REAL,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adm_status ON vault_admissions (status);
`;

/** Columns added after the first deploy: add them if an older file lacks them. */
function migrate(db) {
  for (const t of ['vault_reservations', 'vault_redemptions', 'vault_admissions']) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (!cols.includes('vault')) db.exec(`ALTER TABLE ${t} ADD COLUMN vault TEXT`);
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
