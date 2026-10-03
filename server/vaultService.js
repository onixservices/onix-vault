/**
 * server/vaultService.js — the vault API, v1. Three verbs and one rule.
 *
 * The exit price: `max(custodian value, live market reference)`. v1 ships with the
 * custodian value only (a market reference is optional, injected); the response
 * says which basis was used. The same price for our own gacha and for a stranger,
 * and the same base the redemption uses (× premium).
 *
 *   list    — what the CHAIN says is in the vault wallet (the reader), with the
 *             price; `status` (available/reserved) is the only thing added from SQLite.
 *   reserve — locks an item for a short TTL at a frozen price; one live reservation
 *             per item; an integrator that lets reservations expire repeatedly is
 *             refused; returns the PAYMENT TRANSACTION already built (the integrator
 *             signs and sends it); honours Idempotency-Key.
 *   settle  — reads the payment from the transaction itself (finalized; credits the
 *             vault's USDC account with ≥ price; memo = reservation id); only then
 *             the vault wallet delivers (simulate → sign → persist → broadcast). A
 *             payment signature settles one reservation, ever.
 *   retryDelivery — OPERATOR only (no route): a paid reservation whose delivery
 *             failed runs the delivery again; the payment is not re-read.
 *
 * Nothing here holds anyone's money.
 */
'use strict';
const crypto = require('crypto');
const reservationsRepo = require('./reservationsRepo');
const redemptionsRepo = require('./redemptionsRepo');
const { buildPaymentTx, readPayment } = require('./payment');

class VaultError extends Error {
  constructor(statusCode, message) { super(message); this.name = 'VaultError'; this.statusCode = statusCode; }
}

/** The rule, pure. `null` when there is no custodian value: unpriced is unsellable. */
function exitPriceUsd(item) {
  const ref = item.custodianValueUsd ?? null;
  if (ref == null) return null;
  const mkt = item.marketRefUsd ?? null;
  return mkt != null ? Math.max(ref, mkt) : ref;
}

/**
 * @param {object} deps
 * @param {object} deps.db                 better-sqlite3 database (vault tables)
 * @param {function} deps.readItems        () => Promise<item[]> — from the chain; item = { mint, custodian, name, category,
 *                                         imageUrl, custodianValueUsd, custodianValueBasis, marketRefUsd? }
 * @param {object} deps.chain              getParsedTransaction, getSignatureStatuses, getLatestBlockhash
 * @param {function} deps.deliver          ({ mint, toAddress, reservationId }) => Promise<{ sig }>
 * @param {object} deps.config             vaultWallet, usdcMint, memoProgramId, reservationTtlMs, strikesToBlock, redeemPremium
 */
function createVaultService({ db, readItems, chain, deliver, now = Date.now, config, isMintBusy = () => false, canSell = async () => ({ ok: true }) }) {
  const ttl = config.reservationTtlMs;
  const strikes = config.strikesToBlock ?? 3;
  const premium = config.redeemPremium ?? 1.15;

  async function _items() {
    const items = await readItems();
    return items.map((it) => ({ ...it, exitPriceUsd: exitPriceUsd(it) })).filter((it) => it.exitPriceUsd != null);
  }

  async function listItems() {
    const live = new Map(reservationsRepo.listLive(db, now()).map((r) => [r.mint, r]));
    const items = await _items();
    return items.map((it) => {
      const res = live.get(it.mint) || null;
      return {
        mint: it.mint, custodian: it.custodian, name: it.name || null, category: it.category || null, imageUrl: it.imageUrl || null,
        // the card's own facts, from its on-chain attributes (the item page and the Play reveal show them; they were dropped here)
        grade: it.grade || null, gradingCompany: it.gradingCompany || null, certNumber: it.certNumber || null, physicalVault: it.physicalVault || null,
        custodianValueUsd: it.custodianValueUsd, custodianValueBasis: it.custodianValueBasis || null,
        marketRefUsd: it.marketRefUsd ?? null,
        exitPriceUsd: it.exitPriceUsd,
        exitPriceBasis: it.marketRefUsd != null && it.marketRefUsd > it.custodianValueUsd ? 'market' : 'custodian',
        redeemPriceUsd: Math.round(it.exitPriceUsd * premium * 100) / 100,
        // reserved by an integrator, or held by a play on its way out: either way not for sale
        status: res ? 'reserved' : isMintBusy(it.mint) ? 'reserved' : 'available',
        reservedUntil: res ? res.expires_at : null,
      };
    });
  }

  function sweepExpired() {
    const t = now();
    let n = 0;
    for (const r of reservationsRepo.listToExpire(db, t)) if (reservationsRepo.transition(db, r.id, 'reserved', 'expired', { at: t })) n += 1;
    return n;
  }

  function _reservationView(r, paymentTransaction = null) {
    return {
      reservationId: r.id, mint: r.mint, integrator: r.integrator, winner: r.winner,
      exitPriceUsd: r.exit_price_usd, status: r.status, expiresAt: r.expires_at,
      payTo: config.vaultWallet, payMint: config.usdcMint, memo: r.id,
      ...(paymentTransaction && { paymentTransaction }),
      paymentSignature: r.payment_sig || null, deliverySignature: r.delivery_sig || null,
    };
  }

  async function reserve({ mint, integrator, winner, idempotencyKey = null }) {
    if (!mint || !integrator || !winner) throw new VaultError(400, 'mint, integrator and winner are required');
    // nothing leaves custody while the curve is filling — for integrators as for Play
    const open = await canSell();
    if (!open.ok) throw new VaultError(409, open.reason || 'this vault sells once it graduates');
    sweepExpired();
    if (idempotencyKey) {
      const prev = reservationsRepo.byIdempotencyKey(db, idempotencyKey);
      if (prev) return _reservationView(prev, prev.payment_tx_b64);
    }
    if (reservationsRepo.expiredCountFor(db, integrator) >= strikes) {
      throw new VaultError(429, `integrator ${integrator} let ${strikes} reservations expire without settling — refused`);
    }
    const items = await _items();
    const it = items.find((x) => x.mint === mint);
    if (!it) throw new VaultError(404, 'not in the vault, or not priced');
    const t = now();
    if (reservationsRepo.liveForMint(db, mint, t)) throw new VaultError(409, 'already reserved');
    if (isMintBusy(mint)) throw new VaultError(409, 'this item was drawn by a play and is on its way out');
    const id = crypto.randomUUID();
    const recentBlockhash = await chain.getLatestBlockhash();
    const paymentTx = buildPaymentTx({
      payer: integrator, vaultWallet: config.vaultWallet, usdcMint: config.usdcMint, memoProgramId: config.memoProgramId,
      amountUsd: it.exitPriceUsd, memo: id, recentBlockhash,
    });
    const r = reservationsRepo.add(db, {
      id, mint, integrator, winner, exitPriceUsd: it.exitPriceUsd, expiresAt: t + ttl, createdAt: t,
      idempotencyKey, paymentTxB64: paymentTx, vault: config.vaultWallet,
    });
    return _reservationView(r, paymentTx);
  }

  async function settle({ reservationId, paymentSignature }) {
    if (!reservationId || !paymentSignature) throw new VaultError(400, 'reservationId and paymentSignature are required');
    sweepExpired();
    const r = reservationsRepo.get(db, reservationId);
    if (!r) throw new VaultError(404, 'unknown reservation');
    if (r.status === 'settled') return { ..._reservationView(r), alreadySettled: true };
    if (r.status === 'expired') throw new VaultError(410, 'reservation expired — if you paid, the operator refunds by hand');
    if (r.status !== 'reserved') throw new VaultError(409, `reservation is ${r.status}`);
    const dup = reservationsRepo.byPaymentSig(db, paymentSignature);
    if (dup && dup.id !== r.id) throw new VaultError(409, 'this payment already settled another reservation');

    const [st] = await chain.getSignatureStatuses([paymentSignature]);
    const parsed = await chain.getParsedTransaction(paymentSignature);
    if (!parsed || !st) throw new VaultError(409, 'payment not found on chain yet — retry');
    if (st.confirmationStatus !== 'finalized') throw new VaultError(409, 'payment not finalized yet — retry');
    // the integrator that reserved must be the one that paid (2 Oct 2026: readPayment never checked who paid)
    const v = readPayment(parsed, { vaultWallet: config.vaultWallet, usdcMint: config.usdcMint, expectedMemo: r.id, minAmountUsd: r.exit_price_usd, payer: r.integrator });
    if (!v.ok) throw new VaultError(402, `payment does not cover this reservation (${v.reason})`);

    // Only now does the vault sign. `settling` is the reentrancy lock; UNIQUE(payment_sig) is the last one.
    const t = now();
    if (!reservationsRepo.transition(db, r.id, 'reserved', 'settling', { at: t, set: { payment_sig: paymentSignature } })) {
      throw new VaultError(409, 'reservation changed under us — retry');
    }
    return _deliverSettling(r);
  }

  /** From `settling`: deliver; success → settled, failure → delivery_failed with the reason (never back to reserved). */
  async function _deliverSettling(r) {
    let out;
    try {
      out = await deliver({ mint: r.mint, toAddress: r.winner, reservationId: r.id });
    } catch (e) {
      reservationsRepo.transition(db, r.id, 'settling', 'delivery_failed', { at: now(), set: { fail_reason: String(e.message || e) } });
      throw new VaultError(503, `paid, but delivery failed and is pending: ${e.message}`);
    }
    reservationsRepo.transition(db, r.id, 'settling', 'settled', { at: now(), set: { delivery_sig: out.sig, fail_reason: null } });
    return _reservationView(reservationsRepo.get(db, r.id));
  }

  /**
   * The operator's path for a paid reservation whose delivery failed (`delivery_failed`):
   * the same delivery, again. Not exposed as a route — it is run on the server by hand
   * (`scripts/retry-delivery.js`). The payment was already read and is kept.
   */
  async function retryDelivery({ reservationId }) {
    const r = reservationsRepo.get(db, reservationId);
    if (!r) throw new VaultError(404, 'unknown reservation');
    if (r.status !== 'delivery_failed') throw new VaultError(409, `reservation is ${r.status}; only delivery_failed can be retried`);
    if (!reservationsRepo.transition(db, r.id, 'delivery_failed', 'settling', { at: now() })) throw new VaultError(409, 'reservation changed under us — retry');
    return _deliverSettling(r);
  }

  function status({ reservationId }) {
    const r = reservationsRepo.get(db, reservationId);
    if (!r) throw new VaultError(404, 'unknown reservation');
    return _reservationView(r);
  }

  // ── redemption, v1 (semi-manual): record the burn; the operator verifies and delivers ──
  function recordRedemption({ mint, burnSignature, recipient }) {
    if (!mint || !burnSignature || !recipient) throw new VaultError(400, 'mint, burnSignature and recipient are required');
    if (redemptionsRepo.byBurnSig(db, burnSignature)) throw new VaultError(409, 'this burn was already submitted');
    const id = crypto.randomUUID();
    const r = redemptionsRepo.add(db, { id, mint, recipient, burnSig: burnSignature, createdAt: now(), vault: config.vaultWallet });
    return { redemptionId: r.id, mint, recipient, burnSignature, status: r.status };
  }
  function listRedemptions() { return redemptionsRepo.listPublic(db, config.vaultWallet); }

  /** The doors that fired, newest first: gacha sales (settled) and redemptions, each with its signatures. */
  function listActivity({ limit = 50 } = {}) {
    const sales = reservationsRepo.listSettled(db, limit, config.vaultWallet).map((r) => ({
      type: 'gacha', at: r.updated_at, mint: r.mint, to: r.winner, integrator: r.integrator, priceUsd: r.exit_price_usd,
      paymentSignature: r.payment_sig, deliverySignature: r.delivery_sig,
    }));
    const redemptions = redemptionsRepo.listPublic(db, config.vaultWallet).map((x) => ({
      type: 'redeem', at: x.created_at, mint: x.mint, to: x.recipient, status: x.status,
      burnSignature: x.burn_sig, deliverySignature: x.delivery_sig || null, tokensBurned: x.tokens_burned ?? null, priceUsdAtBurn: x.price_usd_at_burn ?? null,
    }));
    return [...sales, ...redemptions].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  return { listItems, reserve, settle, retryDelivery, status, sweepExpired, recordRedemption, listRedemptions, listActivity, exitPriceUsd };
}

module.exports = { createVaultService, exitPriceUsd, VaultError };
