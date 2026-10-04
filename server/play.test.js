const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction } = require('@solana/web3.js');
const { getTestDb } = require('./db');
const { createPlay, PLAY } = require('./play');
const { sha256Hex, draw, serverSeedFor } = require('./draw');

// The Play door: pay (USDC to custody, or burn the vault token), a provably-fair draw from a band,
// delivery from custody. Prices in share of backing, never at the market price.
const CUSTODY = Keypair.generate().publicKey.toBase58();
const PLAYER = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();
const USDC = Keypair.generate().publicKey.toBase58();
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const item = (mint, v) => ({ mint, name: 'Card ' + mint, custodianValueUsd: v, imageUrl: null });
// the draw key lives in the server's memory (production derives it from the master seed); the DB never holds a seed
const DRAW_KEY = Buffer.alloc(32, 7);
const seedOf = (playId) => serverSeedFor({ drawKey: DRAW_KEY, vault: CUSTODY, playId });

function make({ items = [item('a', 20), item('b', 24), item('c', 30), item('d', 100)], supply = 10_000_000, realisable = 154.86, poolLive = true, migrated = true, seedFor = seedOf } = {}) {
  const db = getTestDb();
  const delivered = [];
  const chain = {
    getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(),
    simulateTransaction: async () => chain.sim || { err: null, logs: [] }, sim: null,
    getSignatureStatuses: async (sigs) => sigs.map((s) => chain.statuses[s] || null), statuses: {},
    getParsedTransaction: async (sig) => chain.parsed[sig] || null, parsed: {},
  };
  const play = createPlay({
    db, chain, vaultWallet: CUSTODY, baseMint: MINT, readItems: async () => items, readStats: async () => ({ backing: { realisableUsd: realisable }, poolStatus: poolLive ? (migrated ? 'migrated' : 'live') : 'not launched', pool: poolLive ? { supply, isMigrated: migrated } : null }),
    deliver: async ({ mint, toAddress, onSigned }) => { if (chain.deliverFails) throw new Error('delivery would fail on chain'); onSigned('SIGNED'); delivered.push({ mint, toAddress }); return { sig: 'DELIV' + delivered.length }; },
    usdcMint: USDC, memoProgramId: MEMO, now: () => 1_800_000_000_000, seedFor,
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
  test('without a live pool, token plays are closed; USDC prices are still described; Play is locked', async () => {
    const { play } = make({ poolLive: false });
    const b = await play.bands();
    assert.equal(b.currencies.token, false); assert.equal(b.bands[0].priceTokens, null); assert.equal(b.bands[0].priceUsdc, 25.3);
    assert.equal(b.open, false); assert.match(b.lockedReason, /launches and graduates/);
  });
  test('Play opens at graduation: a live (not migrated) curve describes the machines but refuses to start one', async () => {
    const { play } = make({ migrated: false });
    const b = await play.bands();
    assert.equal(b.open, false); assert.equal(b.lockedReason, 'Play opens when the vault graduates'); assert.equal(b.bands[0].items, 2);
    await rejects(play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'x' }), 409);
    assert.equal((await make().play.bands()).open, true);
  });
});

describe('play — start: commit published, price frozen, payment built for the player', () => {
  test('USDC: transfer to custody + memo play:<id>, single unsigned signer = player; the row holds the hash and the snapshot, never the seed', async () => {
    const { play, db } = make();
    const s = await play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'lucky7' });
    assert.equal(s.price, 25.3); assert.equal(s.unit, 'USDC'); assert.equal(s.items, 2); assert.equal(s.memo, 'play:' + s.playId);
    const tx = Transaction.from(Buffer.from(s.paymentTransaction, 'base64'));
    assert.equal(tx.feePayer.toBase58(), PLAYER); assert.equal(tx.signatures.length, 1); assert.equal(tx.signatures[0].signature, null);
    const row = db.prepare('SELECT * FROM vault_plays WHERE id = ?').get(s.playId);
    assert.equal(row.status, 'created'); assert.equal(row.server_seed, '', 'no seed in the database'); assert.deepEqual(JSON.parse(row.snapshot_json), ['a', 'b']);
    assert.equal(sha256Hex(seedOf(s.playId)), s.serverSeedHash, 'the commit is the hash of the seed derived from the draw key');
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
    assert.equal(p.status, 'delivered'); assert.equal(p.serverSeed, seedOf(s.playId)); assert.equal(sha256Hex(p.serverSeed), p.serverSeedHash);
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
    const play = createPlay({ db, chain, vaultWallet: CUSTODY, baseMint: MINT, readItems: async () => [item('a', 20)], readStats: async () => ({ backing: { realisableUsd: 17.8 }, poolStatus: 'migrated', pool: { supply: 10_000_000, isMigrated: true } }), deliver: async () => ({ sig: 'x' }), usdcMint: USDC, memoProgramId: MEMO, now: () => t });
    const s1 = await play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'a' });
    t += PLAY.payTtlMs + 1;
    assert.equal((await play.sweep()).expired, 1); assert.equal(play.get(s1.playId).status, 'expired');
    const s2 = await play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'b' });
    play.submit({ playId: s2.playId, signature: 'GHST' });
    t += PLAY.payTtlMs + 1;
    await play.sweep(); assert.equal(play.get(s2.playId).status, 'payment_missing');
  });
});

describe('play — the server seed is derived from a key, never stored', () => {
  const pay = async (w, s, sig) => { w.play.submit({ playId: s.playId, signature: sig }); w.chain.statuses[sig] = { confirmationStatus: 'finalized' }; w.chain.parsed[sig] = w.usdcPaid({ memo: s.memo, amount: s.price }); return w.play.sweep(); };
  test('a draw key that no longer matches the commit (e.g. rotated) draws nothing and keeps the payment on record', async () => {
    const w = make();
    const s = await w.play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'k' });
    w.db.prepare('UPDATE vault_plays SET server_seed_hash = ? WHERE id = ?').run(sha256Hex('another key'), s.playId);
    const r = await pay(w, s, 'PAYK');
    assert.equal(r.delivered, 0); assert.equal(w.delivered.length, 0);
    const p = w.play.get(s.playId);
    assert.equal(p.status, 'delivery_failed'); assert.match(p.failReason, /does not match/); assert.equal(p.paymentSignature, 'PAYK');
  });
  test('a play stored with its seed (before this change, or a rehearsal without a key) still draws from the row', async () => {
    const w = make({ seedFor: null });
    const s = await w.play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'old' });
    const row = w.db.prepare('SELECT server_seed FROM vault_plays WHERE id = ?').get(s.playId);
    assert.equal(sha256Hex(row.server_seed), s.serverSeedHash);
    assert.equal((await pay(w, s, 'PAYX')).delivered, 1);
    assert.equal(w.play.get(s.playId).serverSeed, row.server_seed);
  });
});

describe('play — scope: a play is reached only through its own vault', () => {
  test("another vault's Play answers 404 for get and submit", async () => {
    const w = make();
    const s = await w.play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'mine' });
    const other = createPlay({ db: w.db, chain: w.chain, vaultWallet: Keypair.generate().publicKey.toBase58(), baseMint: MINT, readItems: async () => [], readStats: async () => ({}), deliver: async () => ({}), usdcMint: USDC, memoProgramId: MEMO });
    assert.throws(() => other.get(s.playId), (e) => e.statusCode === 404);
    assert.throws(() => other.submit({ playId: s.playId, signature: 'X' }), (e) => e.statusCode === 404);
    assert.equal(w.play.get(s.playId).status, 'created');
  });
});

describe('play — inputs', () => {
  test('a payment signature that is not base58 is refused (400) and the play stays created', async () => {
    const w = make();
    const s = await w.play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'in' });
    assert.throws(() => w.play.submit({ playId: s.playId, signature: '"><a href=x>pay</a>' }), (e) => e.statusCode === 400);
    assert.equal(w.play.get(s.playId).status, 'created');
  });
});

describe('play — one payment, one delivery, even when sweeps overlap', () => {
  test('two sweeps running at once deliver exactly one item for one payment', async () => {
    const w = make();
    const s = await w.play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'twice' });
    w.play.submit({ playId: s.playId, signature: 'PAYR' });
    w.chain.statuses.PAYR = { confirmationStatus: 'finalized' }; w.chain.parsed.PAYR = w.usdcPaid({ memo: s.memo, amount: s.price });
    await Promise.all([w.play.sweep(), w.play.sweep()]);
    assert.equal(w.delivered.length, 1, 'one payment, one item');
    assert.equal(w.play.get(s.playId).status, 'delivered');
  });
  test('two workers on one database (two processes) still deliver once: only the one that claims the play draws', async () => {
    const w = make();
    const second = createPlay({ db: w.db, chain: w.chain, vaultWallet: CUSTODY, baseMint: MINT, readItems: async () => [item('a', 20), item('b', 24)],
      readStats: async () => ({ backing: { realisableUsd: 154.86 }, poolStatus: 'migrated', pool: { supply: 10_000_000, isMigrated: true } }),
      deliver: async ({ mint, toAddress }) => { w.delivered.push({ mint, toAddress }); return { sig: 'DELIV-2' }; }, usdcMint: USDC, memoProgramId: MEMO, now: () => 1_800_000_000_000, seedFor: seedOf });
    const s = await w.play.start({ band: 'b1', player: PLAYER, currency: 'usdc', clientSeed: 'two' });
    w.play.submit({ playId: s.playId, signature: 'PAYW' });
    w.chain.statuses.PAYW = { confirmationStatus: 'finalized' }; w.chain.parsed.PAYW = w.usdcPaid({ memo: s.memo, amount: s.price });
    await Promise.all([w.play.sweep(), second.sweep()]);
    assert.equal(w.delivered.length, 1, 'one payment, one item');
  });
});
