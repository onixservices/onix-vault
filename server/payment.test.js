const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction } = require('@solana/web3.js');
const { buildPaymentTx, readPayment } = require('./payment');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const payer = Keypair.generate().publicKey.toBase58();
const vault = Keypair.generate().publicKey.toBase58();
const bh = Keypair.generate().publicKey.toBase58();

describe('buildPaymentTx — the vault builds, the integrator signs', () => {
  test('three instructions (ATA idempotent, transferChecked of the exact micro-amount, memo); single unsigned signer = payer', () => {
    const b64 = buildPaymentTx({ payer, vaultWallet: vault, usdcMint: USDC, memoProgramId: MEMO, amountUsd: 12.345678, memo: 'RES', recentBlockhash: bh });
    const tx = Transaction.from(Buffer.from(b64, 'base64'));
    assert.equal(tx.instructions.length, 3);
    assert.equal(tx.feePayer.toBase58(), payer);
    assert.equal(tx.signatures.length, 1); assert.equal(tx.signatures[0].signature, null);
    assert.equal(tx.instructions[2].data.toString('utf8'), 'RES');
    // transferChecked: data = [12, amount u64 LE, decimals]
    const d = tx.instructions[1].data;
    assert.equal(d[0], 12); assert.equal(Number(d.readBigUInt64LE(1)), 12_345_678); assert.equal(d[9], 6);
  });
  test('zero or negative amount is refused', () => {
    assert.throws(() => buildPaymentTx({ payer, vaultWallet: vault, usdcMint: USDC, memoProgramId: MEMO, amountUsd: 0, memo: 'R', recentBlockhash: bh }));
  });
});

describe('readPayment — the transaction is the only witness', () => {
  const parsed = (over = {}) => ({
    meta: { err: null,
      preTokenBalances: [{ accountIndex: 2, owner: vault, mint: USDC, uiTokenAmount: { uiAmount: 1 } }],
      postTokenBalances: [{ accountIndex: 2, owner: vault, mint: USDC, uiTokenAmount: { uiAmount: 21 } }] },
    transaction: { message: { instructions: [{ program: 'spl-memo', parsed: 'RES' }] } },
    ...over,
  });
  test('ok when finalized tx credits the vault ≥ price with the memo', () => {
    assert.deepEqual(readPayment(parsed(), { vaultWallet: vault, usdcMint: USDC, expectedMemo: 'RES', minAmountUsd: 20 }), { ok: true, received: 20 });
  });
  test('underpaid, wrong memo, other mint, failed tx, not found → not ok with the reason', () => {
    assert.equal(readPayment(parsed(), { vaultWallet: vault, usdcMint: USDC, expectedMemo: 'RES', minAmountUsd: 20.01 }).ok, false);
    assert.equal(readPayment(parsed(), { vaultWallet: vault, usdcMint: USDC, expectedMemo: 'X', minAmountUsd: 20 }).reason, 'memo-mismatch');
    assert.equal(readPayment(parsed(), { vaultWallet: vault, usdcMint: 'OtherMint', expectedMemo: 'RES', minAmountUsd: 20 }).ok, false);
    assert.equal(readPayment(parsed({ meta: { err: {} } }), { vaultWallet: vault, usdcMint: USDC, expectedMemo: 'RES', minAmountUsd: 20 }).reason, 'tx-failed-onchain');
    assert.equal(readPayment(null, { vaultWallet: vault, usdcMint: USDC, expectedMemo: 'RES', minAmountUsd: 20 }).reason, 'not-found');
  });
});
