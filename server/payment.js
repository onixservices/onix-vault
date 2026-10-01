/**
 * server/payment.js — the vault BUILDS the payment transaction and hands it to the
 * integrator (the Collector Crypt pattern: `generatePack` returns the transaction,
 * the player only signs). The integrator never assembles memo or accounts by hand.
 *
 *   ATA of the vault (idempotent create) · transferChecked of the EXACT price in
 *   USDC · memo = reservation id. Single signer = the integrator. Unsigned.
 *
 * And the mirror: reading a landed payment back from the transaction itself
 * (pre/post token balances), never from an indexer or from the caller's word.
 */
'use strict';
const { Transaction, TransactionInstruction, PublicKey } = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
} = require('@solana/spl-token');
const { checkSingleSignerUnsigned } = require('./txAssertions');

const USDC_DECIMALS = 6;
const TX_SIZE_LIMIT = 1232;

function buildPaymentTx({ payer, vaultWallet, usdcMint, memoProgramId, amountUsd, memo, recentBlockhash }) {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error(`buildPaymentTx: invalid amount ${amountUsd}`);
  const micro = Math.round(amountUsd * 1e6);
  const usdc = new PublicKey(usdcMint);
  const from = new PublicKey(payer);
  const to = new PublicKey(vaultWallet);
  const fromAta = getAssociatedTokenAddressSync(usdc, from);
  const toAta = getAssociatedTokenAddressSync(usdc, to);
  const tx = new Transaction({ feePayer: from, recentBlockhash });
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(from, toAta, to, usdc),
    createTransferCheckedInstruction(fromAta, usdc, toAta, from, micro, USDC_DECIMALS),
    new TransactionInstruction({ programId: new PublicKey(memoProgramId), keys: [], data: Buffer.from(String(memo), 'utf8') }),
  );
  const out = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (out.length > TX_SIZE_LIMIT) throw new Error(`buildPaymentTx: ${out.length} bytes > ${TX_SIZE_LIMIT}`);
  const fail = checkSingleSignerUnsigned(Transaction.from(out), payer);
  if (fail) throw new Error(`buildPaymentTx: ${fail.assertion}`);
  return out.toString('base64');
}

/**
 * What a landed transaction says it paid. Returns { ok, received, reason }.
 * `parsed` is the `getTransaction` result with jsonParsed encoding.
 */
function readPayment(parsed, { vaultWallet, usdcMint, expectedMemo, minAmountUsd }) {
  if (!parsed) return { ok: false, reason: 'not-found' };
  if (parsed.meta?.err) return { ok: false, reason: 'tx-failed-onchain' };
  const post = (parsed.meta?.postTokenBalances || []).find((b) => b.owner === vaultWallet && b.mint === usdcMint);
  const pre = post ? (parsed.meta?.preTokenBalances || []).find((b) => b.accountIndex === post.accountIndex) : null;
  const received = post ? (post.uiTokenAmount?.uiAmount || 0) - (pre?.uiTokenAmount?.uiAmount || 0) : 0;
  if (received + 1e-6 < minAmountUsd) return { ok: false, reason: `amount: received ${received}, price ${minAmountUsd}`, received };
  const ixs = parsed.transaction?.message?.instructions || [];
  const memo = ixs.find((i) => i.program === 'spl-memo')?.parsed;
  if (memo !== expectedMemo) return { ok: false, reason: 'memo-mismatch', received };
  return { ok: true, received };
}

module.exports = { buildPaymentTx, readPayment };
