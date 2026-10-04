const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction, SystemProgram, PublicKey, TransactionInstruction, ComputeBudgetProgram } = require('@solana/web3.js');
const { getTestDb } = require('./db');
const { createRestock, decide, listingView, listingPassesRules, RESTOCK, CC_MARKETPLACE_PROGRAM, MPL_CORE_PROGRAM } = require('./restock');
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

const { AccountLayout } = require('@solana/spl-token');
const tokenAccount = (units) => { const b = Buffer.alloc(AccountLayout.span); b.writeBigUInt64LE(BigInt(units), 64); return [b.toString('base64'), 'base64']; };
const ccKp = Keypair.generate();
// A buy in the shape Collector Crypt hands it (measured on mainnet, 3 Oct 2026): ComputeBudget price, ONE marketplace
// `buy` (discriminator a9e357ff4c56ff19 + u64), the co-signer's noop. The simulation answers for the custody's USDC,
// its SOL, and the bought item (an MPL Core asset: byte 0 = 1, owner in bytes 1..33).
const BUY_DISC = Buffer.from('a9e357ff4c56ff19', 'hex');
const NOOP = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
const SOL_PRE = 50_000_000;
const coreAsset = (owner) => { const b = Buffer.alloc(1 + 32 + 33); b[0] = 1; new PublicKey(owner).toBuffer().copy(b, 1); return [b.toString('base64'), 'base64']; };

function make({ usdc = 40, listings = [row('b', 15, 20), row('c', 16, 20)], sponsored = false, simErr = null, inCustody = [], cosigned = false, debitUsd = null,
  priorityMicroLamports = 10_000, cuLimit = null, buys = 1, buyDisc = BUY_DISC, extra = null, solSpent = 14_030, solReadable = true,
  itemOwner = CUSTODY, itemProgram = MPL_CORE_PROGRAM } = {}) {
  const db = getTestDb();
  const sent = [];
  const chain = {
    simulateTransaction: async () => ({ err: simErr, logs: simErr ? ['Program log: Error: nope'] : [] }),
    getTokenAccountAmount: async () => usdc * 1e6,
    getBalanceLamports: async () => SOL_PRE,
    // after the simulated buy: the treasury falls by the listing price (unless the test says otherwise), the SOL by the fee, the item is the custody's
    simulateWithAccounts: async () => ({ err: simErr, logs: simErr ? ['Program log: Error: nope'] : [], accounts: [
      { data: tokenAccount(Math.round((usdc - (debitUsd ?? chain.lastPrice)) * 1e6)) },
      solReadable ? { lamports: SOL_PRE - solSpent } : null,
      { owner: itemProgram, data: coreAsset(itemOwner) },
    ] }), lastPrice: 0,
    sendRawTransaction: async (b64) => { sent.push(b64); return 'sig'; },
    getSignatureStatuses: async (sigs) => sigs.map((s) => chain.statuses[s] || null), statuses: {},
  };
  const owners = {};
  const otherKp = Keypair.generate();
  const buildBuyTx = async ({ wallet, priceUsd }) => {
    chain.lastPrice = priceUsd;
    const buyer = new PublicKey(wallet);
    const tx = new Transaction({ feePayer: buyer, recentBlockhash: Keypair.generate().publicKey.toBase58() });
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));
    if (cuLimit) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    for (let i = 0; i < buys; i++) tx.add(new TransactionInstruction({ programId: new PublicKey(CC_MARKETPLACE_PROGRAM), keys: [{ pubkey: buyer, isSigner: true, isWritable: true }], data: Buffer.concat([buyDisc, Buffer.alloc(8)]) }));
    const cosigner = sponsored ? otherKp : cosigned ? ccKp : null;
    if (cosigner) tx.add(new TransactionInstruction({ programId: NOOP, keys: [{ pubkey: cosigner.publicKey, isSigner: true, isWritable: false }], data: Buffer.alloc(0) }));
    if (extra) extra(tx, buyer);
    if (cosigner) tx.partialSign(cosigner);
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  };
  let t = 1_800_000_000_000;
  const rs = createRestock({ db, chain, vaultWallet: CUSTODY, signer: fromKeypair(custodyKp), rules: RULES, cosigners: [ccKp.publicKey.toBase58()], readItems: async () => inCustody.map((m) => ({ mint: m })),
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
  test("the venue's known co-signer, already signed, is accepted and the buy goes through; the debit is measured", async () => {
    const w = make({ cosigned: true });
    const x = await w.rs.execute({ go: true });
    assert.equal(x.bought.mint, 'b'); assert.equal(x.debitUsd, 15);
    assert.ok(Transaction.from(Buffer.from(w.db.prepare('SELECT tx_b64 FROM vault_purchases').get().tx_b64, 'base64')).verifySignatures(), 'custody + the venue, both signed');
  });
  test('a simulated debit above the listing price, or none at all, is refused and nothing is signed', async () => {
    await assert.rejects(make({ debitUsd: 25 }).rs.execute({ go: true }), (e) => e.statusCode === 409 && /debits \$25, the listing says \$15/.test(e.message));
    await assert.rejects(make({ debitUsd: 0 }).rs.execute({ go: true }), (e) => e.statusCode === 409 && /does not debit/.test(e.message));
  });
  test('an UNKNOWN extra signer (a sponsored variant) is refused; a buy that fails simulation is refused; neither is signed', async () => {
    await assert.rejects(make({ sponsored: true }).rs.execute({ go: true }), (e) => e.statusCode === 409 && /not a known co-signer/.test(e.message));
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

describe('restock — only the measured shape of a buy is ever signed', () => {
  // each case: refused with 409, nothing sent, nothing persisted
  const refused = async (opts, re) => {
    const w = make(opts);
    await assert.rejects(w.rs.execute({ go: true }), (e) => e.statusCode === 409 && re.test(e.message));
    assert.equal(w.sent.length, 0);
    assert.equal(w.db.prepare('SELECT count(*) n FROM vault_purchases').get().n, 0);
  };
  test('the measured shape passes: ComputeBudget + one marketplace buy + the co-signer noop', async () => {
    const x = await make({ cosigned: true, cuLimit: 200_000 }).rs.execute();
    assert.equal(x.dry, true); assert.equal(x.simulated, true);
  });
  test('an added instruction of any other program is refused (System transfer, Token approve)', async () => {
    const { createApproveInstruction } = require('@solana/spl-token');
    await refused({ cosigned: true, extra: (tx, buyer) => tx.add(SystemProgram.transfer({ fromPubkey: buyer, toPubkey: Keypair.generate().publicKey, lamports: 1 })) }, /not a plain buy: program/);
    await refused({ cosigned: true, extra: (tx, buyer) => tx.add(createApproveInstruction(Keypair.generate().publicKey, Keypair.generate().publicKey, buyer, 1n)) }, /not a plain buy: program/);
  });
  test('two marketplace buys, none, or a marketplace instruction other than buy are refused', async () => {
    await refused({ buys: 2 }, /not a plain buy: shape .*at most 1/);
    await refused({ buys: 0 }, /not a plain buy: shape .*expected 1/);
    await refused({ buyDisc: Buffer.from('0000000000000000', 'hex') }, /not a plain buy: instruction/);
  });
  test('a priority fee above the cap is refused', async () => {
    await refused({ priorityMicroLamports: 10_000_000, cuLimit: 200_000 }, /priority fee of 2000000 lamports/);
  });
  test("the custody's SOL: falling by more than the fee and one rent is refused; unreadable is refused", async () => {
    await refused({ solSpent: RESTOCK.maxSolSpendLamports + 1 }, /takes \d+ lamports from the custody/);
    await refused({ solReadable: false }, /could not read the custody's SOL/);
  });
  test('after the simulated buy the item must be an MPL Core asset owned by the custody', async () => {
    await refused({ itemOwner: Keypair.generate().publicKey.toBase58() }, /item is not in custody \(owner /);
    await refused({ itemProgram: SystemProgram.programId.toBase58() }, /not readable as an MPL Core asset/);
  });
});
