/**
 * server/db.js — one SQLite file. What the doors recorded, only: what is IN the
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


  CREATE TABLE IF NOT EXISTS vault_admissions (
    id TEXT PRIMARY KEY,
    vault TEXT,
    mint TEXT NOT NULL,
    owner TEXT NOT NULL,               -- the creator who sent the item
    signature TEXT NOT NULL UNIQUE,    -- the transfer the creator signed
    value_usd REAL NOT NULL,           -- custodian value at admission
    owed_usd REAL,                     -- (legacy) nothing is owed per item any more
    lock_months INTEGER,
    status TEXT NOT NULL,              -- pending (sent) | admitted (custody owns it, creator signed) | rejected | expired
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
    server_seed TEXT NOT NULL,         -- '' when derived from the draw key (never stored); older rows keep theirs
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
    onix_units INTEGER NOT NULL,       -- everything sent to Onix in this tx: its third of the curve fee + its 2% of the sales
    treasury_units INTEGER NOT NULL,   -- the custody's net USDC move (fees claimed − the two sale legs; can be negative)
    tx_b64 TEXT NOT NULL,
    sig TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,              -- sent | landed | failed
    fail_reason TEXT,
    creator_units INTEGER NOT NULL DEFAULT 0,      -- the creator's 5% of the sales paid in this tx (server/commissions.js)
    sales_onix_units INTEGER NOT NULL DEFAULT 0,   -- Onix's 2% of those sales (part of onix_units)
    creator_wallet TEXT,                           -- where the creator's leg went
    sales_count INTEGER NOT NULL DEFAULT 0,
    sol_spent_lamports INTEGER,                    -- measured in simulation: the fee and, at most, the creator's token account rent
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fee_claims_vault_status ON vault_fee_claims (vault, status);

  -- every card a vault sells (server/commissions.js): one row per USDC sale, written when the item is delivered;
  -- the creator's 5% and Onix's 2% are paid by the custody in its next fee claim (payout_id → vault_fee_claims.id)
  CREATE TABLE IF NOT EXISTS vault_sales (
    id TEXT PRIMARY KEY,
    vault TEXT NOT NULL,
    source TEXT NOT NULL,              -- play | gacha
    ref_id TEXT NOT NULL,              -- vault_plays.id | vault_reservations.id
    mint TEXT,
    price_units INTEGER NOT NULL,      -- micro-USDC the buyer paid to custody
    creator_units INTEGER NOT NULL,
    onix_units INTEGER NOT NULL,
    treasury_units INTEGER NOT NULL,
    creator_wallet TEXT,               -- the creator registered when the sale was made (the only address a leg may go to)
    creator_waived TEXT,               -- no_creator | creator_is_custody | creator_invalid: the 5% stayed in the treasury
    status TEXT NOT NULL,              -- pre_rule | owed | paying | paid
    payout_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source, ref_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sales_vault_status ON vault_sales (vault, status);

  -- the vault graduating itself (server/graduation.js): one row per vault; the steps' signatures as they land
  CREATE TABLE IF NOT EXISTS vault_graduations (
    id TEXT PRIMARY KEY,
    vault TEXT NOT NULL UNIQUE,
    pool TEXT NOT NULL,
    status TEXT NOT NULL,              -- running | done | failed
    step TEXT,                         -- locker | migrate | fee | leftover | done | external
    attempts INTEGER NOT NULL DEFAULT 0,
    raised_usd REAL,
    threshold_usd REAL,
    locker_sig TEXT,
    migrate_sig TEXT,
    fee_sig TEXT,
    leftover_sig TEXT,
    skipped_json TEXT,
    fail_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
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
  for (const t of ['vault_reservations', 'vault_admissions']) {
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
  // fee claims from before the sale commission (11 Oct 2026) lack the payout columns
  const fcols = db.prepare('PRAGMA table_info(vault_fee_claims)').all().map((c) => c.name);
  for (const [name, type] of [['creator_units', 'INTEGER NOT NULL DEFAULT 0'], ['sales_onix_units', 'INTEGER NOT NULL DEFAULT 0'], ['creator_wallet', 'TEXT'], ['sales_count', 'INTEGER NOT NULL DEFAULT 0'], ['sol_spent_lamports', 'INTEGER']]) {
    if (!fcols.includes(name)) db.exec(`ALTER TABLE vault_fee_claims ADD COLUMN ${name} ${type}`);
  }
}

/**
 * The sales ledger arriving on a database that already sold: every USDC sale made before the rule is marked
 * `pre_rule` ONCE — the first time the server boots with the table — and owes nothing. Only sales delivered
 * after that are owed. A paid play that is still on its way out (drawn, delivering, delivery failed) was sold
 * before the rule too.
 */
function backfillSales(db, now) {
  const units = (col) => `CAST(ROUND(${col} * 1000000) AS INTEGER)`;
  const plays = db.prepare(`INSERT OR IGNORE INTO vault_sales (id, vault, source, ref_id, mint, price_units, creator_units, onix_units, treasury_units, creator_wallet, creator_waived, status, payout_id, created_at, updated_at)
    SELECT 'pre:' || id, vault, 'play', id, mint, ${units('price_usdc')}, 0, 0, ${units('price_usdc')}, NULL, NULL, 'pre_rule', NULL, updated_at, ?
    FROM vault_plays WHERE currency = 'usdc' AND price_usdc IS NOT NULL AND status IN ('drawn', 'delivering', 'delivered', 'delivery_failed')`).run(now).changes;
  const gacha = db.prepare(`INSERT OR IGNORE INTO vault_sales (id, vault, source, ref_id, mint, price_units, creator_units, onix_units, treasury_units, creator_wallet, creator_waived, status, payout_id, created_at, updated_at)
    SELECT 'pre:' || id, vault, 'gacha', id, mint, ${units('exit_price_usd')}, 0, 0, ${units('exit_price_usd')}, NULL, NULL, 'pre_rule', NULL, updated_at, ?
    FROM vault_reservations WHERE vault IS NOT NULL AND status IN ('settling', 'settled', 'delivery_failed')`).run(now).changes;
  return plays + gacha;
}

/** Schema, migrations, and the one-time backfill of the sales ledger. Exported for the tests. */
function setup(db, { log = console, now = Date.now } = {}) {
  const hadSales = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vault_sales'").get());
  db.exec(SCHEMA);
  migrate(db);
  if (!hadSales) { const n = backfillSales(db, now()); log.log(`[db] vault_sales: ${n} pre_rule sale(s) marked (they owe nothing)`); }
  return db;
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  return setup(db);
}

let _db = null;
function getDb() {
  if (!_db) _db = open(require('./config').DB_PATH);
  return _db;
}
const getTestDb = () => open(':memory:');

module.exports = { open, setup, getDb, getTestDb };
