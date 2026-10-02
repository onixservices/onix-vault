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
  test('when a payer is expected, the first signer must be that wallet; the memo may sit in an inner instruction', () => {
    const P = Keypair.generate().publicKey.toBase58(), other = Keypair.generate().publicKey.toBase58();
    const withSigner = (who) => parsed({ transaction: { message: { accountKeys: [{ pubkey: who, signer: true }], instructions: [] } }, meta: { err: null, preTokenBalances: [{ accountIndex: 2, owner: vault, mint: USDC, uiTokenAmount: { uiAmount: 1 } }], postTokenBalances: [{ accountIndex: 2, owner: vault, mint: USDC, uiTokenAmount: { uiAmount: 21 } }], innerInstructions: [{ instructions: [{ program: 'spl-memo', parsed: 'RES' }] }] } });
    assert.equal(readPayment(withSigner(P), { vaultWallet: vault, usdcMint: USDC, expectedMemo: 'RES', minAmountUsd: 20, payer: P }).ok, true);
    assert.match(readPayment(withSigner(other), { vaultWallet: vault, usdcMint: USDC, expectedMemo: 'RES', minAmountUsd: 20, payer: P }).reason, /payer-mismatch/);
  });
});

describe('burn payment — the player burns the vault token with their own signature', () => {
  const { buildBurnTx, readBurnPayment } = require('./payment');
  const P = Keypair.generate().publicKey.toBase58(), MINT = Keypair.generate().publicKey.toBase58();
  const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
  test('buildBurnTx: burnChecked of the exact units + memo; single unsigned signer = player', () => {
    const b64 = buildBurnTx({ payer: P, mint: MINT, amountUnits: 1_234_567, decimals: 6, memoProgramId: MEMO_PROGRAM, memo: 'play:1', recentBlockhash: Keypair.generate().publicKey.toBase58() });
    const tx = Transaction.from(Buffer.from(b64, 'base64'));
    assert.equal(tx.instructions.length, 2); assert.equal(tx.signatures.length, 1); assert.equal(tx.signatures[0].signature, null); assert.equal(tx.feePayer.toBase58(), P);
    assert.equal(Buffer.from(tx.instructions[1].data).toString('utf8'), 'play:1');
    assert.throws(() => buildBurnTx({ payer: P, mint: MINT, amountUnits: 0, decimals: 6, memoProgramId: MEMO_PROGRAM, memo: 'x', recentBlockhash: 'b' }));
  });
  test('readBurnPayment: burn of THIS mint by THE player for ≥ the amount, with the memo; anything else is refused with the reason', () => {
    const tx = ({ type = 'burnChecked', mint = MINT, authority = P, amount = '1234567', memo = 'play:1', signer = P, pre = '5000000', post = '3765433', err = null } = {}) => ({
      meta: { err, preTokenBalances: [{ accountIndex: 1, owner: P, mint: MINT, uiTokenAmount: { amount: pre } }], postTokenBalances: [{ accountIndex: 1, owner: P, mint: MINT, uiTokenAmount: { amount: post } }] },
      transaction: { message: { accountKeys: [{ pubkey: signer, signer: true }], instructions: [{ program: 'spl-token', parsed: { type, info: { mint, authority, tokenAmount: { amount } } } }, { program: 'spl-memo', parsed: memo }] } },
    });
    const args = { payer: P, mint: MINT, expectedMemo: 'play:1', minAmountUnits: 1_234_567 };
    assert.deepEqual(readBurnPayment(tx(), args), { ok: true, burned: 1234567 });
    assert.equal(readBurnPayment(tx({ type: 'transfer' }), args).reason, 'no-burn-of-this-mint-by-payer');
    assert.equal(readBurnPayment(tx({ mint: Keypair.generate().publicKey.toBase58() }), args).reason, 'no-burn-of-this-mint-by-payer');
    assert.match(readBurnPayment(tx({ amount: '1000' }), args).reason, /amount/);
    assert.equal(readBurnPayment(tx({ memo: 'play:2' }), args).reason, 'memo-mismatch');
    assert.match(readBurnPayment(tx({ signer: Keypair.generate().publicKey.toBase58() }), args).reason, /payer-mismatch/);
    assert.equal(readBurnPayment(tx({ err: {} }), args).reason, 'tx-failed-onchain');
  });
});
