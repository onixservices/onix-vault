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
    wallet TEXT NOT NULL UNIQUE,       -- the CUSTODY wallet (derived, server/keyring.js): where the items live
    creator TEXT,                      -- the creator's wallet: pool creator, gets the allocation and the creator fee
    custody_index INTEGER UNIQUE,      -- derivation index of the custody wallet
    rules_json TEXT,                   -- the creator's rules (server/rules.js)
    grad_mult REAL,
    creator_fee_pct INTEGER,
    description TEXT,
    image TEXT,                        -- stored upload name (data/uploads/…) or null
    banner TEXT,
    links_json TEXT,
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
  -- a vault being created: custody allocated, items on their way, config, launch — until launched or abandoned
  CREATE TABLE IF NOT EXISTS vault_creations (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,               -- the creator
    custody_index INTEGER NOT NULL UNIQUE,
    custody_wallet TEXT NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    mints_json TEXT NOT NULL,
    rules_json TEXT NOT NULL,
    description TEXT,
    links_json TEXT,
    image TEXT,
    banner TEXT,
    status TEXT NOT NULL,              -- opened | deposited | launched | abandoned
    config TEXT,                       -- once Onix created it (after the deposit)
    config_sig TEXT,
    backing_usd REAL,
    graduation_usd REAL,
    base_mint TEXT,
    pool TEXT,
    launch_sig TEXT,
    launch_at INTEGER,                 -- when the creator's launch was submitted (it can land for ~60–90 s)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_creations_owner ON vault_creations (owner, status);

  -- the Play door: one row per play, from commit to delivery (the proof lives here)
  CREATE TABLE IF NOT EXISTS vault_plays (
    id TEXT PRIMARY KEY,
    vault TEXT NOT NULL,
    player TEXT NOT NULL,
    band TEXT NOT NULL,
    currency TEXT NOT NULL,            -- usdc | token
    client_seed TEXT NOT NULL,
    server_seed TEXT NOT NULL,         -- revealed in the API only once the play is done
    server_seed_hash TEXT NOT NULL,    -- published at start
    snapshot_json TEXT NOT NULL,       -- the band's mints at start, sorted
    price_usdc REAL,
    price_tokens REAL,
    avg_index_usd REAL,
    status TEXT NOT NULL,              -- created | submitted | drawn | delivering | delivered | delivery_failed | payment_rejected | payment_missing | expired
    payment_sig TEXT UNIQUE,
    mint TEXT,
    digest TEXT,
    draw_index INTEGER,
    nonce INTEGER,
    delivery_tx_b64 TEXT,
    delivery_sig TEXT,
    fail_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_plays_vault_status ON vault_plays (vault, status);

  -- the treasury buying the next item (server/restock.js): one row per purchase, persisted before broadcast
  CREATE TABLE IF NOT EXISTS vault_purchases (
    id TEXT PRIMARY KEY,
    vault TEXT NOT NULL,
    mint TEXT NOT NULL,
    name TEXT,
    price_usd REAL NOT NULL,
    insured_usd REAL,
    venue TEXT NOT NULL,
    seller TEXT,
    tx_b64 TEXT NOT NULL,
    sig TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,              -- sent | landed | failed
    fail_reason TEXT,
    landed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_purchases_vault_status ON vault_purchases (vault, status);

  -- the trading fees reaching the treasury (server/feeclaim.js): curve partner fee (split with Onix in the same tx) + pool LP fee
  CREATE TABLE IF NOT EXISTS vault_fee_claims (
    id TEXT PRIMARY KEY,
    vault TEXT NOT NULL,
    curve_units INTEGER NOT NULL,
    pool_units INTEGER NOT NULL,
    onix_units INTEGER NOT NULL,
    treasury_units INTEGER NOT NULL,
    tx_b64 TEXT NOT NULL,
    sig TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,              -- sent | landed | failed
    fail_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fee_claims_vault_status ON vault_fee_claims (vault, status);

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
  const ccols = db.prepare('PRAGMA table_info(vault_creations)').all().map((c) => c.name);
  if (!ccols.includes('launch_at')) db.exec('ALTER TABLE vault_creations ADD COLUMN launch_at INTEGER');
  // vaults created before custody (1-2 Oct) lack these columns
  const vcols = db.prepare('PRAGMA table_info(vaults)').all().map((c) => c.name);
  for (const [name, type] of [['creator', 'TEXT'], ['custody_index', 'INTEGER'], ['rules_json', 'TEXT'], ['grad_mult', 'REAL'], ['creator_fee_pct', 'INTEGER'], ['description', 'TEXT'], ['image', 'TEXT'], ['banner', 'TEXT'], ['links_json', 'TEXT']]) {
    if (!vcols.includes(name)) db.exec(`ALTER TABLE vaults ADD COLUMN ${name} ${type}`);
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
