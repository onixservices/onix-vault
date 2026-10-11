const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { setup, open } = require('./db');

// The ledger of sales arrives on a database that already has sales: every sale made before the rule is marked
// `pre_rule` ONCE (it owes nothing), and only sales delivered after the deploy are owed.
const T = 1_800_000_000_000;
const ins = (db, table, row) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
const play = (db, id, over = {}) => ins(db, 'vault_plays', { id, vault: 'V', player: 'P', band: 'b1', currency: 'usdc', client_seed: 's', server_seed: '', server_seed_hash: 'h', snapshot_json: '[]', price_usdc: 19, status: 'delivered', created_at: T, updated_at: T, expires_at: T, ...over });
const res = (db, id, over = {}) => ins(db, 'vault_reservations', { id, vault: 'V', mint: 'M', integrator: 'G', winner: 'W', exit_price_usd: 20, status: 'settled', expires_at: T, created_at: T, updated_at: T, ...over });

/** A database as it was before this change: every table but vault_sales. */
function olderDb() {
  const db = new Database(':memory:');
  setup(db, { log: { log: () => {} } });
  db.exec('DROP TABLE vault_sales');
  return db;
}

describe('db — the sales ledger on an older database', () => {
  test('sales delivered before the ledger existed are marked pre_rule, once: USDC plays and settled gacha sales; a token play, a live reservation and a reservation of no vault are not sales', () => {
    const db = olderDb();
    play(db, 'P-usdc'); play(db, 'P-token', { currency: 'token', price_usdc: null, price_tokens: 1000 }); play(db, 'P-failed', { status: 'delivery_failed' }); play(db, 'P-unpaid', { status: 'created' });
    res(db, 'R-settled'); res(db, 'R-live', { status: 'reserved' }); res(db, 'R-novault', { vault: null }); res(db, 'R-expired', { status: 'expired' });
    const logs = [];
    setup(db, { log: { log: (m) => logs.push(m) } });
    const rows = db.prepare('SELECT source, ref_id, status, price_units, creator_units, onix_units FROM vault_sales ORDER BY ref_id').all();
    assert.deepEqual(rows, [
      { source: 'play', ref_id: 'P-failed', status: 'pre_rule', price_units: 19_000_000, creator_units: 0, onix_units: 0 },
      { source: 'play', ref_id: 'P-usdc', status: 'pre_rule', price_units: 19_000_000, creator_units: 0, onix_units: 0 },
      { source: 'gacha', ref_id: 'R-settled', status: 'pre_rule', price_units: 20_000_000, creator_units: 0, onix_units: 0 },
    ]);
    assert.ok(logs.some((m) => /vault_sales: 3 pre_rule/.test(m)), 'the boot says what it marked');
    // a second boot changes nothing, and a sale made after is not marked
    play(db, 'P-after');
    setup(db, { log: { log: () => {} } });
    assert.equal(db.prepare('SELECT count(*) n FROM vault_sales').get().n, 3);
    assert.equal(db.prepare("SELECT count(*) n FROM vault_sales WHERE status = 'pre_rule'").get().n, 3);
  });
  test('a fresh database gets the ledger with nothing in it; the fee-claims table carries the payout columns', () => {
    const db = open(':memory:');
    assert.equal(db.prepare('SELECT count(*) n FROM vault_sales').get().n, 0);
    const cols = db.prepare('PRAGMA table_info(vault_fee_claims)').all().map((c) => c.name);
    for (const c of ['creator_units', 'sales_onix_units', 'creator_wallet', 'sales_count', 'sol_spent_lamports']) assert.ok(cols.includes(c), c);
    const scols = db.prepare('PRAGMA table_info(vault_sales)').all().map((c) => c.name);
    for (const c of ['id', 'vault', 'source', 'ref_id', 'mint', 'price_units', 'creator_units', 'onix_units', 'treasury_units', 'creator_wallet', 'creator_waived', 'status', 'payout_id', 'created_at', 'updated_at']) assert.ok(scols.includes(c), c);
  });
  test('an older fee-claims table (without the payout columns) is migrated in place and its rows are kept', () => {
    const db = olderDb();
    db.exec('DROP TABLE vault_fee_claims');
    db.exec('CREATE TABLE vault_fee_claims (id TEXT PRIMARY KEY, vault TEXT NOT NULL, curve_units INTEGER NOT NULL, pool_units INTEGER NOT NULL, onix_units INTEGER NOT NULL, treasury_units INTEGER NOT NULL, tx_b64 TEXT NOT NULL, sig TEXT NOT NULL UNIQUE, status TEXT NOT NULL, fail_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    db.prepare("INSERT INTO vault_fee_claims VALUES ('C1', 'V', 100, 0, 33, 67, 'x', 'S', 'landed', NULL, ?, ?)").run(T, T);
    setup(db, { log: { log: () => {} } });
    const r = db.prepare('SELECT * FROM vault_fee_claims').get();
    assert.equal(r.status, 'landed'); assert.equal(r.creator_units, 0); assert.equal(r.sales_onix_units, 0); assert.equal(r.sales_count, 0); assert.equal(r.creator_wallet, null);
  });
});
