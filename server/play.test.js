const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction } = require('@solana/web3.js');
const { getTestDb } = require('./db');
const { createPlay, PLAY } = require('./play');
const { sha256Hex, draw } = require('./draw');

// The Play door: pay (USDC to custody, or burn the vault token), a provably-fair draw from a band,
// delivery from custody. Prices in share of backing, never at the market price.
const CUSTODY = Keypair.generate().publicKey.toBase58();
const PLAYER = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();
const USDC = Keypair.generate().publicKey.toBase58();
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const item = (mint, v) => ({ mint, name: 'Card ' + mint, custodianValueUsd: v, imageUrl: null });

function make({ items = [item('a', 20), item('b', 24), item('c', 30), item('d', 100)], supply = 10_000_000, realisable = 154.86, poolLive = true } = {}) {
  const db = getTestDb();
  const delivered = [];
  const chain = {
    getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(),
    simulateTransaction: async () => chain.sim || { err: null, logs: [] }, sim: null,
    getSignatureStatuses: async (sigs) => sigs.map((s) => chain.statuses[s] || null), statuses: {},
    getParsedTransaction: async (sig) => chain.parsed[sig] || null, parsed: {},
  };
  const play = createPlay({
    db, chain, vaultWallet: CUSTODY, baseMint: MINT, readItems: async () => items, readStats: async () => ({ backing: { realisableUsd: realisable }, pool: poolLive ? { supply } : null }),
    deliver: async ({ mint, toAddress, onSigned }) => { if (chain.deliverFails) throw new Error('delivery would fail on chain'); onSigned('SIGNED'); delivered.push({ mint, toAddress }); return { sig: 'DELIV' + delivered.length }; },
    usdcMint: USDC, memoProgramId: MEMO, now: () => 1_800_000_000_000,
  });
  const usdcPaid = ({ memo, amount, signer = PLAYER }) => ({ meta: { err: null, preTokenBalances: [{ accountIndex: 2, owner: CUSTODY, mint: USDC, uiTokenAmount: { uiAmount: 0 } }], postTokenBalances: [{ accountIndex: 2, owner: CUSTODY, mint: USDC, uiTokenAmount: { uiAmount: amount } }] }, transaction: { message: { accountKeys: [{ pubkey: signer, signer: true }], instructions: [{ program: 'spl-memo', parsed: memo }] } } });
  const burned = ({ memo, amount, signer = PLAYER, mint = MINT }) => ({ meta: { err: null, preTokenBalances: [{ accountIndex: 1, owner: PLAYER, mint: MINT, uiTokenAmount: { amount: String(amount * 2) } }], postTokenBalances: [{ accountIndex: 1, owner: PLAYER, mint: MINT, uiTokenAmount: { amount: String(amount) } }] }, transaction: { message: { accountKeys: [{ pubkey: signer, signer: true }], instructions: [{ program: 'spl-token', parsed: { type: 'burnChecked', info: { mint, authority: PLAYER, tokenAmount: { amount: String(amount) } } } }, { program: 'spl-memo', parsed: memo }] } } });
  return { play, db, chain, delivered, usdcPaid, burned };
}
const rejects = async (p, code) => { try { await p; assert.fail('expected rejection'); } catch (e) { assert.equal(e.statusCode, code, e.message); } };

describe('play — bands and prices', () => {
  test('items grouped by value; price USDC = avg × 1.15; price in tokens = avg × 1.10 ÷ (backing per token); 3+ items = draw, fewer = pick', async () => {
    const { play } = make();
    const b = await play.bands();
    const b1 = b.bands.find((x) => x.id === 'b1'), b2 = b.bands.find((x) => x.id === 'b2'), b3 = b.bands.find((x) => x.id === 'b3');
    assert.equal(b1.items, 2); assert.equal(b1.kind, 'pick'); assert.equal(b1.avgIndexUsd, 22); assert.equal(b1.priceUsdc, 25.3);
    // backing per token = 154.86 / 10M; tokens = ceil(22 × 1.10 / that)
    assert.equal(b1.priceTokens, Math.ceil(22 * 1.10 / (154.86 / 10_000_000)));
    assert.equal(b2.items, 1); assert.equal(b2.kind, 'pick'); assert.equal(b3.items, 1);
    assert.equal(b.bands.find((x) => x.id === 'b4').kind, 'empty');
    const { play: p3 } = make({ items: [item('a', 10), item('b', 12), item('c', 14)] });
    assert.equal((await p3.bands()).bands[0].kind, 'draw'); assert.ok(Math.abs((await p3.bands()).bands[0].odds - 1 / 3) < 1e-9);
  });
  test('without a live pool, token plays are closed; USDC plays stay open', async () => {
    const { play } = make({ poolLive: false });
    const b = await play.bands();
    assert.equal(b.currencies.token, false); assert.equal(b.bands[0].priceTokens, null); assert.equal(b.bands[0].priceUsdc, 25.3);
  });
});

describe('play — start: commit published, price frozen, payment built for the player', () => {
  test('USDC: transfer to custody + memo play:<id>, single unsigned signer = player; the row holds the seed, the hash and the snapshot', async () => {
    const { play, db } = make();
    const s = await play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'lucky7' });
    assert.equal(s.price, 25.3); assert.equal(s.unit, 'USDC'); assert.equal(s.items, 2); assert.equal(s.memo, 'play:' + s.playId);
    const tx = Transaction.from(Buffer.from(s.paymentTransaction, 'base64'));
    assert.equal(tx.feePayer.toBase58(), PLAYER); assert.equal(tx.signatures.length, 1); assert.equal(tx.signatures[0].signature, null);
    const row = db.prepare('SELECT * FROM vault_plays WHERE id = ?').get(s.playId);
    assert.equal(row.status, 'created'); assert.equal(sha256Hex(row.server_seed), s.serverSeedHash); assert.deepEqual(JSON.parse(row.snapshot_json), ['a', 'b']);
    assert.equal(play.get(s.playId).serverSeed, null, 'the seed stays hidden until the play is done');
  });
  test('token: a burnChecked of the quoted tokens by the player + memo', async () => {
    const { play } = make();
    const s = await play.start({ band: 'b1', player: PLAYER, currency: 'token', clientSeed: 'x' });
    assert.equal(s.unit, 'token'); assert.ok(s.price > 1000);
    const tx = Transaction.from(Buffer.from(s.paymentTransaction, 'base64'));
    assert.equal(tx.instructions.length, 2); assert.equal(Buffer.from(tx.instructions[1].data).toString('utf8'), 'play:' + s.playId);
  });
  test('refusals: bad wallet/currency/seed (400), empty band (404), a second unpaid play (409), 7th play in an hour (429), 402 when the simulation says no funds', async () => {
    const { play, chain, db } = make();
    await rejects(play.start({ band: 'b1', player: 'nope', currency: 'usdc', clientSeed: 'x' }), 400);
    await rejects(play.start({ band: 'b1', player: PLAYER, currency: 'sol', clientSeed: 'x' }), 400);
    await rejects(play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'a|b' }), 400);
    await rejects(play.start({ band: 'b4', player: PLAYER, currency: 'usdc', clientSeed: 'x' }), 404);
    chain.sim = { err: { InstructionError: [1, { Custom: 1 }] }, logs: ['Program log: Error: insufficient funds'] };
    await rejects(play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'x' }), 402);
    chain.sim = null;
    await play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'x' });
    await rejects(play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'y' }), 409);
    db.prepare("UPDATE vault_plays SET status = 'expired'").run();
    for (let i = 0; i < 5; i++) { await play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'z' + i }); db.prepare("UPDATE vault_plays SET status = 'expired'").run(); }
    await rejects(play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'last' }), 429);
  });
});

describe('play — submit → sweep: verify on chain, draw, deliver', () => {
  test('USDC play end to end: the drawn item is the one the digest says, delivered from custody; the seed is revealed after', async () => {
    const { play, chain, delivered, usdcPaid } = make();
    const s = await play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'lucky7' });
    const sub = play.submit({ playId: s.playId, signature: 'PAY1' });
    assert.equal(sub.status, 'submitted');
    assert.deepEqual(await play.sweep(), { verified: 0, delivered: 0, failed: 0, expired: 0 }, 'nothing until the chain has the signature');
    chain.statuses.PAY1 = { confirmationStatus: 'confirmed' }; chain.parsed.PAY1 = usdcPaid({ memo: s.memo, amount: 25.3 });
    assert.equal((await play.sweep()).verified, 0, 'confirmed is not finalized');
    chain.statuses.PAY1 = { confirmationStatus: 'finalized' };
    const r = await play.sweep();
    assert.equal(r.verified, 1); assert.equal(r.delivered, 1);
    const p = play.get(s.playId);
    assert.equal(p.status, 'delivered'); assert.ok(p.serverSeed); assert.equal(sha256Hex(p.serverSeed), p.serverSeedHash);
    const expect = draw({ serverSeed: p.serverSeed, playId: p.playId, clientSeed: 'lucky7', nonce: p.nonce, snapshot: p.snapshot });
    assert.equal(p.mint, expect.mint); assert.equal(p.digest, expect.digest); assert.equal(p.index, expect.index);
    assert.deepEqual(delivered, [{ mint: p.mint, toAddress: PLAYER }]);
    assert.equal(p.deliverySignature, 'DELIV1');
    assert.throws(() => play.submit({ playId: s.playId, signature: 'PAY1' }), (e) => e.statusCode === 409);
  });
  test('token play: the burn is verified (mint, authority, amount, memo); a transfer instead is rejected with the reason', async () => {
    const { play, chain, burned } = make();
    const s = await play.start({ band: 'b1', player: PLAYER, currency: 'token', clientSeed: 'q' });
    play.submit({ playId: s.playId, signature: 'BURN1' });
    chain.statuses.BURN1 = { confirmationStatus: 'finalized' }; chain.parsed.BURN1 = burned({ memo: s.memo, amount: s.price * 1e6 });
    assert.equal((await play.sweep()).delivered, 1);
    const s2 = await play.start({ band: 'b1', player: PLAYER, currency: 'token', clientSeed: 'q2' });
    play.submit({ playId: s2.playId, signature: 'BURN2' });
    chain.statuses.BURN2 = { confirmationStatus: 'finalized' }; chain.parsed.BURN2 = burned({ memo: s2.memo, amount: s2.price * 1e6, mint: Keypair.generate().publicKey.toBase58() });
    const r = await play.sweep();
    assert.equal(r.failed, 1); assert.equal(play.get(s2.playId).status, 'payment_rejected'); assert.match(play.get(s2.playId).failReason, /no-burn/);
  });
  test('paid by another wallet → rejected; underpaid → rejected; the same signature cannot pay two plays', async () => {
    const { play, chain, usdcPaid } = make();
    const s = await play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'a' });
    play.submit({ playId: s.playId, signature: 'P1' });
    chain.statuses.P1 = { confirmationStatus: 'finalized' }; chain.parsed.P1 = usdcPaid({ memo: s.memo, amount: 25.3, signer: Keypair.generate().publicKey.toBase58() });
    await play.sweep(); assert.match(play.get(s.playId).failReason, /payer-mismatch/);
    const s2 = await play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'b' });
    play.submit({ playId: s2.playId, signature: 'P2' });
    chain.statuses.P2 = { confirmationStatus: 'finalized' }; chain.parsed.P2 = usdcPaid({ memo: s2.memo, amount: 20 });
    await play.sweep(); assert.match(play.get(s2.playId).failReason, /amount/);
    const s3 = await play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'c' });
    assert.throws(() => play.submit({ playId: s3.playId, signature: 'P2' }), (e) => e.statusCode === 409);
  });
  test('an item drawn by one play is not in another play\'s band until it leaves; a redraw happens when the drawn item is gone; delivery failure never loses the payment', async () => {
    const { play, chain, usdcPaid, db } = make();
    const s = await play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'a' });
    play.submit({ playId: s.playId, signature: 'P1' });
    chain.statuses.P1 = { confirmationStatus: 'finalized' }; chain.parsed.P1 = usdcPaid({ memo: s.memo, amount: 25.3 });
    chain.deliverFails = true;
    await play.sweep();
    const p = play.get(s.playId);
    assert.equal(p.status, 'delivery_failed'); assert.ok(p.mint); assert.match(p.failReason, /delivery/);
    assert.deepEqual(play.busyMints(), [p.mint]);
    const other = Keypair.generate().publicKey.toBase58();
    const b = await play.bands();
    assert.equal(b.bands[0].items, 1, 'the drawn item is held for its play');
    // the remaining item in the band must be the other one
    db.prepare("UPDATE vault_plays SET player = ? WHERE id = ?").run(other, s.playId);
    const s2 = await play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'b' });
    assert.deepEqual(s2.items, 1);
  });
  test('an unpaid play expires; a submitted signature that never lands goes to payment_missing after the TTL', async () => {
    let t = 1_800_000_000_000;
    const db = getTestDb();
    const chain = { getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(), simulateTransaction: async () => ({ err: null }), getSignatureStatuses: async () => [null], getParsedTransaction: async () => null };
    const play = createPlay({ db, chain, vaultWallet: CUSTODY, baseMint: MINT, readItems: async () => [item('a', 20)], readStats: async () => ({ backing: { realisableUsd: 17.8 }, pool: { supply: 10_000_000 } }), deliver: async () => ({ sig: 'x' }), usdcMint: USDC, memoProgramId: MEMO, now: () => t });
    const s1 = await play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'a' });
    t += PLAY.payTtlMs + 1;
    assert.equal((await play.sweep()).expired, 1); assert.equal(play.get(s1.playId).status, 'expired');
    const s2 = await play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'b' });
    play.submit({ playId: s2.playId, signature: 'GHOST' });
    t += PLAY.payTtlMs + 1;
    await play.sweep(); assert.equal(play.get(s2.playId).status, 'payment_missing');
  });
});
