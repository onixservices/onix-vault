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
function readPayment(parsed, { vaultWallet, usdcMint, expectedMemo, minAmountUsd, payer = null }) {
  if (!parsed) return { ok: false, reason: 'not-found' };
  if (parsed.meta?.err) return { ok: false, reason: 'tx-failed-onchain' };
  // who paid: the first signer is the fee payer; when a payer is expected it must be that wallet (never "someone paid for you")
  if (payer && firstSigner(parsed) !== payer) return { ok: false, reason: `payer-mismatch: ${firstSigner(parsed)}` };
  const post = (parsed.meta?.postTokenBalances || []).find((b) => b.owner === vaultWallet && b.mint === usdcMint);
  const pre = post ? (parsed.meta?.preTokenBalances || []).find((b) => b.accountIndex === post.accountIndex) : null;
  const received = post ? (post.uiTokenAmount?.uiAmount || 0) - (pre?.uiTokenAmount?.uiAmount || 0) : 0;
  if (received + 1e-6 < minAmountUsd) return { ok: false, reason: `amount: received ${received}, price ${minAmountUsd}`, received };
  if (memoOf(parsed) !== expectedMemo) return { ok: false, reason: 'memo-mismatch', received };
  return { ok: true, received };
}

function firstSigner(parsed) { const k = parsed.transaction?.message?.accountKeys || []; const s = k.find((x) => x.signer) || k[0]; return s ? (s.pubkey || s) : null; }
/** The memo, wherever the wallet put it (top level or inner, after its own wrappers). */
function memoOf(parsed) {
  const top = (parsed.transaction?.message?.instructions || []).find((i) => i.program === 'spl-memo');
  if (top) return top.parsed;
  for (const inner of parsed.meta?.innerInstructions || []) { const m = (inner.instructions || []).find((i) => i.program === 'spl-memo'); if (m) return m.parsed; }
  return null;
}

/**
 * The Play door's other currency: the player BURNS the vault's token (their own, with their own
 * signature — nothing passes through the vault) and writes the play id in the memo.
 */
function buildBurnTx({ payer, mint, amountUnits, decimals, memoProgramId, memo, recentBlockhash }) {
  if (!(amountUnits > 0)) throw new Error(`buildBurnTx: invalid amount ${amountUnits}`);
  const { createBurnCheckedInstruction } = require('@solana/spl-token');
  const from = new PublicKey(payer), mintPk = new PublicKey(mint);
  const ata = getAssociatedTokenAddressSync(mintPk, from);
  const tx = new Transaction({ feePayer: from, recentBlockhash });
  tx.add(
    createBurnCheckedInstruction(ata, mintPk, from, BigInt(Math.round(amountUnits)), decimals),
    new TransactionInstruction({ programId: new PublicKey(memoProgramId), keys: [], data: Buffer.from(String(memo), 'utf8') }),
  );
  const out = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const fail = checkSingleSignerUnsigned(Transaction.from(out), payer);
  if (fail) throw new Error(`buildBurnTx: ${fail.assertion}`);
  return out.toString('base64');
}

/**
 * What a landed burn says: a `burnChecked`/`burn` of the vault's mint by the player, for at least
 * the amount, with the play id in the memo. The player's own balance delta is the cross-check.
 */
function readBurnPayment(parsed, { payer, mint, expectedMemo, minAmountUnits }) {
  if (!parsed) return { ok: false, reason: 'not-found' };
  if (parsed.meta?.err) return { ok: false, reason: 'tx-failed-onchain' };
  if (firstSigner(parsed) !== payer) return { ok: false, reason: `payer-mismatch: ${firstSigner(parsed)}` };
  const all = [...(parsed.transaction?.message?.instructions || []), ...((parsed.meta?.innerInstructions || []).flatMap((i) => i.instructions || []))];
  const burn = all.find((i) => (i.program === 'spl-token' || i.program === 'spl-token-2022') && i.parsed && /^burn(Checked)?$/.test(i.parsed.type) && i.parsed.info?.mint === mint && i.parsed.info?.authority === payer);
  if (!burn) return { ok: false, reason: 'no-burn-of-this-mint-by-payer' };
  const amount = Number(burn.parsed.info.tokenAmount?.amount ?? burn.parsed.info.amount ?? 0);
  if (amount < minAmountUnits) return { ok: false, reason: `amount: burned ${amount}, price ${minAmountUnits}`, burned: amount };
  const post = (parsed.meta?.postTokenBalances || []).find((b) => b.owner === payer && b.mint === mint);
  const pre = post ? (parsed.meta?.preTokenBalances || []).find((b) => b.accountIndex === post.accountIndex) : null;
  if (post && pre && Number(pre.uiTokenAmount.amount) - Number(post.uiTokenAmount.amount) < minAmountUnits) return { ok: false, reason: 'balance-delta-too-small', burned: amount };
  if (memoOf(parsed) !== expectedMemo) return { ok: false, reason: 'memo-mismatch', burned: amount };
  return { ok: true, burned: amount };
}

module.exports = { buildPaymentTx, readPayment, buildBurnTx, readBurnPayment, memoOf, firstSigner };
