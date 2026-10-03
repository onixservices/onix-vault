/**
 * server/feeclaim.js — the trading fees reach the treasury.
 *
 * Two sources, both claimed by the vault's custody wallet (the curve's fee claimer, and the owner of the graduated
 * pool's locked LP position — measured on $OCC, 3 Oct 2026):
 *   curve  the partner's share of the 10% curve fee (4.8% of a trade). Published split: 2/3 to this vault's treasury,
 *          1/3 to Onix — the Onix leg is a transfer in the SAME transaction, to Onix's revenue account, so every claim
 *          and its split are one public signature.
 *   pool   the graduated DAMM v2 pool's 1% fee accrued on the custody's LP position — 100% to the treasury.
 *
 *   plan()          what is claimable now, and why not if nothing
 *   execute({ go }) dry by default; with go: built → asserted (custody the only signer) → SIMULATED with both balances
 *                   measured (treasury and Onix must move by exactly the planned amounts) → signed → PERSISTED → sent
 *   confirm()       sent claims → finalized → landed (or failed with the reason)
 *   list()          the record (also on the Activity tab)
 */
'use strict';
const crypto = require('crypto');
const BN = require('bn.js');
const { PublicKey, Transaction } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, createTransferCheckedInstruction } = require('@solana/spl-token');
const { decodeVirtualPool } = require('../src/reader/pool');
const { PARTNER_SPLIT } = require('../src/curve/split');

function err(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }
const U64_MAX = new BN('18446744073709551615');

const FEECLAIM = Object.freeze({ minUsd: 1, quoteDecimals: 6, pendingTtlMs: 30 * 60_000, toleranceUnits: 2 });

/**
 * @param {object} deps
 * @param {function} deps.getDbcClient   async () => DynamicBondingCurveClient
 * @param {function} deps.getCpAmm       async () => CpAmm
 * @param {function} deps.getUnClaimLpFee (poolState, positionState) => { feeTokenA, feeTokenB }
 * @param {function} deps.getTokenProgram (flag) => PublicKey
 */
function createFeeClaim({ db, chain, vaultWallet, signer, pool, usdcMint, onixUsdcAccount, getDbcClient, getCpAmm, getUnClaimLpFee, getTokenProgram, now = Date.now, limits = FEECLAIM, log = console }) {
  const custodyPk = new PublicKey(vaultWallet), usdcPk = new PublicKey(usdcMint);
  const custodyAta = getAssociatedTokenAddressSync(usdcPk, custodyPk, true).toBase58();
  const minUnits = Math.round(limits.minUsd * 10 ** limits.quoteDecimals);

  async function curveFeeUnits() {
    if (!pool) return 0;
    const acct = await chain.getAccountInfoBase64(pool);
    if (!acct) return 0;
    return Number(decodeVirtualPool(Uint8Array.from(Buffer.from(acct.data[0], 'base64'))).partnerQuoteFee);
  }

  /** The custody's LP position on a USDC-quoted DAMM v2 pool, with what it can claim in USDC. */
  async function poolFee() {
    const cp = await getCpAmm();
    const positions = await cp.getPositionsByUser(custodyPk);
    for (const p of positions) {
      const poolPk = p.positionState.pool;
      const st = await cp.fetchPoolState(poolPk);
      const bIsUsdc = st.tokenBMint.equals(usdcPk), aIsUsdc = st.tokenAMint.equals(usdcPk);
      if (!aIsUsdc && !bIsUsdc) continue;
      const fees = getUnClaimLpFee(st, p.positionState);
      const units = Number((bIsUsdc ? fees.feeTokenB : fees.feeTokenA).toString());
      return { units, position: p.position, positionNftAccount: p.positionNftAccount, poolPk, st };
    }
    return null;
  }

  async function plan() {
    const curveUnits = await curveFeeUnits();
    const pf = await poolFee().catch((e) => { log.warn(`[feeclaim ${vaultWallet.slice(0, 6)}] pool fee unreadable: ${e.message}`); return null; });
    const poolUnits = pf ? pf.units : 0;
    const takeCurve = curveUnits >= minUnits, takePool = poolUnits >= minUnits;
    const onixUnits = takeCurve ? Math.floor(curveUnits * PARTNER_SPLIT.onix / 100) : 0;
    const why = takeCurve || takePool ? null : `nothing worth a claim yet (curve $${(curveUnits / 1e6).toFixed(2)} · pool $${(poolUnits / 1e6).toFixed(2)}; minimum $${limits.minUsd})`;
    return { curveUnits, poolUnits, takeCurve, takePool, onixUnits, treasuryUnits: (takeCurve ? curveUnits - onixUnits : 0) + (takePool ? poolUnits : 0), why, _pf: pf };
  }

  async function execute({ go = false } = {}) {
    const p = await plan();
    const view = ({ _pf, ...rest }) => rest;
    if (p.why) return { ...view(p), claimed: null };
    if (!signer.configured() || signer.publicKey() !== vaultWallet) throw err(503, 'custody signer not configured');
    const ixs = [];
    if (p.takeCurve) {
      const client = await getDbcClient();
      const tx = await client.partner.claimPartnerTradingFee({ feeClaimer: custodyPk, payer: custodyPk, pool: new PublicKey(pool), maxBaseAmount: U64_MAX, maxQuoteAmount: U64_MAX });
      ixs.push(...tx.instructions);
      if (p.onixUnits > 0) ixs.push(createTransferCheckedInstruction(new PublicKey(custodyAta), usdcPk, new PublicKey(onixUsdcAccount), custodyPk, p.onixUnits, limits.quoteDecimals));
    }
    if (p.takePool) {
      const cp = await getCpAmm(); const st = p._pf.st;
      const tx = await cp.claimPositionFee2({ owner: custodyPk, position: p._pf.position, pool: p._pf.poolPk, positionNftAccount: p._pf.positionNftAccount, tokenAMint: st.tokenAMint, tokenBMint: st.tokenBMint, tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault, tokenAProgram: getTokenProgram(st.tokenAFlag), tokenBProgram: getTokenProgram(st.tokenBFlag), receiver: custodyPk, feePayer: custodyPk });
      ixs.push(...tx.instructions);
    }
    const tx = new Transaction({ feePayer: custodyPk, recentBlockhash: await chain.getLatestBlockhash() });
    tx.add(...ixs);
    const msg = tx.compileMessage();
    if (msg.header.numRequiredSignatures !== 1 || !msg.accountKeys[0].equals(custodyPk)) throw err(409, 'the claim transaction must have the custody as its only signer');
    const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    // the money, measured: the treasury and Onix's account before, and after the simulated claim
    const watch = [custodyAta, ...(p.onixUnits > 0 ? [onixUsdcAccount] : [])];
    const pre = await Promise.all(watch.map((a) => chain.getTokenAccountAmount(a).catch(() => 0)));
    const sim = await chain.simulateWithAccounts(b64, watch);
    if (sim && sim.err) throw err(409, `the claim would fail on chain: ${JSON.stringify(sim.err)} · ${(sim.logs || []).filter((l) => /log:/.test(l)).slice(-2).join(' | ')}`);
    const amountOf = (acc) => (acc && acc.data && Buffer.from(acc.data[0], 'base64').length >= 72 ? Number(Buffer.from(acc.data[0], 'base64').readBigUInt64LE(64)) : null);
    const post = (sim.accounts || []).map(amountOf);
    const treasuryDelta = post[0] == null ? null : post[0] - pre[0];
    const onixDelta = p.onixUnits > 0 ? (post[1] == null ? null : post[1] - pre[1]) : 0;
    if (treasuryDelta == null || Math.abs(treasuryDelta - p.treasuryUnits) > limits.toleranceUnits) throw err(409, `the simulated claim moves the treasury by ${treasuryDelta}, the plan says ${p.treasuryUnits} — refused`);
    if (onixDelta == null || Math.abs(onixDelta - p.onixUnits) > limits.toleranceUnits) throw err(409, `the simulated claim moves Onix by ${onixDelta}, the plan says ${p.onixUnits} — refused`);
    if (!go) return { ...view(p), dry: true, simulated: true, treasuryDelta, onixDelta, claimed: null };
    signer.signTransaction(tx);
    const bs58 = require('bs58'); const encode = bs58.encode || bs58.default.encode;
    const sig = encode(tx.signatures[0].signature);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    const id = crypto.randomUUID(), t = now();
    db.prepare(`INSERT INTO vault_fee_claims (id, vault, curve_units, pool_units, onix_units, treasury_units, tx_b64, sig, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)`).run(id, vaultWallet, p.takeCurve ? p.curveUnits : 0, p.takePool ? p.poolUnits : 0, p.onixUnits, p.treasuryUnits, signedB64, sig, t, t);
    try { await chain.sendRawTransaction(signedB64); }
    catch (e) { log.warn(`[feeclaim ${vaultWallet.slice(0, 6)}] broadcast failed (persisted; rebroadcast on confirm): ${e.message}`); }
    return { ...view(p), claimed: { id, signature: sig, treasuryUsd: p.treasuryUnits / 1e6, onixUsd: p.onixUnits / 1e6 } };
  }

  async function confirm() {
    const out = { landed: 0, failed: 0, pending: 0 }; const t = now();
    for (const r of db.prepare("SELECT * FROM vault_fee_claims WHERE vault = ? AND status = 'sent'").all(vaultWallet)) {
      let st = null;
      try { [st] = await chain.getSignatureStatuses([r.sig]); } catch { out.pending += 1; continue; }
      if (!st) {
        if (t - r.created_at > limits.pendingTtlMs) { db.prepare("UPDATE vault_fee_claims SET status = 'failed', fail_reason = 'never landed', updated_at = ? WHERE id = ?").run(t, r.id); out.failed += 1; }
        else { try { await chain.sendRawTransaction(r.tx_b64); } catch { /* same signature */ } out.pending += 1; }
        continue;
      }
      if (st.err) { db.prepare("UPDATE vault_fee_claims SET status = 'failed', fail_reason = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(st.err).slice(0, 200), t, r.id); out.failed += 1; continue; }
      if (st.confirmationStatus !== 'finalized') { out.pending += 1; continue; }
      db.prepare("UPDATE vault_fee_claims SET status = 'landed', updated_at = ? WHERE id = ?").run(t, r.id);
      out.landed += 1;
    }
    return out;
  }

  function list({ limit = 50 } = {}) {
    return db.prepare('SELECT * FROM vault_fee_claims WHERE vault = ? ORDER BY created_at DESC LIMIT ?').all(vaultWallet, limit)
      .map((r) => ({ id: r.id, curveUsd: r.curve_units / 1e6, poolUsd: r.pool_units / 1e6, onixUsd: r.onix_units / 1e6, treasuryUsd: r.treasury_units / 1e6, status: r.status, signature: r.sig, failReason: r.fail_reason, at: r.created_at }));
  }

  return { plan: async () => { const { _pf, ...v } = await plan(); return v; }, execute, confirm, list, FEECLAIM: limits };
}

/** Production deps: the two Meteora SDKs over our RPC. */
function productionFeeClaimDeps({ rpcUrl }) {
  let dbc = null, cp = null, cpSdk = null;
  const conn = () => new (require('@solana/web3.js').Connection)(rpcUrl, 'confirmed');
  return {
    getDbcClient: async () => { if (!dbc) dbc = require('@meteora-ag/dynamic-bonding-curve-sdk').DynamicBondingCurveClient.create(conn(), 'confirmed'); return dbc; },
    getCpAmm: async () => { if (!cp) { cpSdk = require('@meteora-ag/cp-amm-sdk'); cp = new cpSdk.CpAmm(conn()); } return cp; },
    getUnClaimLpFee: (st, ps) => require('@meteora-ag/cp-amm-sdk').getUnClaimLpFee(st, ps),
    getTokenProgram: (flag) => require('@meteora-ag/cp-amm-sdk').getTokenProgram(flag),
  };
}

module.exports = { createFeeClaim, productionFeeClaimDeps, FEECLAIM };
