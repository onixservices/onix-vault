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
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

let _db = null;
function getDb() {
  if (!_db) _db = open(require('./config').DB_PATH);
  return _db;
}
const getTestDb = () => open(':memory:');

module.exports = { open, getDb, getTestDb };
