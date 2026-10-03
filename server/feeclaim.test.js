const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const BN = require('bn.js');
const { Keypair, PublicKey, Transaction, SystemProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
const { getTestDb } = require('./db');
const { createFeeClaim } = require('./feeclaim');
const { fromKeypair } = require('./signer');
const { POOL_LAYOUT } = require('../src/reader/pool');

// The trading fees reach the treasury: curve partner fee (2/3 treasury · 1/3 Onix in the same tx) + the pool LP fee.
const custodyKp = Keypair.generate();
const CUSTODY = custodyKp.publicKey.toBase58();
const USDC = Keypair.generate().publicKey.toBase58();
const ONIX = Keypair.generate().publicKey.toBase58();
const POOL = Keypair.generate().publicKey.toBase58();
const CUSTODY_ATA = getAssociatedTokenAddressSync(new PublicKey(USDC), custodyKp.publicKey, true).toBase58();
const tokenAcct = (units) => [(() => { const b = Buffer.alloc(165); b.writeBigUInt64LE(BigInt(units), 64); return b.toString('base64'); })(), 'base64'];
function poolAccount(partnerQuoteFee) {
  const b = Buffer.alloc(424); b.writeBigUInt64LE(BigInt(partnerQuoteFee), POOL_LAYOUT.partnerQuoteFee);
  return { data: [b.toString('base64'), 'base64'] };
}

function make({ curve = 3_792_354, pool = 0, simShift = 0 } = {}) {
  const db = getTestDb(); const sent = [];
  const bal = { [CUSTODY_ATA]: 10_000_000, [ONIX]: 5_000_000 };
  const plan = { treasury: 0, onix: 0 };
  const chain = {
    getAccountInfoBase64: async () => poolAccount(curve),
    getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(),
    getTokenAccountAmount: async (a) => bal[a],
    simulateWithAccounts: async (b64, addrs) => ({ err: null, accounts: addrs.map((a) => ({ data: tokenAcct(bal[a] + (a === CUSTODY_ATA ? plan.treasury + simShift : plan.onix)) })) }),
    sendRawTransaction: async (b64) => { sent.push(b64); },
    getSignatureStatuses: async (s) => s.map((x) => chain.statuses[x] || null), statuses: {},
  };
  const ix = () => SystemProgram.transfer({ fromPubkey: custodyKp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 0 });
  const fc = createFeeClaim({
    db, chain, vaultWallet: CUSTODY, signer: fromKeypair(custodyKp), pool: POOL, usdcMint: USDC, onixUsdcAccount: ONIX,
    getDbcClient: async () => ({ partner: { claimPartnerTradingFee: async (a) => { assert.equal(a.feeClaimer.toBase58(), CUSTODY); return new Transaction().add(ix()); } } }),
    getCpAmm: async () => ({
      getPositionsByUser: async () => (pool ? [{ position: Keypair.generate().publicKey, positionNftAccount: Keypair.generate().publicKey, positionState: { pool: new PublicKey(POOL) } }] : []),
      fetchPoolState: async () => ({ tokenAMint: Keypair.generate().publicKey, tokenBMint: new PublicKey(USDC), tokenAVault: Keypair.generate().publicKey, tokenBVault: Keypair.generate().publicKey, tokenAFlag: 0, tokenBFlag: 0 }),
      claimPositionFee2: async (a) => { assert.equal(a.receiver.toBase58(), CUSTODY); return new Transaction().add(ix()); },
    }),
    getUnClaimLpFee: () => ({ feeTokenA: new BN(0), feeTokenB: new BN(pool) }),
    getTokenProgram: () => new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    now: () => 1_800_000_000_000, log: { warn: () => {} },
  });
  const sync = async () => { const p = await fc.plan(); plan.treasury = p.treasuryUnits; plan.onix = p.onixUnits; return p; };
  return { fc, db, chain, sent, sync };
}

describe('feeclaim — plan', () => {
  test('curve fee: 1/3 to Onix (floored), the rest to the treasury; pool fee below $1 waits', async () => {
    const { sync } = make({ curve: 3_792_354, pool: 300_840 });
    const p = await sync();
    assert.equal(p.takeCurve, true); assert.equal(p.takePool, false);
    assert.equal(p.onixUnits, 1_264_117); assert.equal(p.treasuryUnits, 3_792_354 - 1_264_117);
  });
  test('the pool LP fee goes 100% to the treasury; nothing worth a claim says why', async () => {
    const a = await make({ curve: 0, pool: 2_000_000 }).sync();
    assert.equal(a.takePool, true); assert.equal(a.onixUnits, 0); assert.equal(a.treasuryUnits, 2_000_000);
    const b = await make({ curve: 500_000, pool: 100 }).sync();
    assert.match(b.why, /nothing worth a claim yet/);
  });
});

describe('feeclaim — execute and confirm', () => {
  test('dry: one tx, the custody the only signer, simulated with both balances measured; go: signed, persisted, sent', async () => {
    const w = make({ curve: 3_792_354, pool: 2_000_000 });
    await w.sync();
    const d = await w.fc.execute();
    assert.equal(d.dry, true); assert.equal(d.treasuryDelta, d.treasuryUnits); assert.equal(d.onixDelta, 1_264_117); assert.equal(w.sent.length, 0);
    const g = await w.fc.execute({ go: true });
    assert.ok(g.claimed.signature); assert.equal(w.sent.length, 1);
    const r = w.db.prepare('SELECT * FROM vault_fee_claims').get();
    assert.equal(r.status, 'sent'); assert.equal(r.onix_units, 1_264_117);
    assert.ok(Transaction.from(Buffer.from(r.tx_b64, 'base64')).verifySignatures());
    w.chain.statuses[g.claimed.signature] = { confirmationStatus: 'finalized', err: null };
    assert.deepEqual(await w.fc.confirm(), { landed: 1, failed: 0, pending: 0 });
    assert.equal(w.fc.list()[0].status, 'landed');
  });
  test('a simulation that moves the treasury by anything but the plan is refused and nothing is signed', async () => {
    const w = make({ simShift: -500_000 });
    await w.sync();
    await assert.rejects(w.fc.execute({ go: true }), (e) => e.statusCode === 409 && /moves the treasury/.test(e.message));
    assert.equal(w.sent.length, 0);
  });
});
