const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const BN = require('bn.js');
const { Keypair, PublicKey, Transaction, SystemProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, AccountLayout, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { getTestDb } = require('./db');
const { createFeeClaim, FEECLAIM } = require('./feeclaim');
const { createCommissions } = require('./commissions');
const { fromKeypair } = require('./signer');
const { POOL_LAYOUT } = require('../src/reader/pool');

// The trading fees reach the treasury: curve partner fee (2/3 treasury · 1/3 Onix in the same tx) + the pool LP fee.
// Since 11 Oct 2026 the same transaction pays the sales owed: 5% of every card sold to the creator, 2% to Onix.
const custodyKp = Keypair.generate();
const CUSTODY = custodyKp.publicKey.toBase58();
const USDC = Keypair.generate().publicKey.toBase58();
const ONIX = Keypair.generate().publicKey.toBase58();
const POOL = Keypair.generate().publicKey.toBase58();
const CREATOR = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
const CUSTODY_ATA = getAssociatedTokenAddressSync(new PublicKey(USDC), custodyKp.publicKey, true).toBase58();
const CREATOR_ATA = getAssociatedTokenAddressSync(new PublicKey(USDC), new PublicKey(CREATOR), true).toBase58();
const T0 = 1_800_000_000_000;
const THIRD = 1_264_117;   // Onix's third of a 3_792_354 curve fee, floored

/** A token account as the simulation hands it back: the 165-byte layout, base64. */
function tokenAcct(units, { owner = PublicKey.default, mint = PublicKey.default } = {}) {
  const b = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner, amount: BigInt(Math.max(0, Math.round(units))), delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, b);
  return [b.toString('base64'), 'base64'];
}
function poolAccount(partnerQuoteFee) {
  const b = Buffer.alloc(424); b.writeBigUInt64LE(BigInt(partnerQuoteFee), POOL_LAYOUT.partnerQuoteFee);
  return { data: [b.toString('base64'), 'base64'] };
}
const ixsOf = (b64) => Transaction.from(Buffer.from(b64, 'base64')).instructions;
/** The USDC transfers in a transaction: [destination, units]. */
const transfersOf = (b64) => ixsOf(b64).filter((ix) => ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 12).map((ix) => [ix.keys[2].pubkey.toBase58(), Number(ix.data.readBigUInt64LE(1))]);
const ataCreatesOf = (b64) => ixsOf(b64).filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).map((ix) => ix.keys[1].pubkey.toBase58());

/**
 * The chain, faked: the curve fee is claimed by a System transfer of 1 lamport (the pool fee: 2 lamports) standing in
 * for Meteora's claim; the simulation APPLIES the transaction's instructions to the balances, so what it answers is
 * what the transaction does — not what the plan says.
 */
function make({ curve = 3_792_354, pool = 0, simShift = 0, shift = {}, creator = null, sales = [], salesCreator, creatorAtaExists = true, creatorReadable = true, creatorOwner = null, creatorMint = null,
  solPre = 50_000_000, solSpent = 5_000, solReadable = true, payoutEnabled = true, onixAccount = ONIX, claimIxs = 1, simErr = null } = {}) {
  const db = getTestDb(); const sent = [];
  let t = T0;
  const mkCommissions = (c) => createCommissions({ db, vaultWallet: CUSTODY, creator: c, now: () => t, log: { warn: () => {} } });
  const commissions = mkCommissions(creator);
  // the sales were made under this creator (by default the registered one): the ledger snapshots it
  const recorder = salesCreator === undefined ? commissions : mkCommissions(salesCreator);
  sales.forEach((usd, i) => recorder.recordSale({ source: 'play', refId: 'P' + i, mint: 'M' + i, priceUsd: usd, at: t }));
  const bal = { [CUSTODY_ATA]: 10_000_000, [onixAccount]: 5_000_000, ...(creatorAtaExists ? { [CREATOR_ATA]: 1_000_000 } : {}) };
  const post = (a, after) => {
    if (a === CUSTODY) return solReadable ? { lamports: solPre - solSpent } : null;
    if (a === CREATOR_ATA) return creatorReadable ? { data: tokenAcct(after[a] || 0, { owner: new PublicKey(creatorOwner || CREATOR), mint: new PublicKey(creatorMint || USDC) }) } : null;
    return { data: tokenAcct(after[a] || 0) };
  };
  const chain = {
    getAccountInfoBase64: async () => poolAccount(curve),
    getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(),
    getTokenAccountAmount: async (a) => { if (bal[a] == null) throw new Error('could not find account'); return bal[a]; },
    getBalanceLamports: async () => solPre,
    simulateWithAccounts: async (b64, addrs) => {
      const after = { ...bal }; const add = (a, u) => { after[a] = (after[a] || 0) + u; };
      for (const ix of ixsOf(b64)) {
        if (ix.programId.equals(SystemProgram.programId)) { const l = Number(ix.data.readBigUInt64LE(4)); if (l === 1) add(CUSTODY_ATA, curve); if (l === 2) add(CUSTODY_ATA, pool); }
        if (ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 12) { const u = Number(ix.data.readBigUInt64LE(1)); add(ix.keys[0].pubkey.toBase58(), -u); add(ix.keys[2].pubkey.toBase58(), u); }
      }
      add(CUSTODY_ATA, simShift); add(CREATOR_ATA, shift.creator || 0); add(onixAccount, shift.onix || 0);
      return { err: simErr, logs: simErr ? ['Program log: Error: nope'] : [], accounts: addrs.map((a) => post(a, after)) };
    },
    sendRawTransaction: async (b64) => { sent.push(b64); },
    getSignatureStatuses: async (s) => s.map((x) => chain.statuses[x] || null), statuses: {},
  };
  const claim = (lamports) => { const tx = new Transaction(); for (let i = 0; i < claimIxs; i++) tx.add(SystemProgram.transfer({ fromPubkey: custodyKp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: i === 0 ? lamports : 7 })); return tx; };
  const build = (c = commissions) => createFeeClaim({
    db, chain, vaultWallet: CUSTODY, signer: fromKeypair(custodyKp), pool: POOL, usdcMint: USDC, onixUsdcAccount: onixAccount, commissions: c, payoutEnabled,
    getDbcClient: async () => ({ partner: { claimPartnerTradingFee: async (a) => { assert.equal(a.feeClaimer.toBase58(), CUSTODY); return claim(1); } } }),
    getCpAmm: async () => ({
      getPositionsByUser: async () => (pool ? [{ position: Keypair.generate().publicKey, positionNftAccount: Keypair.generate().publicKey, positionState: { pool: new PublicKey(POOL) } }] : []),
      fetchPoolState: async () => ({ tokenAMint: Keypair.generate().publicKey, tokenBMint: new PublicKey(USDC), tokenAVault: Keypair.generate().publicKey, tokenBVault: Keypair.generate().publicKey, tokenAFlag: 0, tokenBFlag: 0 }),
      claimPositionFee2: async (a) => { assert.equal(a.receiver.toBase58(), CUSTODY); return claim(2); },
    }),
    getUnClaimLpFee: () => ({ feeTokenA: new BN(0), feeTokenB: new BN(pool) }),
    getTokenProgram: () => new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    now: () => t, log: { warn: () => {} },
  });
  const fc = build();
  const claims = () => db.prepare('SELECT * FROM vault_fee_claims ORDER BY created_at').all();
  return { fc, db, chain, sent, commissions, claims, tick: (ms) => { t += ms; }, another: (c) => build(c === undefined ? mkCommissions(creator) : c) };
}
const land = async (w, sig, err = null) => { w.chain.statuses[sig] = { confirmationStatus: 'finalized', err }; return w.fc.confirm(); };

describe('feeclaim — plan', () => {
  test('curve fee: 1/3 to Onix (floored), the rest to the treasury; pool fee below $1 waits', async () => {
    const p = await make({ curve: 3_792_354, pool: 300_840 }).fc.plan();
    assert.equal(p.takeCurve, true); assert.equal(p.takePool, false);
    assert.equal(p.onixUnits, THIRD); assert.equal(p.treasuryUnits, 3_792_354 - THIRD);
    assert.equal(p.takeSales, false); assert.equal(p.creatorUnits, 0); assert.equal(p.salesCount, 0);
  });
  test('the pool LP fee goes 100% to the treasury; nothing worth a claim says why', async () => {
    const a = await make({ curve: 0, pool: 2_000_000 }).fc.plan();
    assert.equal(a.takePool, true); assert.equal(a.onixUnits, 0); assert.equal(a.treasuryUnits, 2_000_000);
    const b = await make({ curve: 500_000, pool: 100 }).fc.plan();
    assert.match(b.why, /nothing worth a claim yet/);
  });
  test("sales owed join the plan: the creator's 5%, Onix's third of the curve plus 2% of the sales, the treasury net of both; sales alone make a claim", async () => {
    const p = await make({ curve: 3_792_354, sales: [19, 25.3], creator: CREATOR }).fc.plan();
    assert.equal(p.takeSales, true); assert.equal(p.salesCount, 2);
    assert.equal(p.creatorUnits, 950_000 + 1_265_000); assert.equal(p.salesOnixUnits, 380_000 + 506_000);
    assert.equal(p.onixUnits, THIRD + 886_000); assert.equal(p.treasuryUnits, 3_792_354 - THIRD - 2_215_000 - 886_000);
    assert.equal(p.creatorWallet, CREATOR); assert.equal(p.why, null);
    const s = await make({ curve: 0, sales: [19], creator: CREATOR }).fc.plan();
    assert.equal(s.takeCurve, false); assert.equal(s.takeSales, true); assert.equal(s.why, null);
    assert.equal(s.onixUnits, 380_000); assert.equal(s.creatorUnits, 950_000); assert.equal(s.treasuryUnits, -(950_000 + 380_000));
  });
  test('without a registered creator the 5% stayed in the treasury: no creator leg, Onix still paid', async () => {
    const p = await make({ curve: 0, sales: [19], creator: null }).fc.plan();
    assert.equal(p.creatorUnits, 0); assert.equal(p.creatorWallet, null); assert.equal(p.onixUnits, 380_000); assert.equal(p.treasuryUnits, -380_000); assert.equal(p.takeSales, true);
  });
  test('payout switched off: the fees are claimed as before, the owed sales wait and are named when nothing else is claimable', async () => {
    const off = await make({ curve: 0, sales: [19], creator: CREATOR, payoutEnabled: false }).fc.plan();
    assert.equal(off.takeSales, false); assert.match(off.why, /1 sale\(s\) owe \$1\.33/); assert.match(off.why, /disabled/);
    const fees = await make({ curve: 3_792_354, sales: [19], creator: CREATOR, payoutEnabled: false }).fc.plan();
    assert.equal(fees.takeCurve, true); assert.equal(fees.takeSales, false); assert.equal(fees.creatorUnits, 0); assert.equal(fees.onixUnits, THIRD); assert.equal(fees.treasuryUnits, 3_792_354 - THIRD); assert.equal(fees.why, null);
  });
  test('sales that name another creator than the one registered stop the payout (409) until the operator reconciles the ledger', async () => {
    await assert.rejects(make({ sales: [19], creator: CREATOR, salesCreator: OTHER }).fc.plan(), (e) => e.statusCode === 409 && /registered creator/.test(e.message));
    await assert.rejects(make({ sales: [19], creator: null, salesCreator: CREATOR }).fc.plan(), (e) => e.statusCode === 409);
    // sales made while no creator was registered (their 5% stayed) are no conflict for a creator registered since
    assert.equal((await make({ curve: 0, sales: [19], creator: CREATOR, salesCreator: null }).fc.plan()).creatorUnits, 0);
  });
});

describe('feeclaim — execute and confirm', () => {
  test('dry: one tx, the custody the only signer, simulated with both balances measured; go: signed, persisted, sent', async () => {
    const w = make({ curve: 3_792_354, pool: 2_000_000 });
    const d = await w.fc.execute();
    assert.equal(d.dry, true); assert.equal(d.treasuryDelta, d.treasuryUnits); assert.equal(d.onixDelta, THIRD); assert.equal(w.sent.length, 0);
    const g = await w.fc.execute({ go: true });
    assert.ok(g.claimed.signature); assert.equal(w.sent.length, 1);
    const r = w.db.prepare('SELECT * FROM vault_fee_claims').get();
    assert.equal(r.status, 'sent'); assert.equal(r.onix_units, THIRD); assert.equal(r.creator_units, 0); assert.equal(r.sales_count, 0);
    assert.ok(Transaction.from(Buffer.from(r.tx_b64, 'base64')).verifySignatures());
    assert.deepEqual(await land(w, g.claimed.signature), { landed: 1, failed: 0, pending: 0 });
    assert.equal(w.fc.list()[0].status, 'landed');
  });
  test('a simulation that moves the treasury by anything but the plan is refused and nothing is signed', async () => {
    const w = make({ simShift: -500_000 });
    await assert.rejects(w.fc.execute({ go: true }), (e) => e.statusCode === 409 && /moves the treasury/.test(e.message));
    assert.equal(w.sent.length, 0);
  });
  test("a fee claim without sales never needs the custody's SOL (the path that ran before the sales ledger)", async () => {
    const w = make({ solReadable: false });
    w.chain.getBalanceLamports = async () => { throw new Error('must not be asked'); };
    assert.equal((await w.fc.execute()).dry, true);
  });
  test("with sales: the creator's account is created when missing and paid, Onix gets its third plus 2%, every leg measured; go persists the claim with the legs and moves the sales to paying in the same write; landed → paid", async () => {
    const w = make({ curve: 3_792_354, sales: [19], creator: CREATOR, creatorAtaExists: false });
    const d = await w.fc.execute();
    assert.equal(d.dry, true); assert.equal(d.creatorDelta, 950_000); assert.equal(d.onixDelta, THIRD + 380_000); assert.equal(d.treasuryDelta, 3_792_354 - THIRD - 950_000 - 380_000); assert.equal(d.solSpent, 5_000);
    assert.equal(w.sent.length, 0); assert.equal(w.commissions.owed().count, 1, 'a dry run moves nothing in the ledger');
    const g = await w.fc.execute({ go: true });
    assert.equal(g.claimed.creatorUsd, 0.95); assert.equal(g.claimed.onixUsd, (THIRD + 380_000) / 1e6); assert.equal(g.claimed.salesCount, 1); assert.equal(w.sent.length, 1);
    const [r] = w.claims();
    assert.equal(r.status, 'sent'); assert.equal(r.curve_units, 3_792_354); assert.equal(r.onix_units, THIRD + 380_000); assert.equal(r.creator_units, 950_000); assert.equal(r.sales_onix_units, 380_000);
    assert.equal(r.creator_wallet, CREATOR); assert.equal(r.sales_count, 1); assert.equal(r.sol_spent_lamports, 5_000); assert.equal(r.treasury_units, 3_792_354 - THIRD - 950_000 - 380_000);
    assert.ok(Transaction.from(Buffer.from(r.tx_b64, 'base64')).verifySignatures());
    assert.deepEqual(ataCreatesOf(r.tx_b64), [CREATOR_ATA]);
    assert.deepEqual(transfersOf(r.tx_b64), [[CREATOR_ATA, 950_000], [ONIX, THIRD + 380_000]]);
    const [s] = w.commissions.list();
    assert.equal(s.status, 'paying'); assert.equal(s.payoutId, r.id); assert.equal(s.payoutSignature, r.sig);
    assert.deepEqual(await land(w, g.claimed.signature), { landed: 1, failed: 0, pending: 0 });
    assert.equal(w.commissions.list()[0].status, 'paid'); assert.equal(w.commissions.encumberedUnits(), 0);
    const l = w.fc.list()[0];
    assert.equal(l.creatorUsd, 0.95); assert.equal(l.salesOnixUsd, 0.38); assert.equal(l.salesCount, 1); assert.equal(l.creatorWallet, CREATOR); assert.equal(l.status, 'landed');
  });
  test('only sales, no fees: the transaction is the creator leg (with its account) and the Onix leg, nothing else; the treasury moves by minus the two', async () => {
    const w = make({ curve: 0, sales: [25.3], creator: CREATOR });
    const g = await w.fc.execute({ go: true });
    assert.equal(g.takeCurve, false); assert.equal(g.takeSales, true);
    const [r] = w.claims();
    assert.equal(r.curve_units, 0); assert.equal(r.pool_units, 0); assert.equal(r.treasury_units, -1_771_000); assert.equal(r.onix_units, 506_000);
    assert.equal(ixsOf(r.tx_b64).length, 3);
    assert.deepEqual(transfersOf(r.tx_b64), [[CREATOR_ATA, 1_265_000], [ONIX, 506_000]]);
  });
  test('a payout that fails on chain, or never lands, puts its sales back to owed; the next claim pays them', async () => {
    const w = make({ curve: 0, sales: [19], creator: CREATOR });
    const a = await w.fc.execute({ go: true });
    assert.deepEqual(await land(w, a.claimed.signature, { InstructionError: [1, { Custom: 1 }] }), { landed: 0, failed: 1, pending: 0 });
    assert.equal(w.commissions.list()[0].status, 'owed'); assert.equal(w.commissions.list()[0].payoutId, null); assert.equal(w.commissions.encumberedUnits(), 1_330_000);
    const b = await w.fc.execute({ go: true });
    assert.notEqual(b.claimed.id, a.claimed.id); assert.equal(w.commissions.list()[0].status, 'paying'); assert.equal(w.commissions.list()[0].payoutId, b.claimed.id);
    const w2 = make({ curve: 0, sales: [19], creator: CREATOR });
    await w2.fc.execute({ go: true });
    w2.tick(FEECLAIM.pendingTtlMs + 1);
    assert.deepEqual(await w2.fc.confirm(), { landed: 0, failed: 1, pending: 0 });
    assert.equal(w2.fc.list()[0].failReason, 'never landed'); assert.equal(w2.commissions.list()[0].status, 'owed');
  });
  test('a sale delivered while a payout is in flight waits for the next one', async () => {
    const w = make({ curve: 0, sales: [19], creator: CREATOR });
    const a = await w.fc.execute({ go: true });
    w.commissions.recordSale({ source: 'gacha', refId: 'R-late', mint: 'M', priceUsd: 20, at: T0 + 1 });
    assert.equal(w.commissions.owed().count, 1);
    await land(w, a.claimed.signature);
    const st = Object.fromEntries(w.commissions.list().map((s) => [s.refId, s.status]));
    assert.deepEqual(st, { P0: 'paid', 'R-late': 'owed' });
  });
  test('one payout at a time: two runs at once sign once; another process sees the claim still sent and waits for it', async () => {
    const w = make({ curve: 0, sales: [19], creator: CREATOR });
    const [a, b] = await Promise.all([w.fc.execute({ go: true }), w.fc.execute({ go: true })]);
    assert.equal([a, b].filter((x) => x.claimed).length, 1); assert.equal(w.sent.length, 1); assert.equal(w.claims().length, 1);
    const other = w.another();
    const o = await other.execute({ go: true });
    assert.equal(o.claimed, null); assert.match(o.why, /not confirmed yet/); assert.equal(w.sent.length, 1);
    await land(w, (a.claimed || b.claimed).signature);
    const after = await other.execute({ go: true });
    assert.equal(after.claimed, null); assert.match(after.why, /nothing worth a claim/);
  });
  test('confirm reconciles the ledger first: sales left paying by an older server follow what their claim says', async () => {
    const w = make({ curve: 0, sales: [19, 20], creator: CREATOR });
    const [p1, p2] = w.commissions.owed().ids;
    w.db.prepare("INSERT INTO vault_fee_claims (id, vault, curve_units, pool_units, onix_units, treasury_units, tx_b64, sig, status, created_at, updated_at) VALUES ('OLD-L', ?, 0, 0, 0, 0, 'x', 'S1', 'landed', ?, ?), ('OLD-F', ?, 0, 0, 0, 0, 'x', 'S2', 'failed', ?, ?)").run(CUSTODY, T0, T0, CUSTODY, T0, T0);
    w.commissions.markPaying([p1], 'OLD-L', T0); w.commissions.markPaying([p2], 'OLD-F', T0);
    assert.deepEqual(await w.fc.confirm(), { landed: 0, failed: 0, pending: 0 });
    assert.deepEqual(Object.fromEntries(w.commissions.list().map((s) => [s.refId, s.status])), { P0: 'paid', P1: 'owed' });
  });
});

describe('feeclaim — only the measured shape of a payout is ever signed', () => {
  // each case: refused with 409, nothing sent, nothing persisted, the sales still owed
  const refused = async (opts, re) => {
    const w = make({ curve: 0, sales: [19], creator: CREATOR, ...opts });
    await assert.rejects(w.fc.execute({ go: true }), (e) => e.statusCode === 409 && re.test(e.message), String(re));
    assert.equal(w.sent.length, 0); assert.equal(w.claims().length, 0); assert.equal(w.commissions.owed().count, 1);
  };
  test('a leg that moves by anything but the plan is refused: the creator, Onix, the treasury', async () => {
    await refused({ shift: { creator: 10 } }, /moves the creator by 950010, the plan says 950000/);
    await refused({ shift: { onix: -10 } }, /moves Onix/);
    await refused({ simShift: 10 }, /moves the treasury/);
  });
  test("the creator's account after the simulation must be the registered creator's USDC account, and readable", async () => {
    await refused({ creatorOwner: OTHER }, /not the registered creator's USDC account/);
    await refused({ creatorMint: OTHER }, /not the registered creator's USDC account/);
    await refused({ creatorReadable: false }, /could not read the creator/);
  });
  test("the custody's SOL: more than the fee and one rent is refused; a balance left under the floor is refused; unreadable is refused", async () => {
    await refused({ solSpent: FEECLAIM.maxSolSpendLamports + 1 }, /takes \d+ lamports from the custody/);
    await refused({ solPre: FEECLAIM.minCustodyLamportsAfter + 4_000 }, /would be left with \d+ lamports/);
    await refused({ solReadable: false }, /could not read the custody's SOL/);
  });
  test('a simulation that fails on chain is refused', async () => {
    await refused({ simErr: { InstructionError: [0, 'x'] } }, /fail on chain/);
  });
});

describe('feeclaim — the transaction size', () => {
  test('when the fee claims and the legs do not fit in one transaction, the legs go alone and the fees wait for the next round', async () => {
    // 17 claim instructions: the fees and their Onix leg fit alone (≈1.1 kB), with the sales legs they do not
    const w = make({ curve: 3_792_354, sales: [19], creator: CREATOR, claimIxs: 17 });
    const g = await w.fc.execute({ go: true });
    assert.equal(g.feesDeferred, true); assert.equal(g.claimed.creatorUsd, 0.95);
    const [r] = w.claims();
    assert.equal(r.curve_units, 0); assert.equal(r.creator_units, 950_000); assert.equal(r.onix_units, 380_000); assert.equal(r.treasury_units, -1_330_000);
    assert.ok(Buffer.from(r.tx_b64, 'base64').length <= FEECLAIM.txSizeLimit);
    await land(w, g.claimed.signature);
    const next = await w.fc.execute({ go: true });
    assert.equal(next.takeCurve, true); assert.equal(next.takeSales, false); assert.equal(w.claims()[1].curve_units, 3_792_354);
  });
});

describe('feeclaim — the creator is paid where Onix is paid', () => {
  test("when the registered creator's USDC account IS Onix's revenue account, both legs land there and the account's delta is their sum", async () => {
    const w = make({ curve: 0, sales: [19], creator: CREATOR, onixAccount: CREATOR_ATA });
    const g = await w.fc.execute({ go: true });
    assert.equal(g.creatorDelta, 1_330_000); assert.equal(g.onixDelta, 1_330_000);
    assert.deepEqual(transfersOf(w.claims()[0].tx_b64), [[CREATOR_ATA, 950_000], [CREATOR_ATA, 380_000]]);
  });
});
