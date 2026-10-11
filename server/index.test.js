/**
 * The production delivery path (server/index.js → createServer), with the chain faked:
 * build → assert single unsigned signer → SIMULATE → sign → persist → broadcast.
 * A delivery that would fail on chain is never signed, never broadcast, and the
 * reservation says so; the operator's retry runs the same path again.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction } = require('@solana/web3.js');
const { createServer } = require('./index');
const { getTestDb } = require('./db');
const { fromKeypair } = require('./signer');
const reservationsRepo = require('./reservationsRepo');

const vaultKp = Keypair.generate();
const VAULT = vaultKp.publicKey.toBase58();
const GACHA = Keypair.generate().publicKey.toBase58();
const WINNER = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function parsedPayment({ amount, memo }) {
  return {
    meta: { err: null,
      preTokenBalances: [{ accountIndex: 3, owner: VAULT, mint: USDC, uiTokenAmount: { uiAmount: 0 } }],
      postTokenBalances: [{ accountIndex: 3, owner: VAULT, mint: USDC, uiTokenAmount: { uiAmount: amount } }] },
    transaction: { message: { accountKeys: [{ pubkey: GACHA, signer: true }], instructions: [{ program: 'spl-memo', parsed: memo }] } },
  };
}

function fakeChain() {
  const chain = {
    simulateErr: null, sent: [], parsed: null,
    getAsset: async () => ({ interface: 'V1_NFT', grouping: [] }),
    getAccountInfoBase64: async () => null,
    getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(),
    simulateTransaction: async () => ({ err: chain.simulateErr, logs: chain.simulateErr ? ['Program log: boom'] : [], unitsConsumed: 12_345 }),
    sendRawTransaction: async (b64) => { chain.sent.push(b64); return 'SENT-SIG'; },
    getParsedTransaction: async () => chain.parsed,
    getSignatureStatuses: async () => [{ confirmationStatus: 'finalized', err: null }],
  };
  return chain;
}

function boot(chain) {
  const db = getTestDb();
  const readItems = async () => [{ mint: MINT, custodian: 'test', name: 'Item', category: 'Test', custodianValueUsd: 20, custodianValueBasis: 'fixture', marketRefUsd: null }];
  const { service } = createServer({ readItems, db, chain, signer: fromKeypair(vaultKp), vaultWallet: VAULT });
  return { service, db };
}

const rejectsWith = async (p, code) => { try { await p; assert.fail('expected rejection'); } catch (e) { assert.equal(e.statusCode, code, e.message); } };

describe('createServer — the real delivery path', () => {
  test('happy path: simulate ok → signed by the vault → persisted → broadcast; the signature on chain is the one we return', async () => {
    const chain = fakeChain();
    const { service, db } = boot(chain);
    const r = await service.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    chain.parsed = parsedPayment({ amount: 20, memo: r.reservationId });
    const out = await service.settle({ reservationId: r.reservationId, paymentSignature: 'PAY' });
    assert.equal(out.status, 'settled');
    assert.equal(chain.sent.length, 1);
    const row = reservationsRepo.get(db, r.reservationId);
    assert.equal(row.delivery_tx_b64, chain.sent[0]);                      // what was persisted is what was broadcast
    const tx = Transaction.from(Buffer.from(row.delivery_tx_b64, 'base64'));
    assert.equal(tx.signatures.length, 1);
    assert.equal(tx.signatures[0].publicKey.toBase58(), VAULT);
    assert.ok(tx.verifySignatures());                                      // the vault's signature is valid for this message
    const bs58 = require('bs58'); const enc = bs58.encode || bs58.default.encode;
    assert.equal(enc(tx.signatures[0].signature), out.deliverySignature);
  });

  test('simulation fails → nothing signed, nothing broadcast, delivery_failed with the on-chain reason', async () => {
    const chain = fakeChain();
    chain.simulateErr = { InstructionError: [1, 'Custom'] };
    const { service, db } = boot(chain);
    const r = await service.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    chain.parsed = parsedPayment({ amount: 20, memo: r.reservationId });
    await rejectsWith(service.settle({ reservationId: r.reservationId, paymentSignature: 'PAY' }), 503);
    assert.equal(chain.sent.length, 0);
    const row = reservationsRepo.get(db, r.reservationId);
    assert.equal(row.status, 'delivery_failed');
    assert.equal(row.delivery_tx_b64, null);
    assert.match(row.fail_reason, /would fail on chain/);
    assert.match(row.fail_reason, /InstructionError/);
  });

  test('operator retry after the cause is gone → delivered once, through the same path', async () => {
    const chain = fakeChain();
    chain.simulateErr = { InstructionError: [1, 'Custom'] };
    const { service, db } = boot(chain);
    const r = await service.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    chain.parsed = parsedPayment({ amount: 20, memo: r.reservationId });
    await rejectsWith(service.settle({ reservationId: r.reservationId, paymentSignature: 'PAY' }), 503);
    chain.simulateErr = null;
    const out = await service.retryDelivery({ reservationId: r.reservationId });
    assert.equal(out.status, 'settled');
    assert.equal(chain.sent.length, 1);
    assert.equal(reservationsRepo.get(db, r.reservationId).delivery_sig, out.deliverySignature);
  });

  test('a signer that is not the vault wallet never delivers (503), and the payment is kept on the reservation', async () => {
    const chain = fakeChain();
    const db = getTestDb();
    const readItems = async () => [{ mint: MINT, custodian: 'test', custodianValueUsd: 20 }];
    const { service } = createServer({ readItems, db, chain, signer: fromKeypair(Keypair.generate()), vaultWallet: VAULT });
    const r = await service.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    chain.parsed = parsedPayment({ amount: 20, memo: r.reservationId });
    await rejectsWith(service.settle({ reservationId: r.reservationId, paymentSignature: 'PAY' }), 503);
    assert.equal(chain.sent.length, 0);
    assert.equal(reservationsRepo.get(db, r.reservationId).payment_sig, 'PAY');
  });
});

describe('createServer — the sales ledger is wired into every vault', () => {
  test('a settled sale is written in the ledger (no registered creator in single-vault mode: the 5% stays, Onix is owed); the bundle carries the fee claim even without a pool, the split in its meta and the owed in its stats', async () => {
    const chain = fakeChain();
    const db = getTestDb();
    const readItems = async () => [{ mint: MINT, custodian: 'test', name: 'Item', category: 'Test', custodianValueUsd: 20, custodianValueBasis: 'fixture', marketRefUsd: null }];
    const { service, vaults } = createServer({ readItems, db, chain, signer: fromKeypair(vaultKp), vaultWallet: VAULT });
    const r = await service.reserve({ mint: MINT, integrator: GACHA, winner: WINNER });
    chain.parsed = parsedPayment({ amount: 20, memo: r.reservationId });
    await service.settle({ reservationId: r.reservationId, paymentSignature: 'PAY' });
    const [v] = vaults;
    const sales = v.commissions.list();
    assert.equal(sales.length, 1); assert.equal(sales[0].status, 'owed'); assert.equal(sales[0].creatorWaived, 'no_creator'); assert.equal(sales[0].onixUnits, 400_000); assert.equal(sales[0].creatorUnits, 0);
    assert.ok(v.feeclaim, 'the fee claim exists without a pool: it is what pays the sales');
    assert.deepEqual(v.meta.saleSplit, { creator: 5, onix: 2, treasury: 93 });
    assert.equal((await v.stats.read()).treasury.owedUsd, 0.4);
  });
});
