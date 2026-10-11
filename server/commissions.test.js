const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair } = require('@solana/web3.js');
const { getTestDb } = require('./db');
const { createCommissions, splitOfSale, SALE_SPLIT } = require('./commissions');

// Every card a vault sells pays the creator 5% and Onix 2%; 93% stays in the treasury. The sale is written in the
// ledger the moment the item is delivered; the custody pays the two shares in its next fee-claim transaction.
const CUSTODY = Keypair.generate().publicKey.toBase58();
const CREATOR = Keypair.generate().publicKey.toBase58();
const T0 = 1_800_000_000_000;

const make = ({ creator = CREATOR, vault = CUSTODY } = {}) => {
  const db = getTestDb(); const warned = [];
  const c = createCommissions({ db, vaultWallet: vault, creator, now: () => T0, log: { warn: (m) => warned.push(m) } });
  return { c, db, warned };
};

describe('splitOfSale — the arithmetic, one source', () => {
  test('5% creator · 2% Onix · 93% treasury, in micro-USDC; the creator and Onix are floored, the treasury takes the rest', () => {
    assert.deepEqual(SALE_SPLIT, { creator: 5, onix: 2, treasury: 93 });
    assert.deepEqual(splitOfSale(25.30), { priceUnits: 25_300_000, creatorUnits: 1_265_000, onixUnits: 506_000, treasuryUnits: 23_529_000 });
    assert.deepEqual(splitOfSale(19), { priceUnits: 19_000_000, creatorUnits: 950_000, onixUnits: 380_000, treasuryUnits: 17_670_000 });
  });
  test('the three parts always add back up to the price exactly, whatever the rounding', () => {
    for (const p of [19.99, 0.33, 0.01, 13.37, 149.95, 1e-6, 1234.567891]) {
      const s = splitOfSale(p);
      assert.equal(s.creatorUnits + s.onixUnits + s.treasuryUnits, s.priceUnits, String(p));
      assert.ok(s.creatorUnits <= s.priceUnits * SALE_SPLIT.creator / 100 && s.onixUnits <= s.priceUnits * SALE_SPLIT.onix / 100);
    }
  });
  test('a split that does not sum to 100, or a price that is not a positive number, is refused', () => {
    assert.throws(() => splitOfSale(10, { creator: 5, onix: 2, treasury: 90 }), /sum to 100/);
    for (const bad of [-1, NaN, Infinity, 'x', null]) assert.throws(() => splitOfSale(bad), /price/);
  });
});

describe('the ledger — one row per sale, written once', () => {
  test('recordSale writes the parts and the creator snapshot as owed; the same sale twice is one row', () => {
    const { c, db } = make();
    const a = c.recordSale({ source: 'play', refId: 'P1', mint: 'M1', priceUsd: 19, at: T0 });
    assert.equal(a.status, 'owed'); assert.equal(a.creatorUnits, 950_000); assert.equal(a.onixUnits, 380_000); assert.equal(a.treasuryUnits, 17_670_000);
    assert.equal(a.creatorWallet, CREATOR); assert.equal(a.creatorWaived, null); assert.equal(a.source, 'play'); assert.equal(a.refId, 'P1');
    const b = c.recordSale({ source: 'play', refId: 'P1', mint: 'M1', priceUsd: 19, at: T0 + 5 });
    assert.equal(b.id, a.id, 'the second call returns the first row');
    assert.equal(db.prepare('SELECT count(*) n FROM vault_sales').get().n, 1);
    c.recordSale({ source: 'gacha', refId: 'P1', mint: 'M2', priceUsd: 20, at: T0 });
    assert.equal(db.prepare('SELECT count(*) n FROM vault_sales').get().n, 2, 'the same id in another source is another sale');
  });
  test('a sale needs a source the ledger knows, a reference and a positive price', () => {
    const { c } = make();
    assert.throws(() => c.recordSale({ source: 'tip', refId: 'X', priceUsd: 1, at: T0 }), /source/);
    assert.throws(() => c.recordSale({ source: 'play', refId: '', priceUsd: 1, at: T0 }), /ref/);
    assert.throws(() => c.recordSale({ source: 'play', refId: 'X', priceUsd: 0, at: T0 }), /price/);
  });
  test('owed(): the rows waiting for a payout, with their sums and the one creator they name', () => {
    const { c } = make();
    assert.deepEqual(c.owed(), { ids: [], count: 0, priceUnits: 0, creatorUnits: 0, onixUnits: 0, creatorWallets: [] });
    c.recordSale({ source: 'play', refId: 'P1', mint: 'M1', priceUsd: 19, at: T0 });
    c.recordSale({ source: 'gacha', refId: 'R1', mint: 'M2', priceUsd: 25.3, at: T0 });
    const o = c.owed();
    assert.equal(o.count, 2); assert.equal(o.ids.length, 2);
    assert.equal(o.priceUnits, 44_300_000); assert.equal(o.creatorUnits, 950_000 + 1_265_000); assert.equal(o.onixUnits, 380_000 + 506_000);
    assert.deepEqual(o.creatorWallets, [CREATOR]);
  });
  test('without a registered creator, or when the creator IS the custody, the 5% stays in the treasury and the row says why', () => {
    const none = make({ creator: null });
    const a = none.c.recordSale({ source: 'play', refId: 'P1', mint: 'M1', priceUsd: 19, at: T0 });
    assert.equal(a.creatorUnits, 0); assert.equal(a.creatorWaived, 'no_creator'); assert.equal(a.creatorWallet, null); assert.equal(a.treasuryUnits, 19_000_000 - 380_000);
    assert.equal(none.c.owed().creatorUnits, 0); assert.equal(none.c.owed().onixUnits, 380_000); assert.deepEqual(none.c.owed().creatorWallets, []);
    const self = make({ creator: CUSTODY });
    assert.equal(self.c.recordSale({ source: 'play', refId: 'P1', mint: 'M1', priceUsd: 19, at: T0 }).creatorWaived, 'creator_is_custody');
    const bad = make({ creator: 'not-a-wallet' });
    assert.equal(bad.c.recordSale({ source: 'play', refId: 'P1', mint: 'M1', priceUsd: 19, at: T0 }).creatorWaived, 'creator_invalid');
    assert.equal(bad.warned.length, 1, 'a malformed creator is warned about, never a crash');
  });
});

describe('the payout — owed → paying → paid, or back to owed', () => {
  const two = () => { const w = make(); w.c.recordSale({ source: 'play', refId: 'P1', mint: 'M1', priceUsd: 19, at: T0 }); w.c.recordSale({ source: 'gacha', refId: 'R1', mint: 'M2', priceUsd: 25.3, at: T0 }); return w; };
  test('markPaying moves exactly the owed rows named, and says how many it moved; a row already paying is not moved twice', () => {
    const { c } = two();
    const { ids } = c.owed();
    assert.equal(c.markPaying(ids, 'PAYOUT-1', T0 + 1), 2);
    assert.equal(c.owed().count, 0);
    assert.equal(c.markPaying(ids, 'PAYOUT-2', T0 + 2), 0, 'nothing left to move');
    assert.deepEqual(c.list().map((s) => [s.status, s.payoutId]), [['paying', 'PAYOUT-1'], ['paying', 'PAYOUT-1']]);
  });
  test('settle marks a payout paid; release puts its rows back to owed with no payout', () => {
    const { c } = two();
    c.markPaying(c.owed().ids, 'PAYOUT-1', T0 + 1);
    assert.equal(c.settle('PAYOUT-1', T0 + 2), 2);
    assert.ok(c.list().every((s) => s.status === 'paid' && s.payoutId === 'PAYOUT-1'));
    const w = two();
    w.c.markPaying(w.c.owed().ids, 'PAYOUT-9', T0 + 1);
    assert.equal(w.c.release('PAYOUT-9', T0 + 2), 2);
    assert.equal(w.c.owed().count, 2); assert.ok(w.c.list().every((s) => s.payoutId === null));
  });
  test('encumbered = owed + paying: what the restock must never spend', () => {
    const { c } = two();
    assert.equal(c.encumberedUnits(), 950_000 + 380_000 + 1_265_000 + 506_000);
    c.markPaying([c.owed().ids[0]], 'PAYOUT-1', T0 + 1);
    assert.equal(c.encumberedUnits(), 950_000 + 380_000 + 1_265_000 + 506_000, 'paying still counts');
    c.settle('PAYOUT-1', T0 + 2);
    assert.ok(c.encumberedUnits() < 950_000 + 380_000 + 1_265_000 + 506_000);
    const { c: none } = make();
    assert.equal(none.encumberedUnits(), 0);
  });
  test('reconcile: paying rows whose payout landed are paid, whose payout failed or is unknown go back to owed, whose payout is still sent wait', () => {
    const w = make(); const { c, db } = w;
    for (const [id, st] of [['A', 'landed'], ['B', 'failed'], ['C', 'sent']]) db.prepare("INSERT INTO vault_fee_claims (id, vault, curve_units, pool_units, onix_units, treasury_units, tx_b64, sig, status, created_at, updated_at) VALUES (?, ?, 0, 0, 0, 0, 'x', ?, ?, ?, ?)").run(id, CUSTODY, 'SIG' + id, st, T0, T0);
    for (const [ref, payout] of [['P1', 'A'], ['P2', 'B'], ['P3', 'C'], ['P4', 'GONE']]) { c.recordSale({ source: 'play', refId: ref, mint: 'M', priceUsd: 10, at: T0 }); c.markPaying([c.owed().ids[0]], payout, T0); }
    assert.deepEqual(c.reconcile(T0 + 1), { paid: 1, released: 2, waiting: 1 });
    const st = Object.fromEntries(c.list().map((s) => [s.refId, s.status]));
    assert.deepEqual(st, { P1: 'paid', P2: 'owed', P3: 'paying', P4: 'owed' });
  });
  test('the ledger is per vault: another vault\'s sales are neither owed nor encumbered here', () => {
    const { c, db } = two();
    const other = createCommissions({ db, vaultWallet: Keypair.generate().publicKey.toBase58(), creator: CREATOR, now: () => T0, log: { warn: () => {} } });
    assert.equal(other.owed().count, 0); assert.equal(other.encumberedUnits(), 0); assert.equal(other.list().length, 0);
    assert.equal(other.markPaying(c.owed().ids, 'X', T0), 0, 'cannot move another vault\'s rows');
    assert.equal(c.list().length, 2);
  });
  test('list() carries the payout signature once the claim exists, for the Activity tab', () => {
    const { c, db } = two();
    c.markPaying(c.owed().ids, 'PAYOUT-1', T0 + 1);
    db.prepare("INSERT INTO vault_fee_claims (id, vault, curve_units, pool_units, onix_units, treasury_units, tx_b64, sig, status, created_at, updated_at) VALUES ('PAYOUT-1', ?, 0, 0, 886000, 0, 'x', 'SIGP', 'sent', ?, ?)").run(CUSTODY, T0, T0);
    const [s] = c.list();
    assert.equal(s.payoutSignature, 'SIGP'); assert.equal(s.priceUsd, 25.3); assert.equal(s.creatorUsd, 1.265); assert.equal(s.onixUsd, 0.506); assert.equal(s.treasuryUsd, 23.529);
  });
});

describe('summaries — what the Activity tab joins by source and reference', () => {
  test('source:refId → the split, the status and the payout', () => {
    const { c, db } = make();
    c.recordSale({ source: 'play', refId: 'P1', mint: 'M1', priceUsd: 19, at: T0 });
    c.markPaying(c.owed().ids, 'PAYOUT-1', T0 + 1);
    db.prepare("INSERT INTO vault_fee_claims (id, vault, curve_units, pool_units, onix_units, treasury_units, tx_b64, sig, status, created_at, updated_at) VALUES ('PAYOUT-1', ?, 0, 0, 380000, 0, 'x', 'SIGP', 'sent', ?, ?)").run(CUSTODY, T0, T0);
    // a sale from before the rule owes nothing and is not joined: the page never shows it a split
    db.prepare("INSERT INTO vault_sales (id, vault, source, ref_id, mint, price_units, creator_units, onix_units, treasury_units, status, created_at, updated_at) VALUES ('pre', ?, 'play', 'P-old', 'M', 19000000, 0, 0, 19000000, 'pre_rule', ?, ?)").run(CUSTODY, T0, T0);
    assert.deepEqual(c.summaries(), { 'play:P1': { creatorUsd: 0.95, onixUsd: 0.38, treasuryUsd: 17.67, status: 'paying', payoutId: 'PAYOUT-1', payoutSignature: 'SIGP' } });
  });
});

describe('the page says what the module does', () => {
  test('web/index.html and web/app.js carry the published split, so the numbers cannot drift from the code', () => {
    const fs = require('fs'), path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
    const line = html.match(/<b>On every sale<\/b><span[^>]*>([^<]*)<\/span>/);
    assert.ok(line, 'the deal has a line about sales');
    assert.match(line[1], new RegExp(`${SALE_SPLIT.creator}% .*${SALE_SPLIT.onix}% .*${SALE_SPLIT.treasury}%`));
    assert.match(line[1], /every 15 minutes/);
    assert.ok(js.includes(`${SALE_SPLIT.treasury}% stays in the vault`), 'the Play button says how much stays');
    assert.ok(js.includes('Where each sale goes'), 'the Proof tab has the box');
    assert.ok(!js.includes('EXPLAIN_LONG'), 'no dead branch in front of the box: renderExplain has one path and it renders it');
    assert.match(js, new RegExp('S\\.cash \\+= it\\.v \\* ' + SALE_SPLIT.treasury / 100), 'the simulated day credits the treasury its share of a sale, not the whole price');
    const play = html.match(/<dt><a href="#\/">Play<\/a><\/dt><dd>([^<]*)<\/dd>/);
    assert.ok(play && play[1].includes(`${SALE_SPLIT.treasury}%`), 'How it works says what a USDC play leaves in the treasury');
    const first = require('./openapi.json').info.description.split('\n')[0];
    assert.ok(!/USDC stays in the vault/.test(first) && first.includes(`${SALE_SPLIT.treasury}%`), "the contract's opening sentence carries the split, not the rule before it");
  });
});
