const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction } = require('@solana/web3.js');
const { createVaultService, exitPriceUsd, VaultError } = require('./vaultService');
const { getTestDb } = require('./db');
const reservationsRepo = require('./reservationsRepo');

// The vault API, v1. One rule, three verbs. See the header of vaultService.js.
const VAULT = Keypair.generate().publicKey.toBase58();   // on-curve: the payment derives its ATA
const GACHA = Keypair.generate().publicKey.toBase58();
const WINNER = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();   // integrators are wallets: the payment tx derives their ATA
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MINT = Keypair.generate().publicKey.toBase58();
const T0 = 1_800_000_000_000;

const item = (over = {}) => ({ mint: MINT, custodian: 'collector-crypt', name: 'From the vault', category: 'Pokemon', custodianValueUsd: 20, custodianValueBasis: 'insured', marketRefUsd: 17, ...over });

function parsedPayment({ signer = GACHA, to = VAULT, amount, memo, err = null, mint = USDC }) {
  return {
    meta: { err,
      preTokenBalances: [{ accountIndex: 3, owner: to, mint, uiTokenAmount: { uiAmount: 100 } }],
      postTokenBalances: [{ accountIndex: 3, owner: to, mint, uiTokenAmount: { uiAmount: 100 + amount } }] },
    transaction: { message: { accountKeys: [{ pubkey: signer, signer: true }], instructions: memo == null ? [] : [{ program: 'spl-memo', parsed: memo }] } },
  };
}

function make({ now = () => T0, items = [item()], finalized = true } = {}) {
  const db = getTestDb();
  const chain = {
    parsed: null,
    getParsedTransaction: async () => chain.parsed,
    getSignatureStatuses: async () => [{ confirmationStatus: finalized ? 'finalized' : 'confirmed', err: null }],
    getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(),
  };
  const delivered = [];
  const deliver = async ({ mint, toAddress }) => { delivered.push({ mint, toAddress }); return { sig: `SIG-${mint.slice(0, 4)}` }; };
  const svc = createVaultService({ db, readItems: async () => items, chain, deliver, now,
    config: { vaultWallet: VAULT, usdcMint: USDC, memoProgramId: MEMO, reservationTtlMs: 600_000, strikesToBlock: 3, redeemPremium: 1.15 } });
  return { svc, db, chain, delivered };
}

const rejectsWith = async (p, code) => { try { await p; assert.fail('expected rejection'); } catch (e) { assert.equal(e.statusCode, code, e.message); } };

describe('exitPriceUsd — the rule', () => {
  test('max of custodian value and market reference; custodian alone when no market; null when no custodian', () => {
    assert.equal(exitPriceUsd({ custodianValueUsd: 20, marketRefUsd: 17 }), 20);
    assert.equal(exitPriceUsd({ custodianValueUsd: 20, marketRefUsd: 26 }), 26);
    assert.equal(exitPriceUsd({ custodianValueUsd: 20, marketRefUsd: null }), 20);
    assert.equal(exitPriceUsd({ custodianValueUsd: null, marketRefUsd: 26 }), null);
  });
});

describe('list', () => {
  test('priced items only, with exit price, basis, redeem price (×1.15) and status', async () => {
    const { svc } = make({ items: [item(), item({ mint: 'X', custodianValueUsd: null })] });
    const out = await svc.listItems();
    assert.deepEqual(out.map((i) => i.mint), [MINT]);
    assert.equal(out[0].exitPriceUsd, 20); assert.equal(out[0].exitPriceBasis, 'custodian');
    assert.equal(out[0].redeemPriceUsd, 23); assert.equal(out[0].status, 'available');
  });
  test("the card's own facts reach the list: grade, grading company, certificate, physical vault", async () => {
    const { svc } = make({ items: [{ ...item(), grade: 'PRISTINE 10', gradingCompany: 'CGC', certNumber: '6180353022', physicalVault: 'PWCC' }] });
    const [i] = await svc.listItems();
    assert.deepEqual([i.grade, i.gradingCompany, i.certNumber, i.physicalVault], ['PRISTINE 10', 'CGC', '6180353022', 'PWCC']);
  });
  test('a reserved item shows reserved with its deadline', async () => {
    const { svc } = make();
    await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    const [i] = await svc.listItems();
    assert.equal(i.status, 'reserved'); assert.equal(i.reservedUntil, T0 + 600_000);
  });
  test('before graduation the vault does not sell to integrators (409 with the reason); after, it does', async () => {
    const db = getTestDb(); let open = { ok: false, reason: 'this vault sells to integrators once it graduates' };
    const svc = createVaultService({ db, readItems: async () => [item()], chain: { getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58() }, deliver: async () => ({}), now: () => T0, canSell: async () => open,
      config: { vaultWallet: VAULT, usdcMint: USDC, memoProgramId: MEMO, reservationTtlMs: 600_000, strikesToBlock: 3, redeemPremium: 1.15 } });
    await rejectsWith(svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER }), 409);
    open = { ok: true };
    assert.ok((await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER })).reservationId);
  });
  test('an item a play is holding shows reserved too (an integrator never buys it underneath the draw)', async () => {
    const db = getTestDb();
    const svc = createVaultService({ db, readItems: async () => [item()], chain: {}, deliver: async () => ({}), now: () => T0, isMintBusy: (m) => m === MINT,
      config: { vaultWallet: VAULT, usdcMint: USDC, memoProgramId: MEMO, reservationTtlMs: 600_000, strikesToBlock: 3, redeemPremium: 1.15 } });
    const [i] = await svc.listItems();
    assert.equal(i.status, 'reserved'); assert.equal(i.reservedUntil, null);
    await rejectsWith(svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER }), 409);
  });
});

describe('reserve', () => {
  test('freezes the price, returns payTo/memo and a PAYMENT TRANSACTION the integrator only signs', async () => {
    const { svc } = make();
    const r = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    assert.equal(r.exitPriceUsd, 20); assert.equal(r.payTo, VAULT); assert.equal(r.memo, r.reservationId);
    const tx = Transaction.from(Buffer.from(r.paymentTransaction, 'base64'));
    assert.equal(tx.feePayer.toBase58(), GACHA);
    assert.equal(tx.signatures.length, 1); assert.equal(tx.signatures[0].signature, null);
    const memoIx = tx.instructions.find((ix) => ix.programId.toBase58() === MEMO);
    assert.equal(memoIx.data.toString('utf8'), r.reservationId);
  });
  test('Idempotency-Key: the same key returns the same reservation, no second lock', async () => {
    const { svc } = make();
    const a = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER, idempotencyKey: 'k1' });
    const b = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER, idempotencyKey: 'k1' });
    assert.equal(a.reservationId, b.reservationId); assert.equal(b.paymentTransaction, a.paymentTransaction);
  });
  test('second reservation of a live item → 409; unknown or unpriced → 404', async () => {
    const { svc } = make();
    await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    await rejectsWith(svc.reserve({ mint: MINT, integrator: OTHER, winner: WINNER }), 409);
    await rejectsWith(svc.reserve({ mint: 'nope', integrator: GACHA, winner: WINNER }), 404);
  });
  test('expired reservations free the item; three strikes and the integrator is refused (429), others are not', async () => {
    let t = T0;
    const { svc } = make({ now: () => t });
    for (let i = 0; i < 3; i++) { await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER }); t += 601_000; svc.sweepExpired(); }
    assert.equal((await svc.listItems())[0].status, 'available');
    await rejectsWith(svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER }), 429);
    assert.equal((await svc.reserve({ mint: MINT, integrator: OTHER, winner: WINNER })).mint, MINT);
  });
});

describe('settle', () => {
  test('finalized payment ≥ price with the right memo → the vault delivers to the winner', async () => {
    const { svc, chain, delivered, db } = make();
    const r = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    chain.parsed = parsedPayment({ amount: 20, memo: r.reservationId });
    const out = await svc.settle({ reservationId: r.reservationId, paymentSignature: 'PAY' });
    assert.equal(out.status, 'settled'); assert.match(out.deliverySignature, /^SIG-/);
    assert.deepEqual(delivered, [{ mint: MINT, toAddress: WINNER }]);
    assert.equal(reservationsRepo.get(db, r.reservationId).payment_sig, 'PAY');
  });
  test('underpaid → 402; wrong memo / wrong destination / failed tx → 402; not finalized → 409; nothing delivered', async () => {
    for (const c of [
      { p: parsedPayment({ amount: 19.99, memo: 'ID' }), code: 402 },
      { p: parsedPayment({ amount: 20, memo: 'other' }), code: 402 },
      { p: parsedPayment({ amount: 20, memo: 'ID', to: Keypair.generate().publicKey.toBase58() }), code: 402 },
      { p: parsedPayment({ amount: 20, memo: 'ID', signer: Keypair.generate().publicKey.toBase58() }), code: 402 },   // paid by someone else
      { p: parsedPayment({ amount: 20, memo: 'ID', err: { InstructionError: [0, 'Custom'] } }), code: 402 },
    ]) {
      const { svc, chain, delivered } = make();
      const r = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
      const ixs = c.p.transaction.message.instructions; if (ixs[0]?.parsed === 'ID') ixs[0].parsed = r.reservationId;
      chain.parsed = c.p;
      await rejectsWith(svc.settle({ reservationId: r.reservationId, paymentSignature: 'PAY' }), c.code);
      assert.deepEqual(delivered, []);
    }
    const { svc, chain, delivered } = make({ finalized: false });
    const r = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    chain.parsed = parsedPayment({ amount: 20, memo: r.reservationId });
    await rejectsWith(svc.settle({ reservationId: r.reservationId, paymentSignature: 'PAY' }), 409);
    assert.deepEqual(delivered, []);
  });
  test('payment not on chain yet → 409 and the reservation stays live', async () => {
    const { svc, db } = make();
    const r = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    await rejectsWith(svc.settle({ reservationId: r.reservationId, paymentSignature: 'PAY' }), 409);
    assert.equal(reservationsRepo.get(db, r.reservationId).status, 'reserved');
  });
  test('expired reservation → 410 even with a good payment', async () => {
    let t = T0;
    const { svc, chain } = make({ now: () => t });
    const r = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    t += 601_000; chain.parsed = parsedPayment({ amount: 20, memo: r.reservationId });
    await rejectsWith(svc.settle({ reservationId: r.reservationId, paymentSignature: 'PAY' }), 410);
  });
  test('one payment signature settles one reservation, ever (UNIQUE is the last lock)', async () => {
    const { svc, chain } = make({ items: [item(), item({ mint: 'M2' })] });
    const r1 = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    chain.parsed = parsedPayment({ amount: 20, memo: r1.reservationId });
    await svc.settle({ reservationId: r1.reservationId, paymentSignature: 'PAY' });
    const r2 = await svc.reserve({ mint: 'M2', integrator: GACHA, winner: WINNER });
    chain.parsed = parsedPayment({ amount: 20, memo: r2.reservationId });
    await rejectsWith(svc.settle({ reservationId: r2.reservationId, paymentSignature: 'PAY' }), 409);
  });
  test('delivery fails after a good payment → delivery_failed, 503, never back to reserved', async () => {
    const { svc, chain, db } = make();
    const r = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    chain.parsed = parsedPayment({ amount: 20, memo: r.reservationId });
    const bad = createVaultService({ db, readItems: async () => [item()], chain, deliver: async () => { throw new Error('rpc down'); }, now: () => T0,
      config: { vaultWallet: VAULT, usdcMint: USDC, memoProgramId: MEMO, reservationTtlMs: 600_000, strikesToBlock: 3, redeemPremium: 1.15 } });
    await rejectsWith(bad.settle({ reservationId: r.reservationId, paymentSignature: 'PAY' }), 503);
    assert.equal(reservationsRepo.get(db, r.reservationId).status, 'delivery_failed');
  });
});

describe('retryDelivery — the operator re-runs a paid reservation whose delivery failed', () => {
  const cfg = { vaultWallet: VAULT, usdcMint: USDC, memoProgramId: MEMO, reservationTtlMs: 600_000, strikesToBlock: 3, redeemPremium: 1.15 };
  async function paidButFailed() {
    const { svc, chain, db } = make();
    const r = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    chain.parsed = parsedPayment({ amount: 20, memo: r.reservationId });
    const bad = createVaultService({ db, readItems: async () => [item()], chain, deliver: async () => { throw new Error('rpc down'); }, now: () => T0, config: cfg });
    await rejectsWith(bad.settle({ reservationId: r.reservationId, paymentSignature: 'PAY' }), 503);
    return { r, db, chain };
  }

  test('delivery_failed → settled when the delivery now succeeds; the payment is not re-read; the winner is the original one', async () => {
    const { r, db, chain } = await paidButFailed();
    const delivered = [];
    const good = createVaultService({ db, readItems: async () => [item()], chain, deliver: async (d) => { delivered.push(d); return { sig: 'DELIV' }; }, now: () => T0, config: cfg });
    const out = await good.retryDelivery({ reservationId: r.reservationId });
    assert.equal(out.status, 'settled'); assert.equal(out.deliverySignature, 'DELIV'); assert.equal(out.paymentSignature, 'PAY');
    assert.deepEqual(delivered, [{ mint: MINT, toAddress: WINNER, reservationId: r.reservationId }]);
    assert.equal(reservationsRepo.get(db, r.reservationId).fail_reason, null);
  });

  test('fails again → stays delivery_failed with the new reason, 503', async () => {
    const { r, db, chain } = await paidButFailed();
    const bad = createVaultService({ db, readItems: async () => [item()], chain, deliver: async () => { throw new Error('still down'); }, now: () => T0, config: cfg });
    await rejectsWith(bad.retryDelivery({ reservationId: r.reservationId }), 503);
    const row = reservationsRepo.get(db, r.reservationId);
    assert.equal(row.status, 'delivery_failed'); assert.equal(row.fail_reason, 'still down');
  });

  test('only a delivery_failed reservation can be retried: reserved → 409, settled → 409, unknown → 404', async () => {
    const { svc, chain } = make();
    const r = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    await rejectsWith(svc.retryDelivery({ reservationId: r.reservationId }), 409);
    chain.parsed = parsedPayment({ amount: 20, memo: r.reservationId });
    await svc.settle({ reservationId: r.reservationId, paymentSignature: 'PAY' });
    await rejectsWith(svc.retryDelivery({ reservationId: r.reservationId }), 409);
    await rejectsWith(svc.retryDelivery({ reservationId: 'nope' }), 404);
  });
});

describe('activity — the doors that fired, newest first', () => {
  test('settled gacha sales and recorded redemptions, each with its signatures; nothing else', async () => {
    const { svc, chain } = make({ now: (() => { let t = T0; return () => (t += 1000); })(), items: [item(), item({ mint: 'M2' })] });
    const r = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    chain.parsed = parsedPayment({ amount: 20, memo: r.reservationId });
    await svc.settle({ reservationId: r.reservationId, paymentSignature: 'PAY1' });
    await svc.reserve({ mint: 'M2', integrator: GACHA, winner: WINNER });               // live, not an event
    svc.recordRedemption({ mint: Keypair.generate().publicKey.toBase58(), burnSignature: 'BURN1', recipient: OTHER });
    const a = svc.listActivity();
    assert.deepEqual(a.map((e) => e.type), ['redeem', 'gacha']);
    assert.equal(a[1].mint, MINT); assert.equal(a[1].paymentSignature, 'PAY1'); assert.match(a[1].deliverySignature, /^SIG-/); assert.equal(a[1].priceUsd, 20); assert.equal(a[1].to, WINNER);
    assert.equal(a[0].burnSignature, 'BURN1'); assert.equal(a[0].status, 'verifying'); assert.equal(a[0].to, OTHER);
    assert.ok(a.every((e) => typeof e.at === 'number'));
  });
});

describe('redemption v1', () => {
  test('records the burn once; the same burn twice → 409; listed publicly as verifying', async () => {
    const { svc } = make();
    const r = svc.recordRedemption({ mint: MINT, burnSignature: 'BURN', recipient: WINNER });
    assert.equal(r.status, 'verifying');
    assert.throws(() => svc.recordRedemption({ mint: MINT, burnSignature: 'BURN', recipient: WINNER }), (e) => e instanceof VaultError && e.statusCode === 409);
    assert.equal(svc.listRedemptions().length, 1);
  });
});

describe('scope — a reservation is reached only through its own vault and integrator', () => {
  test("another vault's service answers 404 for status, settle and retry", async () => {
    const { svc, db, chain } = make();
    const r = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    const OTHER_VAULT = Keypair.generate().publicKey.toBase58();
    const other = createVaultService({ db, readItems: async () => [item()], chain, deliver: async () => ({ sig: 'X' }), now: () => T0,
      config: { vaultWallet: OTHER_VAULT, usdcMint: USDC, memoProgramId: MEMO, reservationTtlMs: 600_000, strikesToBlock: 3, redeemPremium: 1.15 } });
    assert.throws(() => other.status({ reservationId: r.reservationId }), (e) => e.statusCode === 404);
    await rejectsWith(other.settle({ reservationId: r.reservationId, paymentSignature: 'PAY' }), 404);
    await rejectsWith(other.retryDelivery({ reservationId: r.reservationId }), 404);
    assert.equal(svc.status({ reservationId: r.reservationId }).status, 'reserved');
  });
  test("an Idempotency-Key used by another integrator never returns that integrator's reservation", async () => {
    const { svc } = make();
    const a = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER, idempotencyKey: 'shared' });
    await rejectsWith(svc.reserve({ mint: MINT, integrator: OTHER, winner: WINNER, idempotencyKey: 'shared' }), 409);
    const again = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER, idempotencyKey: 'shared' });
    assert.equal(again.reservationId, a.reservationId);
  });
});

describe('inputs — what is stored and shown is checked first', () => {
  test('reserve: integrator and winner must be wallet addresses (400)', async () => {
    const { svc } = make();
    await rejectsWith(svc.reserve({ mint: MINT, integrator: GACHA, winner: '"><a href=x>win</a>' }), 400);
    await rejectsWith(svc.reserve({ mint: MINT, integrator: 'gacha', winner: WINNER }), 400);
  });
  test('settle: a payment signature that is not base58 is refused before the chain is asked (400)', async () => {
    const { svc, chain } = make();
    const r = await svc.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    chain.getSignatureStatuses = async () => { throw new Error('the chain must not be asked'); };
    await rejectsWith(svc.settle({ reservationId: r.reservationId, paymentSignature: '"><img src=x>' }), 400);
  });
  test('redemptions: mint and recipient are addresses, the burn signature is base58 (400)', () => {
    const { svc } = make();
    assert.throws(() => svc.recordRedemption({ mint: MINT, burnSignature: '<b>', recipient: WINNER }), (e) => e.statusCode === 400);
    assert.throws(() => svc.recordRedemption({ mint: 'M3', burnSignature: 'BURN', recipient: WINNER }), (e) => e.statusCode === 400);
    assert.throws(() => svc.recordRedemption({ mint: MINT, burnSignature: 'BURN', recipient: 'me' }), (e) => e.statusCode === 400);
  });
});
