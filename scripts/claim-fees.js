#!/usr/bin/env node
/**
 * claim-fees.js — the Fees door, step 1: claim the partner fee from the curve into the
 * vault wallet's USDC account, and print the split it is owed to.
 *
 *   node --env-file=/opt/onixvault/.env scripts/claim-fees.js         # dry-run: claimable now, the split; signs nothing
 *   node --env-file=/opt/onixvault/.env scripts/claim-fees.js --go    # claim (the vault wallet is the fee claimer)
 *
 * Of what reaches the vault (after Meteora's 20% cut, taken by the program before this):
 *   50% buys the next item (the Cards buying agent, at its published rule)
 *   30% buys the token back on the curve
 *   20% operator
 * Every claim is appended to <data>/fee-claims.json with its signature, so the legs can be
 * paired with it publicly. The legs themselves are separate transactions (and scripts).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const { Connection, PublicKey } = require('@solana/web3.js');
const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
const C = require('../server/config');
const signerMod = require('../server/signer');
const { findVault } = require('../server/registry');
const { decodeVirtualPool } = require('../src/reader/pool');

const GO = process.argv.includes('--go');
const vi = process.argv.indexOf('--vault');
const DEF = findVault(vi >= 0 ? process.argv[vi + 1] : null);
const signer = DEF.secretEnv === 'VAULT_SECRET_KEY' ? signerMod : signerMod.fromEnv(DEF.secretEnv);
const MIN_USDC = parseFloat(process.env.ONIX_VAULT_FEE_CLAIM_MIN_USDC || '1');
const SPLIT = { card: 0.5, buyback: 0.3, operator: 0.2 };
const LEDGER = path.join(path.dirname(C.DB_PATH), DEF.id === '1' ? 'fee-claims.json' : `fee-claims-${DEF.id}.json`);
const log = (...a) => console.log(...a);
const usd = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

async function main() {
  if (!DEF.pool) throw new Error(`vault ${DEF.id} has no pool to claim from`);
  if (!signer.configured() || signer.publicKey() !== DEF.wallet) throw new Error('the configured key is not the vault wallet');
  const conn = new Connection(C.RPC_URL, 'confirmed');
  const vault = new PublicKey(DEF.wallet), pool = new PublicKey(DEF.pool);
  const acct = await conn.getAccountInfo(pool);
  if (!acct) throw new Error('pool account not found');
  const p = decodeVirtualPool(Uint8Array.from(acct.data));
  const claimable = Number(p.partnerQuoteFee.toString()) / 10 ** C.QUOTE_DECIMALS;
  const lifetime = Number(p.totalTradingQuoteFee.toString()) / 10 ** C.QUOTE_DECIMALS;
  log(`pool       ${pool.toBase58()}`);
  log(`fees       lifetime ${usd(lifetime)} (before Meteora's 20%) · claimable now ${usd(claimable)} · protocol's ${usd(Number(p.protocolQuoteFee.toString()) / 10 ** C.QUOTE_DECIMALS)}`);
  log(`split      card ${usd(claimable * SPLIT.card)} · buyback ${usd(claimable * SPLIT.buyback)} · operator ${usd(claimable * SPLIT.operator)}`);
  if (claimable < MIN_USDC) { log(`\n(below the ${usd(MIN_USDC)} minimum — nothing to claim yet)`); return; }
  if (!GO) { log('\n(dry-run: nothing signed. Re-run with --go to claim.)'); return; }

  const client = sdk.DynamicBondingCurveClient.create(conn, 'confirmed');
  const tx = await client.partner.claimPartnerTradingFee({ feeClaimer: vault, payer: vault, pool, maxBaseAmount: new BN(0), maxQuoteAmount: p.partnerQuoteFee });
  tx.feePayer = vault; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  // simulated BEFORE the vault key signs (the house rule; the RPC's preflight runs only after signing)
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) throw new Error(`the claim would fail on chain: ${JSON.stringify(sim.value.err)} · ${(sim.value.logs || []).slice(-2).join(' | ')}`);
  signer.signTransaction(tx);
  const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  const res = await conn.confirmTransaction(sig, 'confirmed');
  if (res.value.err) throw new Error(`claim FAILED on chain: ${JSON.stringify(res.value.err)} · ${sig}`);
  log(`\n  ✓ claimed ${usd(claimable)}  ${sig}`);
  const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : [];
  ledger.push({ at: new Date().toISOString(), signature: sig, claimedUsdc: claimable, split: { card: claimable * SPLIT.card, buyback: claimable * SPLIT.buyback, operator: claimable * SPLIT.operator }, legs: {} });
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
  log(`  ledger ${LEDGER} · next: the card leg (Cards agent), the buyback leg (trades/build sell side), the operator leg`);
}

main().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
