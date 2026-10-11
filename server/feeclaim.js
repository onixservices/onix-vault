/**
 * server/feeclaim.js — the trading fees reach the treasury, and the custody pays what it owes on the cards it sold.
 *
 * Two fee sources, both claimed by the vault's custody wallet (the curve's fee claimer, and the owner of the graduated
 * pool's locked LP position — measured on $OCC, 3 Oct 2026):
 *   curve  the partner's share of the 10% curve fee (4.8% of a trade). Published split: 2/3 to this vault's treasury,
 *          1/3 to Onix — the Onix leg is a transfer in the SAME transaction, to Onix's revenue account, so every claim
 *          and its split are one public signature.
 *   pool   the graduated DAMM v2 pool's 1% fee accrued on the custody's LP position — 100% to the treasury.
 *
 * And, since 11 Oct 2026, the sales (server/commissions.js): every card the vault sold since the last round pays
 *   5% to the vault's registered creator (a transfer to the creator's USDC account, created here when missing) and
 *   2% to Onix (added to the Onix leg). 93% stays. The buyer paid the full price to custody; nothing changed on the wire.
 *
 *   plan()          what is claimable and owed now, and why not if nothing
 *   execute({ go }) dry by default; with go: built → asserted (custody the only signer) → SIMULATED with every account
 *                   it may move measured (treasury, Onix, the creator — each must move by exactly the planned amount;
 *                   the creator's account must be the registered creator's USDC account; the custody's SOL may fall by
 *                   the fee and one rent at most) → signed → PERSISTED, the sales it pays marked `paying` in the same
 *                   write → sent. One claim at a time, in this process and across processes (a claim still `sent` holds
 *                   the next one).
 *   confirm()       sent claims → finalized → landed (the sales are paid) · or failed with the reason (the sales are
 *                   owed again)
 *   list()          the record (also on the Activity tab)
 */
'use strict';
const crypto = require('crypto');
const BN = require('bn.js');
const { PublicKey, Transaction } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction, AccountLayout } = require('@solana/spl-token');
const { decodeVirtualPool } = require('../src/reader/pool');
const { PARTNER_SPLIT } = require('../src/curve/split');

function err(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }
const U64_MAX = new BN('18446744073709551615');
const NO_SALES = Object.freeze({ ids: [], count: 0, priceUnits: 0, creatorUnits: 0, onixUnits: 0, creatorWallets: [] });

const FEECLAIM = Object.freeze({
  minUsd: 1, quoteDecimals: 6, pendingTtlMs: 30 * 60_000, toleranceUnits: 2,
  maxSolSpendLamports: 3_000_000,      // the custody's SOL may fall by the fee and, at most, one token-account rent (≈2.04M lamports)
  minCustodyLamportsAfter: 5_000_000,  // 0.005 SOL stays in the custody, or nothing is signed
  txSizeLimit: 1232,
});

/**
 * @param {object} deps
 * @param {object|null} [deps.commissions]  server/commissions.js for this vault: the sales owed, and the registered creator
 * @param {boolean} [deps.payoutEnabled]    false: the fees are claimed as before and the sales stay owed (ONIX_VAULT_SALE_COMMISSION)
 * @param {function} deps.getDbcClient   async () => DynamicBondingCurveClient
 * @param {function} deps.getCpAmm       async () => CpAmm
 * @param {function} deps.getUnClaimLpFee (poolState, positionState) => { feeTokenA, feeTokenB }
 * @param {function} deps.getTokenProgram (flag) => PublicKey
 */
function createFeeClaim({ db, chain, vaultWallet, signer, pool, usdcMint, onixUsdcAccount, commissions = null, payoutEnabled = true, getDbcClient, getCpAmm, getUnClaimLpFee, getTokenProgram, now = Date.now, limits = FEECLAIM, log = console }) {
  const custodyPk = new PublicKey(vaultWallet), usdcPk = new PublicKey(usdcMint);
  const custodyAta = getAssociatedTokenAddressSync(usdcPk, custodyPk, true).toBase58();
  const minUnits = Math.round(limits.minUsd * 10 ** limits.quoteDecimals);
  // the only address the creator's leg can ever go to: the registered creator's USDC account (server/commissions.js validated it)
  const creatorWallet = commissions && commissions.creatorWallet ? commissions.creatorWallet : null;
  const creatorAta = creatorWallet ? getAssociatedTokenAddressSync(usdcPk, new PublicKey(creatorWallet), true).toBase58() : null;
  const tag = `[feeclaim ${vaultWallet.slice(0, 6)}]`;

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
    const pf = await poolFee().catch((e) => { log.warn(`${tag} pool fee unreadable: ${e.message}`); return null; });
    const poolUnits = pf ? pf.units : 0;
    const takeCurve = curveUnits >= minUnits, takePool = poolUnits >= minUnits;
    const curveOnixUnits = takeCurve ? Math.floor(curveUnits * PARTNER_SPLIT.onix / 100) : 0;
    const owed = commissions ? commissions.owed() : NO_SALES;
    // the creator's leg goes to the registered creator and nobody else: rows naming another wallet hold every payout until the operator looks
    if (owed.creatorUnits > 0 && (owed.creatorWallets.length !== 1 || owed.creatorWallets[0] !== creatorWallet)) {
      throw err(409, `the sales owed name creator ${owed.creatorWallets.join(', ') || 'nobody'}; the vault's registered creator is ${creatorWallet || 'nobody'} — payout refused until the operator reconciles the ledger`);
    }
    const takeSales = payoutEnabled && owed.count > 0;
    const creatorUnits = takeSales ? owed.creatorUnits : 0, salesOnixUnits = takeSales ? owed.onixUnits : 0;
    const onixUnits = curveOnixUnits + salesOnixUnits;
    // the custody's own USDC account: the fees in, the two legs out (negative when only sales are paid)
    const treasuryUnits = (takeCurve ? curveUnits - curveOnixUnits : 0) + (takePool ? poolUnits : 0) - creatorUnits - salesOnixUnits;
    const usd = (u) => `$${(u / 1e6).toFixed(2)}`;
    const why = takeCurve || takePool || takeSales ? null
      : `nothing worth a claim yet (curve ${usd(curveUnits)} · pool ${usd(poolUnits)}; minimum $${limits.minUsd})`
        + (owed.count ? ` · ${owed.count} sale(s) owe ${usd(owed.creatorUnits + owed.onixUnits)} to the creator and Onix, payout ${payoutEnabled ? 'pending' : 'disabled (ONIX_VAULT_SALE_COMMISSION)'}` : '');
    return { curveUnits, poolUnits, takeCurve, takePool, takeSales, curveOnixUnits, salesOnixUnits, onixUnits, creatorUnits, treasuryUnits,
      salesCount: takeSales ? owed.count : 0, salesOwedCount: owed.count, creatorWallet: creatorUnits > 0 ? creatorWallet : null, feesDeferred: false, why, _pf: pf, _saleIds: takeSales ? owed.ids : [] };
  }
  const view = ({ _pf, _saleIds, ...rest }) => rest;

  // one claim at a time: overlapping rounds would both pass plan() before either persisted its claim
  let executing = false;
  async function execute(opts = {}) {
    if (executing) return { claimed: null, why: 'a claim is already running' };
    executing = true;
    try { return await executeOnce(opts); } finally { executing = false; }
  }
  async function executeOnce({ go = false } = {}) {
    // across processes (the server's round vs the operator's script): a claim still `sent` holds the next one — its legs are
    // measured against balances the pending claim is about to change
    const pending = db.prepare("SELECT sig FROM vault_fee_claims WHERE vault = ? AND status = 'sent' ORDER BY created_at LIMIT 1").get(vaultWallet);
    if (pending) return { claimed: null, why: `the previous claim (${pending.sig.slice(0, 8)}…) is not confirmed yet — one claim at a time`, pendingSignature: pending.sig };
    const p = await plan();
    if (p.why) return { ...view(p), claimed: null };
    if (!signer.configured() || signer.publicKey() !== vaultWallet) throw err(503, 'custody signer not configured');

    const feeIxs = [];
    if (p.takeCurve) {
      const client = await getDbcClient();
      const tx = await client.partner.claimPartnerTradingFee({ feeClaimer: custodyPk, payer: custodyPk, pool: new PublicKey(pool), maxBaseAmount: U64_MAX, maxQuoteAmount: U64_MAX });
      feeIxs.push(...tx.instructions);
    }
    if (p.takePool) {
      const cp = await getCpAmm(); const st = p._pf.st;
      const tx = await cp.claimPositionFee2({ owner: custodyPk, position: p._pf.position, pool: p._pf.poolPk, positionNftAccount: p._pf.positionNftAccount, tokenAMint: st.tokenAMint, tokenBMint: st.tokenBMint, tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault, tokenAProgram: getTokenProgram(st.tokenAFlag), tokenBProgram: getTokenProgram(st.tokenBFlag), receiver: custodyPk, feePayer: custodyPk });
      feeIxs.push(...tx.instructions);
    }
    // the legs: the creator's (its USDC account created when missing, rent paid by the custody), then Onix's — after the claims
    const legs = (q) => {
      const ixs = [];
      if (q.creatorUnits > 0) {
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(custodyPk, new PublicKey(creatorAta), new PublicKey(creatorWallet), usdcPk));
        ixs.push(createTransferCheckedInstruction(new PublicKey(custodyAta), usdcPk, new PublicKey(creatorAta), custodyPk, q.creatorUnits, limits.quoteDecimals));
      }
      if (q.onixUnits > 0) ixs.push(createTransferCheckedInstruction(new PublicKey(custodyAta), usdcPk, new PublicKey(onixUsdcAccount), custodyPk, q.onixUnits, limits.quoteDecimals));
      return ixs;
    };
    const build = async (ixs) => { const tx = new Transaction({ feePayer: custodyPk, recentBlockhash: await chain.getLatestBlockhash() }); tx.add(...ixs); return tx; };
    // measured on the compiled message (+ one signature): serializing a transaction over the limit throws in web3.js
    const sizeOf = (tx) => tx.compileMessage().serialize().length + 1 + 64;
    let q = p, tx = await build([...feeIxs, ...legs(p)]);
    if (sizeOf(tx) > limits.txSizeLimit && p.takeSales && (p.takeCurve || p.takePool)) {
      // the legs alone fit; the fees wait for the next round
      q = { ...p, takeCurve: false, takePool: false, curveOnixUnits: 0, onixUnits: p.salesOnixUnits, treasuryUnits: -(p.creatorUnits + p.salesOnixUnits), feesDeferred: true };
      tx = await build(legs(q));
    }
    if (sizeOf(tx) > limits.txSizeLimit) throw err(409, `the claim transaction is ${sizeOf(tx)} bytes (limit ${limits.txSizeLimit}) — refused`);
    const msg = tx.compileMessage();
    if (msg.header.numRequiredSignatures !== 1 || !msg.accountKeys[0].equals(custodyPk)) throw err(409, 'the claim transaction must have the custody as its only signer');
    const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

    // the money, measured: every account the transaction may move, before and after the simulation, against the plan
    const expect = new Map([[custodyAta, q.treasuryUnits]]);
    const expectMore = (a, u) => expect.set(a, (expect.get(a) || 0) + u);
    if (q.onixUnits > 0) expectMore(onixUsdcAccount, q.onixUnits);
    if (q.creatorUnits > 0) expectMore(creatorAta, q.creatorUnits);
    const tokens = [...expect.keys()];
    const watch = q.takeSales ? [...tokens, vaultWallet] : tokens;
    const pre = await Promise.all(tokens.map((a) => chain.getTokenAccountAmount(a).catch(() => 0)));
    const preLamports = q.takeSales ? await chain.getBalanceLamports(vaultWallet).catch(() => null) : null;
    const sim = await chain.simulateWithAccounts(b64, watch);
    if (sim && sim.err) throw err(409, `the claim would fail on chain: ${JSON.stringify(sim.err)} · ${(sim.logs || []).filter((l) => /log:/.test(l)).slice(-2).join(' | ')}`);
    const accounts = (sim && sim.accounts) || [];
    const decodeToken = (acc) => { try { return acc && acc.data ? AccountLayout.decode(Buffer.from(acc.data[0], 'base64')) : null; } catch { return null; } };
    const nameOf = (a) => (a === custodyAta ? 'the treasury' : a === creatorAta ? 'the creator' : 'Onix');
    const deltas = {};
    tokens.forEach((a, i) => {
      const d = decodeToken(accounts[i]);
      if (!d) throw err(409, `could not read ${nameOf(a)} after the simulated claim — nothing signed blind`);
      const delta = Number(d.amount) - pre[i];
      if (Math.abs(delta - expect.get(a)) > limits.toleranceUnits) throw err(409, `the simulated claim moves ${nameOf(a)} by ${delta}, the plan says ${expect.get(a)} — refused`);
      if (a === creatorAta && (d.owner.toBase58() !== creatorWallet || d.mint.toBase58() !== usdcMint)) throw err(409, `after the simulated claim the creator's account is owned by ${d.owner.toBase58()} for mint ${d.mint.toBase58()}: not the registered creator's USDC account — refused`);
      deltas[a] = delta;
    });
    let solSpent = null;
    if (q.takeSales) {
      const solAcc = accounts[tokens.length];
      if (preLamports == null || !solAcc || typeof solAcc.lamports !== 'number') throw err(409, "could not read the custody's SOL after the simulated claim — nothing signed blind");
      solSpent = preLamports - solAcc.lamports;
      if (solSpent > limits.maxSolSpendLamports) throw err(409, `the simulated claim takes ${solSpent} lamports from the custody (cap ${limits.maxSolSpendLamports}) — refused`);
      if (solAcc.lamports < limits.minCustodyLamportsAfter) throw err(409, `the custody would be left with ${solAcc.lamports} lamports (floor ${limits.minCustodyLamportsAfter}) — refused`);
    }
    const treasuryDelta = deltas[custodyAta], onixDelta = q.onixUnits > 0 ? deltas[onixUsdcAccount] : 0, creatorDelta = q.creatorUnits > 0 ? deltas[creatorAta] : 0;
    if (!go) return { ...view(q), dry: true, simulated: true, treasuryDelta, onixDelta, creatorDelta, solSpent, claimed: null };

    signer.signTransaction(tx);
    const bs58 = require('bs58'); const encode = bs58.encode || bs58.default.encode;
    const sig = encode(tx.signatures[0].signature);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    const id = crypto.randomUUID(), t = now();
    // persisted BEFORE broadcast, and the sales it pays move to `paying` in the same write — or nothing is written and nothing sent
    db.transaction(() => {
      db.prepare(`INSERT INTO vault_fee_claims (id, vault, curve_units, pool_units, onix_units, treasury_units, creator_units, sales_onix_units, creator_wallet, sales_count, sol_spent_lamports, tx_b64, sig, status, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)`)
        .run(id, vaultWallet, q.takeCurve ? q.curveUnits : 0, q.takePool ? q.poolUnits : 0, q.onixUnits, q.treasuryUnits, q.creatorUnits, q.salesOnixUnits, q.creatorWallet, q.salesCount, solSpent, signedB64, sig, t, t);
      if (q.takeSales) {
        const moved = commissions.markPaying(q._saleIds, id, t);
        if (moved !== q._saleIds.length) throw err(409, `${moved} of ${q._saleIds.length} sales could be marked paying — another payout took them; nothing sent`);
      }
    })();
    try { await chain.sendRawTransaction(signedB64); }
    catch (e) { log.warn(`${tag} broadcast failed (persisted; rebroadcast on confirm): ${e.message}`); }
    return { ...view(q), treasuryDelta, onixDelta, creatorDelta, solSpent, claimed: { id, signature: sig, treasuryUsd: q.treasuryUnits / 1e6, onixUsd: q.onixUnits / 1e6, creatorUsd: q.creatorUnits / 1e6, salesCount: q.salesCount } };
  }

  async function confirm() {
    const out = { landed: 0, failed: 0, pending: 0 }; const t = now();
    // sales left `paying` by a crash, a rollback or an older server follow what their claim says
    if (commissions) { const r = commissions.reconcile(t); if (r.paid || r.released) log.warn(`${tag} ledger reconciled: ${r.paid} sale(s) paid · ${r.released} back to owed`); }
    // the claim's status and the fate of the sales it carried, in one write
    const mark = (r, status, failReason) => db.transaction(() => {
      db.prepare('UPDATE vault_fee_claims SET status = ?, fail_reason = ?, updated_at = ? WHERE id = ?').run(status, failReason, t, r.id);
      if (commissions) { if (status === 'landed') commissions.settle(r.id, t); else commissions.release(r.id, t); }
    })();
    for (const r of db.prepare("SELECT * FROM vault_fee_claims WHERE vault = ? AND status = 'sent'").all(vaultWallet)) {
      let st = null;
      try { [st] = await chain.getSignatureStatuses([r.sig]); } catch { out.pending += 1; continue; }
      if (!st) {
        if (t - r.created_at > limits.pendingTtlMs) { mark(r, 'failed', 'never landed'); out.failed += 1; }
        else { try { await chain.sendRawTransaction(r.tx_b64); } catch { /* same signature */ } out.pending += 1; }
        continue;
      }
      if (st.err) { mark(r, 'failed', JSON.stringify(st.err).slice(0, 200)); out.failed += 1; continue; }
      if (st.confirmationStatus !== 'finalized') { out.pending += 1; continue; }
      mark(r, 'landed', null);
      out.landed += 1;
    }
    return out;
  }

  function list({ limit = 50 } = {}) {
    return db.prepare('SELECT * FROM vault_fee_claims WHERE vault = ? ORDER BY created_at DESC LIMIT ?').all(vaultWallet, limit)
      .map((r) => ({ id: r.id, curveUsd: r.curve_units / 1e6, poolUsd: r.pool_units / 1e6, onixUsd: r.onix_units / 1e6, treasuryUsd: r.treasury_units / 1e6,
        creatorUsd: (r.creator_units || 0) / 1e6, salesOnixUsd: (r.sales_onix_units || 0) / 1e6, salesCount: r.sales_count || 0, creatorWallet: r.creator_wallet || null, solSpentLamports: r.sol_spent_lamports ?? null,
        status: r.status, signature: r.sig, failReason: r.fail_reason, at: r.created_at }));
  }

  return { plan: async () => view(await plan()), execute, confirm, list, FEECLAIM: limits };
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
