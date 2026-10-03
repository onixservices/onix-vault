const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction, SystemProgram, PublicKey } = require('@solana/web3.js');
const { getTestDb } = require('./db');
const { createRestock, decide, listingView, listingPassesRules, RESTOCK } = require('./restock');
const { fromKeypair } = require('./signer');

// The treasury buys the next item: the rules decide, the custody key signs, the chain confirms.
const custodyKp = Keypair.generate();
const CUSTODY = custodyKp.publicKey.toBase58();
const RULES = { custodians: ['Collector Crypt'], category: 'mixed', minValueUsd: 0, minGrade: 'any' };
const row = (mint, price, insured, over = {}) => ({ nftAddress: mint, itemName: 'Card ' + mint, category: 'Pokemon', grade: 'GEM MINT 10', gradingCompany: 'CGC', insuredValue: insured, listing: { price, marketplace: 'CC' }, images: { frontM: 'http://img/' + mint }, owner: { wallet: 'SELLER' }, ...over });
const L = (...a) => listingView(row(...a));

describe('restock — the decision is pure', () => {
  test('the cheapest price-to-index that passes the rules, the caps and the budget; every rejection counted by reason', () => {
    const listings = [
      L('a', 20, 18),                                     // above the index → out
      L('b', 15, 20),                                     // 0.75× — the pick
      L('c', 16, 20),                                     // 0.80×
      L('d', 200, 400),                                   // above the per-item cap
      L('e', 3, 10),                                      // below the venue minimum
      L('f', 15, 20, { listing: { price: 15, marketplace: 'ME' } }),   // a mirror, not the custodian's market
      L('g', 15, 20, { insuredValue: '' }),               // no insured value
      L('h', 90, 100),                                    // above the budget
      L('i', 15, 20),                                     // already in custody
      L('j', 10, 25, { itemName: 'moonbirds physical collectible (pre-order)', grade: null, gradingCompany: null }),   // filler, not graded
      L('k', 10, 25, { itemName: 'Mystery slab box' }),   // graded fields present but a box
    ];
    const d = decide({ budgetUsd: 50, rules: RULES, listings, exclude: new Set(['i']) });
    assert.equal(d.pick.mint, 'b'); assert.equal(d.pick.ratio, 0.75); assert.match(d.why, /cheapest fit/);
    assert.equal(d.considered, 11);
    assert.deepEqual(d.rejected, { 'above 1× the index': 1, 'above the per-item cap ($150)': 1, 'below the venue minimum ($5)': 1, "not on the custodian's own market": 1, 'no insured value': 1, 'above the budget': 1, 'already in custody or pending': 1, 'not a graded card': 1, 'not a single graded card (filler)': 1 });
  });
  test('the creator\'s rules apply: category, minimum value, minimum grade', () => {
    const rules = { ...RULES, category: 'one-piece', minValueUsd: 25, minGrade: 9 };
    assert.equal(listingPassesRules(L('a', 20, 30), rules).reason, 'not one-piece');
    assert.equal(listingPassesRules(L('a', 20, 24, { category: 'One Piece' }), rules).reason, "below the vault's minimum value ($25)");
    assert.equal(listingPassesRules(L('a', 20, 30, { category: 'One Piece', grade: 'NM/MINT 8' }), rules).reason, "below the vault's minimum grade (9)");
    assert.equal(listingPassesRules(L('a', 20, 30, { category: 'One Piece', grade: 'MINT 9' }), rules).ok, true);
  });
  test("the creator's own restock rule overrides the entry rule for what the treasury buys (category, min/max value, grade)", () => {
    const { buyRules } = require('./restock');
    const entry = { ...RULES, category: 'mixed', minValueUsd: 0, minGrade: 'any', restock: { category: 'one-piece', minValueUsd: 25, maxValueUsd: 100, minGrade: 9 } };
    assert.deepEqual(buyRules(entry), { ...entry, category: 'one-piece', minValueUsd: 25, maxValueUsd: 100, minGrade: 9 });
    const listings = [L('p', 15, 30), L('o1', 20, 30, { category: 'One Piece', grade: 'MINT 9' }), L('o2', 80, 150, { category: 'One Piece', grade: 'MINT 9' }), L('o3', 20, 30, { category: 'One Piece', grade: 'NM 8' })];
    const d = decide({ budgetUsd: 200, rules: entry, listings });
    assert.equal(d.pick.mint, 'o1');
    assert.deepEqual(d.rejected, { 'not one-piece': 1, 'above the restock ceiling ($100)': 1, "below the vault's minimum grade (9)": 1 });
    assert.equal(decide({ budgetUsd: 200, rules: { ...RULES, restock: 'sameAsEntry' }, listings }).pick.mint, 'p', 'sameAsEntry: the entry rule (any graded card), cheapest ratio wins (p 0.5×)');
  });
  test('nothing fits → says why (budget below minimum, or the market)', () => {
    assert.match(decide({ budgetUsd: 2, rules: RULES, listings: [L('a', 10, 20)] }).why, /treasury below the minimum buy/);
    assert.match(decide({ budgetUsd: 50, rules: RULES, listings: [L('a', 30, 20)] }).why, /nothing on the market fits \(1 listings/);
  });
});

function make({ usdc = 40, listings = [row('b', 15, 20), row('c', 16, 20)], sponsored = false, simErr = null, inCustody = [] } = {}) {
  const db = getTestDb();
  const sent = [];
  const chain = {
    simulateTransaction: async () => ({ err: simErr, logs: simErr ? ['Program log: Error: nope'] : [] }),
    sendRawTransaction: async (b64) => { sent.push(b64); return 'sig'; },
    getSignatureStatuses: async (sigs) => sigs.map((s) => chain.statuses[s] || null), statuses: {},
  };
  const owners = {};
  const otherKp = Keypair.generate();
  const buildBuyTx = async ({ mint, wallet }) => {
    const tx = new Transaction({ feePayer: new PublicKey(wallet), recentBlockhash: Keypair.generate().publicKey.toBase58() });
    tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(wallet), toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    if (sponsored) { tx.add(SystemProgram.transfer({ fromPubkey: otherKp.publicKey, toPubkey: new PublicKey(wallet), lamports: 1 })); tx.partialSign(otherKp); }
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  };
  let t = 1_800_000_000_000;
  const rs = createRestock({ db, chain, vaultWallet: CUSTODY, signer: fromKeypair(custodyKp), rules: RULES, readItems: async () => inCustody.map((m) => ({ mint: m })),
    fetchListings: async ({ page }) => (page === 1 ? { filterNFtCard: listings } : { filterNFtCard: [] }), buildBuyTx, getUsdcBalance: async () => usdc, ownerOf: async (m) => owners[m] || null, now: () => t, log: { warn: () => {} } });
  return { rs, db, chain, sent, owners, tick: (ms) => { t += ms; } };
}

describe('restock — execute and confirm', () => {
  test('custody without enough SOL buys nothing and says so (the venue would hand a sponsored transaction)', async () => {
    const w = make(); const db = w.db;
    const rs = createRestock({ db, chain: w.chain, vaultWallet: CUSTODY, signer: fromKeypair(custodyKp), rules: RULES, readItems: async () => [], fetchListings: async () => ({ filterNFtCard: [] }), buildBuyTx: async () => '', getUsdcBalance: async () => 40, getSolBalance: async () => 0.017, ownerOf: async () => null, log: { warn: () => {} } });
    const p = await rs.plan();
    assert.equal(p.pick, null); assert.match(p.why, /0\.0170 SOL; the venue needs ≥ 0\.05 SOL/);
  });
  test('plan reads the treasury, excludes custody, picks; dry execute asserts and simulates but signs nothing', async () => {
    const w = make({ inCustody: ['b'] });
    const p = await w.rs.plan();
    assert.equal(p.treasuryUsd, 40); assert.equal(p.budgetUsd, 39); assert.equal(p.pick.mint, 'c');
    const x = await w.rs.execute();
    assert.equal(x.dry, true); assert.equal(x.simulated, true); assert.equal(w.sent.length, 0);
    assert.equal(w.db.prepare('SELECT count(*) n FROM vault_purchases').get().n, 0);
  });
  test('go: signed by the custody key, PERSISTED before broadcast, then sent; a second run within the hour buys nothing', async () => {
    const w = make();
    const x = await w.rs.execute({ go: true });
    assert.equal(x.bought.mint, 'b'); assert.equal(x.bought.priceUsd, 15); assert.ok(x.bought.signature);
    assert.equal(w.sent.length, 1);
    const r = w.db.prepare('SELECT * FROM vault_purchases').get();
    assert.equal(r.status, 'sent'); assert.equal(r.sig, x.bought.signature);
    assert.ok(Transaction.from(Buffer.from(r.tx_b64, 'base64')).verifySignatures(), 'the persisted transaction is fully signed');
    const again = await w.rs.plan();
    assert.equal(again.pick, null); assert.match(again.why, /one an hour/);
  });
  test('a sponsored (pre-signed, two-signer) buy from the venue is refused; a buy that fails simulation is refused; neither is signed', async () => {
    await assert.rejects(make({ sponsored: true }).rs.execute({ go: true }), (e) => e.statusCode === 409 && /assertions/.test(e.message));
    await assert.rejects(make({ simErr: { InstructionError: [0, 'x'] } }).rs.execute({ go: true }), (e) => e.statusCode === 409 && /fail on chain/.test(e.message));
  });
  test('confirm: finalized + the chain shows custody owns it → manifest + landed; an error → failed; unknown for long → failed; otherwise pending (rebroadcast)', async () => {
    const w = make();
    const x = await w.rs.execute({ go: true });
    assert.deepEqual(await w.rs.confirm(), { landed: 0, failed: 0, pending: 1 });
    assert.equal(w.sent.length, 2, 'unknown status → rebroadcast of the same transaction');
    w.chain.statuses[x.bought.signature] = { confirmationStatus: 'confirmed', err: null };
    assert.deepEqual(await w.rs.confirm(), { landed: 0, failed: 0, pending: 1 });
    w.chain.statuses[x.bought.signature] = { confirmationStatus: 'finalized', err: null };
    assert.deepEqual(await w.rs.confirm(), { landed: 0, failed: 0, pending: 1 }, 'finalized but DAS does not show custody yet');
    w.owners.b = CUSTODY;
    assert.deepEqual(await w.rs.confirm(), { landed: 1, failed: 0, pending: 0 });
    assert.equal(w.db.prepare("SELECT source FROM vault_items WHERE vault = ? AND mint = 'b'").get(CUSTODY).source, 'restock');
    assert.equal(w.rs.list()[0].status, 'landed');
    // a failed one
    const w2 = make();
    const y = await w2.rs.execute({ go: true });
    w2.chain.statuses[y.bought.signature] = { confirmationStatus: 'finalized', err: { InstructionError: [0, { Custom: 1 }] } };
    assert.deepEqual(await w2.rs.confirm(), { landed: 0, failed: 1, pending: 0 });
    // a lost one
    const w3 = make();
    await w3.rs.execute({ go: true });
    w3.tick(RESTOCK.pendingTtlMs + 1);
    assert.deepEqual(await w3.rs.confirm(), { landed: 0, failed: 1, pending: 0 });
    assert.equal(w3.rs.list()[0].failReason, 'never landed');
  });
});
