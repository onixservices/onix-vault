#!/usr/bin/env node
/**
 * graduate.js — what happens after a curve fills, done by the operator when Meteora's keeper
 * has not (or to finish the parts that are ours): migrate the pool to DAMM v2, open the creator's
 * vesting locker, pull the migration fee (30% of the raise) into the vault's custody wallet, and
 * the leftover tokens. Dry-run by default; `--go` signs with the OPERATOR key (payer) and the
 * vault's custody key (fee claimer). Runs on the server.
 *
 *   node scripts/graduate.js --vault <id> [--go]
 */
'use strict';
const { PublicKey, Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { createServer } = require('../server/index');
const defaultSigner = require('../server/signer');
const chain = require('../server/chain');
const C = require('../server/config');

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const GO = process.argv.includes('--go');

async function send(label, tx, signers) {
  tx.recentBlockhash = await chain.getLatestBlockhash();
  const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  const sim = await chain.simulateTransaction(b64);
  if (sim && sim.err) { console.log(`   ${label}: would fail — ${JSON.stringify(sim.err)} ${(sim.logs || []).filter((l) => /Error Code|log:/.test(l)).slice(-2).join(' | ')}`); return null; }
  if (!GO) { console.log(`   ${label}: simulated ok (not signed)`); return null; }
  for (const s of signers) s.signTransaction(tx);
  const sig = await chain.sendRawTransaction(tx.serialize().toString('base64'));
  await chain.waitForSignature(sig, { timeoutMs: 90_000 });
  console.log(`   ${label}: ${sig}`);
  return sig;
}

async function main() {
  const id = arg('--vault');
  if (!id) throw new Error('usage: graduate.js --vault <id> [--go]');
  const { vaults } = createServer();
  const v = vaults.find((b) => b.meta.id === id);
  if (!v) throw new Error(`unknown vault ${id}`);
  if (!v.def.pool) throw new Error('this vault has no pool');
  const { Connection } = require('@solana/web3.js');
  const conn = new Connection(C.RPC_URL, 'confirmed');
  const client = sdk.DynamicBondingCurveClient.create(conn, 'confirmed');
  const poolPk = new PublicKey(v.def.pool);
  const r = await client.state.getPool(poolPk); const s = r.poolState || r;
  const cfg = await client.state.getPoolConfig(s.config);
  const payer = new PublicKey(defaultSigner.publicKey());
  const custody = new PublicKey(v.wallet);
  const raised = Number(s.quoteReserve.toString()) / 1e6, threshold = Number(cfg.migrationQuoteThreshold.toString()) / 1e6;
  console.log(`${GO ? 'GRADUATE (mainnet)' : 'graduate dry-run'} · ${v.meta.name} · pool ${v.def.pool}`);
  console.log(`raised $${raised} / threshold $${threshold} · isMigrated ${s.isMigrated} · creator ${s.creator.toBase58()} · feeClaimer ${cfg.feeClaimer.toBase58()} (${cfg.feeClaimer.equals(custody) ? 'custody ✓' : 'NOT custody'})`);
  console.log(`payer ${payer.toBase58()} ${(await chain.getBalanceLamports(payer.toBase58())) / LAMPORTS_PER_SOL} SOL\n`);
  if (raised + 1e-6 < threshold) throw new Error('the curve is not full yet');

  // 1. migrate to DAMM v2 (permissionless; the payer creates the pool and the two locked positions)
  if (!s.isMigrated) {
    const dammConfig = sdk.DAMM_V2_MIGRATION_FEE_ADDRESS[cfg.migrationFeeOption];
    if (!dammConfig) throw new Error(`no DAMM v2 config for migrationFeeOption ${cfg.migrationFeeOption}`);
    console.log(`1. migrateToDammV2 (fee option ${cfg.migrationFeeOption} → damm config ${dammConfig.toBase58()})`);
    const res = await client.migration.migrateToDammV2({ payer, pool: poolPk, dammConfig });
    const tx = res.transaction; tx.feePayer = payer;
    const extra = [res.firstPositionNftKeypair, res.secondPositionNftKeypair].filter(Boolean);
    const sig = await send('migrate', tx, [{ signTransaction: (t) => { if (extra.length) t.partialSign(...extra); return t; } }, defaultSigner]);
    if (!sig && GO) throw new Error('migration failed');
  } else console.log('1. already migrated');

  // 2. the creator's vesting locker (Meteora's Locker program): permissionless to open; the creator claims from it
  console.log('2. createLocker');
  try { const tx = await client.migration.createLocker({ payer, pool: poolPk }); tx.feePayer = payer; await send('locker', tx, [defaultSigner]); }
  catch (e) { console.log(`   locker: ${e.message.slice(0, 160)}`); }

  // 3. the migration fee (30% of the raise) → the fee claimer = custody
  console.log('3. partnerWithdrawMigrationFee → custody');
  try { const tx = await client.partner.partnerWithdrawMigrationFee({ pool: poolPk, sender: custody }); tx.feePayer = custody; await send('migration fee', tx, [v.signer]); }
  catch (e) { console.log(`   migration fee: ${e.message.slice(0, 160)}`); }

  // 4. leftover tokens (0.1% headroom) → custody
  console.log('4. withdrawLeftover → custody');
  try { const tx = await client.migration.withdrawLeftover({ payer: custody, pool: poolPk }); tx.feePayer = custody; await send('leftover', tx, [v.signer]); }
  catch (e) { console.log(`   leftover: ${e.message.slice(0, 160)}`); }
}

main().catch((e) => { console.error(`\n✗ ${e.message}`); process.exit(1); });
