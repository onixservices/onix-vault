/**
 * server/graduation.js — the vault graduates itself.
 *
 * When the curve is full (USDC in its reserve ≥ the config's migration threshold) and the pool has not migrated,
 * the server runs what the operator used to run by hand (scripts/graduate.js, kept as the manual way):
 *   1. the creator's vesting locker (the program requires it BEFORE the migration when lockedVesting is set)
 *   2. the migration to DAMM v2 — permissionless; the payer creates the pool and its two locked positions
 *   3. the migration fee (30% of the raise) → the fee claimer = the vault's custody wallet
 *   4. the leftover tokens (the 0.1% headroom) → custody
 * There is no public trigger: the only way to start it is to fill the curve. Each transaction is built → SIMULATED →
 * signed → sent → waited for. The record (vault_graduations, one row per vault) makes it run once; a failed run keeps
 * the reason and the step, is retried after a cooldown a few times, then waits for a human.
 *
 *   plan()           reads the pool: ready or why not (raised, threshold, migrated, record)
 *   execute({ go })  dry by default (simulates the locker and the migration); with go: the four steps, persisted as it goes
 *   list()           the record (also on the Activity tab)
 */
'use strict';
const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');

const GRADUATION = Object.freeze({
  checkMs: 60_000,            // how often the server looks at a live curve
  retryAfterMs: 10 * 60_000,  // a failed run is tried again after this
  maxAttempts: 5,             // then it waits for a human (scripts/graduate.js)
  waitMs: 90_000,             // per transaction, for the confirmation
  quoteDecimals: 6,
});
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} deps
 * @param {object} deps.signer         the custody key (fee claimer): configured(), publicKey(), signTransaction(tx)
 * @param {object} deps.payer          the operator key that pays the locker and the migration
 * @param {function} deps.getClient    async () => DynamicBondingCurveClient (or a fake)
 * @param {function} deps.dammConfigFor (migrationFeeOption) => PublicKey of the DAMM v2 config, or null
 */
function createGraduation({ db, chain, vaultWallet, pool, signer, payer, getClient, dammConfigFor, now = Date.now, limits = GRADUATION, log = console }) {
  const poolPk = pool ? new PublicKey(pool) : null;
  const custodyPk = new PublicKey(vaultWallet);
  let running = false;

  const record = () => db.prepare('SELECT * FROM vault_graduations WHERE vault = ?').get(vaultWallet) || null;
  const update = (fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE vault_graduations SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE vault = ?`).run(...keys.map((k) => fields[k]), now(), vaultWallet);
  };
  const view = (r) => ({
    id: r.id, pool: r.pool, status: r.status, step: r.step, attempts: r.attempts, raisedUsd: r.raised_usd, thresholdUsd: r.threshold_usd,
    signatures: { locker: r.locker_sig, migrate: r.migrate_sig, fee: r.fee_sig, leftover: r.leftover_sig },
    skipped: r.skipped_json ? JSON.parse(r.skipped_json) : {}, failReason: r.fail_reason, at: r.created_at, landedAt: r.status === 'done' ? r.updated_at : null,
  });

  async function readPool() {
    const client = await getClient();
    const r = await client.state.getPool(poolPk); const s = r.poolState || r;
    const cfg = await client.state.getPoolConfig(s.config);
    return {
      raisedUsd: Number(s.quoteReserve.toString()) / 10 ** limits.quoteDecimals,
      thresholdUsd: Number(cfg.migrationQuoteThreshold.toString()) / 10 ** limits.quoteDecimals,
      isMigrated: Boolean(s.isMigrated), migrationFeeOption: Number(cfg.migrationFeeOption),
    };
  }

  async function plan() {
    if (!poolPk) return { ready: false, why: 'no pool' };
    const rec = record();
    if (rec && rec.status === 'done') return { ready: false, why: 'graduated', record: view(rec) };
    if (rec && rec.status === 'running') return { ready: false, why: 'a run is in flight', record: view(rec) };
    const p = await readPool();
    const nums = { raisedUsd: p.raisedUsd, thresholdUsd: p.thresholdUsd, isMigrated: p.isMigrated, migrationFeeOption: p.migrationFeeOption };
    if (p.isMigrated) {
      // finished outside this loop (the script, or Meteora's keeper): the record, if any, is closed as done
      if (rec) { update({ status: 'done', step: 'external' }); }
      return { ready: false, why: 'already migrated', ...nums, record: rec ? view(record()) : null };
    }
    if (rec && rec.status === 'failed') {
      if (rec.attempts >= limits.maxAttempts) return { ready: false, why: `failed ${rec.attempts} times; needs a human (scripts/graduate.js)`, ...nums, record: view(rec) };
      const wait = limits.retryAfterMs - (now() - rec.updated_at);
      if (wait > 0) return { ready: false, why: `failed at ${rec.step}; retry in ${Math.ceil(wait / 60_000)} min`, ...nums, record: view(rec) };
    }
    if (p.raisedUsd + 1e-6 < p.thresholdUsd) return { ready: false, why: `curve at $${r2(p.raisedUsd)} of $${r2(p.thresholdUsd)}`, ...nums };
    if (!signer.configured() || !payer.configured()) return { ready: false, why: 'signer not configured', ...nums };
    return { ready: true, why: 'the curve is full', ...nums, record: rec ? view(rec) : null };
  }

  /** build → simulate → (go) sign → send → wait. A simulation that fails is the step's failure; nothing is signed. */
  async function send(step, tx, signers, { go }) {
    tx.recentBlockhash = await chain.getLatestBlockhash();
    const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    const sim = await chain.simulateTransaction(unsigned);
    if (sim && sim.err) throw new Error(`${step} would fail on chain: ${JSON.stringify(sim.err)} · ${(sim.logs || []).filter((l) => /Error|log:/.test(l)).slice(-2).join(' | ')}`);
    if (!go) return null;
    for (const s of signers) s.signTransaction(tx);
    const sig = await chain.sendRawTransaction(tx.serialize().toString('base64'));
    await chain.waitForSignature(sig, { timeoutMs: limits.waitMs });
    return sig;
  }

  async function execute({ go = false } = {}) {
    if (running) return { skipped: 'running', graduated: null };
    running = true;
    try {
      const p = await plan();
      if (!p.ready) return { ...p, graduated: null };
      const client = await getClient();
      const payerPk = new PublicKey(payer.publicKey());
      const dammConfig = dammConfigFor(p.migrationFeeOption);
      if (!dammConfig) throw new Error(`no DAMM v2 config for migration fee option ${p.migrationFeeOption}`);
      // the migration transaction carries two throwaway position-NFT keys that sign here, after the payer's content is fixed
      const migrateTx = async () => { const res = await client.migration.migrateToDammV2({ payer: payerPk, pool: poolPk, dammConfig }); const extra = [res.firstPositionNftKeypair, res.secondPositionNftKeypair].filter(Boolean); const tx = res.transaction; tx.feePayer = payerPk; return { tx, signers: [{ signTransaction: (t) => { if (extra.length) t.partialSign(...extra); return t; } }, payer] }; };
      if (!go) {
        const simulated = [];
        try { const tx = await client.migration.createLocker({ payer: payerPk, pool: poolPk }); tx.feePayer = payerPk; await send('locker', tx, [], { go: false }); simulated.push('locker'); } catch (e) { simulated.push(`locker: ${e.message.slice(0, 120)}`); }
        const m = await migrateTx(); await send('migrate', m.tx, [], { go: false }); simulated.push('migrate');
        return { dry: true, simulated, ...p, graduated: null };
      }
      const t = now(); const rec = record();
      if (rec) update({ status: 'running', step: 'locker', attempts: rec.attempts + 1, fail_reason: null, raised_usd: p.raisedUsd, threshold_usd: p.thresholdUsd });
      else db.prepare('INSERT INTO vault_graduations (id, vault, pool, status, step, attempts, raised_usd, threshold_usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)').run(crypto.randomUUID(), vaultWallet, pool, 'running', 'locker', p.raisedUsd, p.thresholdUsd, t, t);
      const sigs = { locker: null, migrate: null, fee: null, leftover: null }, skipped = {};
      let step = 'locker';
      try {
        // 1. locker — an existing locker makes the program refuse; the migration below is the judge of whether it is there
        try { const tx = await client.migration.createLocker({ payer: payerPk, pool: poolPk }); tx.feePayer = payerPk; sigs.locker = await send('locker', tx, [payer], { go: true }); update({ locker_sig: sigs.locker }); }
        catch (e) { skipped.locker = e.message.slice(0, 200); log.warn(`[graduation] locker skipped: ${skipped.locker}`); }
        // 2. migrate — the one that must land
        step = 'migrate'; update({ step });
        const m = await migrateTx(); sigs.migrate = await send('migrate', m.tx, m.signers, { go: true }); update({ migrate_sig: sigs.migrate });
        // 3. the migration fee → custody · 4. the leftover → custody: the vault's own key, tolerated if the program refuses
        step = 'fee'; update({ step });
        try { const tx = await client.partner.partnerWithdrawMigrationFee({ pool: poolPk, sender: custodyPk }); tx.feePayer = custodyPk; sigs.fee = await send('fee', tx, [signer], { go: true }); update({ fee_sig: sigs.fee }); }
        catch (e) { skipped.fee = e.message.slice(0, 200); log.warn(`[graduation] migration fee skipped: ${skipped.fee}`); }
        step = 'leftover'; update({ step });
        try { const tx = await client.migration.withdrawLeftover({ payer: custodyPk, pool: poolPk }); tx.feePayer = custodyPk; sigs.leftover = await send('leftover', tx, [signer], { go: true }); update({ leftover_sig: sigs.leftover }); }
        catch (e) { skipped.leftover = e.message.slice(0, 200); log.warn(`[graduation] leftover skipped: ${skipped.leftover}`); }
        update({ status: 'done', step: 'done', skipped_json: JSON.stringify(skipped) });
        return { ...p, graduated: { signatures: sigs, skipped, raisedUsd: p.raisedUsd, thresholdUsd: p.thresholdUsd } };
      } catch (e) {
        update({ status: 'failed', step, fail_reason: e.message.slice(0, 500), skipped_json: JSON.stringify(skipped) });
        log.warn(`[graduation] failed at ${step}: ${e.message}`);
        return { ...p, graduated: null, failed: e.message };
      }
    } finally { running = false; }
  }

  function list({ limit = 5 } = {}) {
    return db.prepare('SELECT * FROM vault_graduations WHERE vault = ? ORDER BY created_at DESC LIMIT ?').all(vaultWallet, limit).map(view);
  }

  return { plan, execute, list, GRADUATION: limits };
}

/** Production wiring: the curve's own client and Meteora's table of DAMM v2 configs by migration fee option. */
function productionGraduationDeps({ getClient }) {
  const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
  return { getClient, dammConfigFor: (opt) => sdk.DAMM_V2_MIGRATION_FEE_ADDRESS[opt] || null };
}

module.exports = { createGraduation, productionGraduationDeps, GRADUATION };
