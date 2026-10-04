#!/usr/bin/env node
/**
 * launch-mainnet.js — Vault #1's token, for real. The runbook's §2, as code.
 *
 *   node --env-file=/opt/onixvault/.env scripts/launch-mainnet.js [--vault <id>]        # dry-run: curve, prices, balances; signs nothing
 *   node --env-file=/opt/onixvault/.env scripts/launch-mainnet.js [--vault <id>] --go   # createConfig → read back → createPool → read back
 *
 * Runs ON THE SERVER as the vault user: the vault wallet (the server's own key, behind
 * server/signer.js) is payer, partner (fee claimer), leftover receiver and pool creator.
 * State lives in <data>/launch.json so a re-run resumes instead of repeating (a config
 * that exists is reused; a pool that exists is reused). Same parameters and SDK calls as
 * the devnet rehearsal of 1 Oct 2026 — only the quote mint (USDC) and the wallet differ.
 *
 * The initial market cap is the realisable backing of what is in the vault at launch
 * (read from the chain here, never typed in). Graduation: $3,500 (decided 30 Sep).
 * POINT OF NO RETURN: createPool mints the token and opens the curve to the public.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
const C = require('../server/config');
const signerMod = require('../server/signer');
const { findVault } = require('../server/registry');
const { paramsFor } = require('../src/curve/params');
const { fetchAssetsByOwner } = require('../src/reader/das');
const { parseCard, REALISABLE_MULTIPLIER } = require('../src/reader/backing');

const GO = process.argv.includes('--go');
const vi = process.argv.indexOf('--vault');
const DEF = findVault(vi >= 0 ? process.argv[vi + 1] : null);
const signer = DEF.secretEnv === 'VAULT_SECRET_KEY' ? signerMod : signerMod.fromEnv(DEF.secretEnv);
const TOKEN = { name: DEF.token.name, symbol: DEF.token.symbol, uri: `https://vault.onix.finance/token/${DEF.token.symbol.toLowerCase()}.json` };
const GRADUATION_USD = DEF.graduationUsd || C.GRADUATION_USD || 3500;
const MIN_SOL = 0.03;
const STATE = path.join(path.dirname(C.DB_PATH), DEF.id === '1' ? 'launch.json' : `launch-${DEF.id}.json`);
const MIN_BACKING_USD = DEF.id === '1' ? 50 : 5;
const log = (...a) => console.log(...a);
const usd = (n, d = 6) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });

function loadState() { return fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {}; }
function saveState(s) { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }

async function send(conn, tx, extraSigners, label) {
  tx.feePayer = new PublicKey(signer.publicKey());
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  // simulated BEFORE anything signs (the house rule; the RPC's preflight runs only after signing)
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) throw new Error(`${label} would fail on chain: ${JSON.stringify(sim.value.err)} · ${(sim.value.logs || []).slice(-2).join(' | ')}`);
  if (extraSigners.length) tx.partialSign(...extraSigners);
  signer.signTransaction(tx);
  const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  const res = await conn.confirmTransaction(sig, 'confirmed');
  if (res.value.err) throw new Error(`${label} FAILED on chain: ${JSON.stringify(res.value.err)} · ${sig}`);
  log(`  ✓ ${label}  ${sig}`);
  return sig;
}

async function main() {
  if (!C.RPC_URL) throw new Error('RPC_URL not configured');
  if (!signer.configured()) throw new Error(`${DEF.secretEnv} not configured`);
  if (signer.publicKey() !== DEF.wallet) throw new Error(`the key in ${DEF.secretEnv} is not the vault wallet ${DEF.wallet}`);
  const conn = new Connection(C.RPC_URL, 'confirmed');
  const client = sdk.DynamicBondingCurveClient.create(conn, 'confirmed');
  const vault = new PublicKey(DEF.wallet);
  const quoteMint = new PublicKey(C.USDC_MINT);
  const state = loadState();

  log(`ONIX.VAULT — ${GO ? 'LAUNCH (mainnet)' : 'launch dry-run'} · ${DEF.name} (vault ${DEF.id})\n`);
  log(`vault      ${vault.toBase58()}`);
  log(`quote      ${quoteMint.toBase58()} (USDC)`);
  const sol = (await conn.getBalance(vault)) / 1e9;
  log(`SOL        ${sol}`);

  // the backing, from the chain — this sets the opening price
  const assets = await fetchAssetsByOwner(C.RPC_URL, vault.toBase58());
  const cards = assets.map(parseCard).filter((c) => c.counts);
  const indexUsd = cards.reduce((s, c) => s + c.insuredUsd, 0);
  const realisableUsd = Math.round(indexUsd * REALISABLE_MULTIPLIER * 100) / 100;
  log(`backing    ${cards.length} items · index $${usd(indexUsd)} · realisable $${usd(realisableUsd)}`);
  if (cards.length < 1 || realisableUsd < MIN_BACKING_USD) throw new Error('not enough backing in the vault to open a curve on');

  // superseded by scripts/create-vault.js (custody + creator); kept runnable for the decided shape
  const { params } = paramsFor({ backingUsd: realisableUsd });
  const curve = sdk.buildCurveWithMarketCap(params);
  const dec = { base: params.token.tokenBaseDecimal, quote: params.token.tokenQuoteDecimal };
  const startPrice = sdk.getPriceFromSqrtPrice(curve.sqrtStartPrice, dec.base, dec.quote);
  log(`curve      start $${usd(startPrice.toString(), 10)}/token · supply ${usd(params.token.totalTokenSupply)} · opening mcap $${usd(realisableUsd)} · graduation $${usd(GRADUATION_USD)}`);
  log(`           quote to graduate ≈ $${usd(Number(curve.migrationQuoteThreshold.toString()) / 10 ** dec.quote)} · fee ${params.fee.baseFeeParams.feeSchedulerParam.startingFeeBps / 100}% flat`);
  log(`token      ${TOKEN.name} · $${TOKEN.symbol} · ${TOKEN.uri}`);
  if (state.config) log(`config     ${state.config} (exists)`);
  if (state.pool) log(`pool       ${state.pool} (exists) · mint ${state.baseMint}`);

  if (!GO) { log(`\n(dry-run: nothing signed. ${sol < MIN_SOL ? `NEED ≥ ${MIN_SOL} SOL in the vault wallet first.` : 'Re-run with --go to launch.'})`); return; }
  if (sol < MIN_SOL) throw new Error(`vault wallet has ${sol} SOL; needs ≥ ${MIN_SOL}`);

  // 1. config (reversible: a config with no pool is inert)
  let config;
  if (state.config) config = new PublicKey(state.config);
  else {
    const configKp = Keypair.generate();
    const tx = await client.partner.createConfig({ ...curve, config: configKp.publicKey, feeClaimer: vault, leftoverReceiver: vault, quoteMint, payer: vault });
    log('\n1. createConfig');
    await send(conn, tx, [configKp], 'config created');
    config = configKp.publicKey; state.config = config.toBase58(); state.configAt = new Date().toISOString(); saveState(state);
  }
  const cfg = await client.state.getPoolConfig(config);
  const okQuote = cfg.quoteMint.toBase58() === quoteMint.toBase58(), okClaimer = cfg.feeClaimer.toBase58() === vault.toBase58();
  log(`   read back  quoteMint=${okQuote ? 'ok' : 'MISMATCH'}  feeClaimer=${okClaimer ? 'ok' : 'MISMATCH'}  collectFeeMode=${cfg.collectFeeMode}  migrationOption=${cfg.migrationOption}`);
  if (!okQuote || !okClaimer) throw new Error('config read-back does not match — do NOT create the pool; create a new config');

  // 2. the pool — POINT OF NO RETURN
  let baseMint, pool;
  if (state.pool) { baseMint = new PublicKey(state.baseMint); pool = new PublicKey(state.pool); log(`\n2. pool exists: ${pool.toBase58()}`); }
  else {
    const baseMintKp = Keypair.generate();
    const tx = await client.creator.createPool({ ...TOKEN, payer: vault, poolCreator: vault, config, baseMint: baseMintKp.publicKey });
    log('\n2. createPool  (mints the token — irreversible)');
    await send(conn, tx, [baseMintKp], 'pool created');
    baseMint = baseMintKp.publicKey; pool = sdk.deriveDbcPoolAddress(quoteMint, baseMint, config);
    state.baseMint = baseMint.toBase58(); state.pool = pool.toBase58(); state.poolAt = new Date().toISOString(); saveState(state);
  }
  const vp = await client.state.getPool(pool);
  const ps = vp.poolState || vp;
  const price = sdk.getPriceFromSqrtPrice(ps.sqrtPrice, dec.base, dec.quote);
  log(`   read back  price $${usd(price.toString(), 10)}  baseMint=${ps.baseMint.toBase58() === baseMint.toBase58() ? 'ok' : 'MISMATCH'}  migrated=${ps.isMigrated}`);

  log(`\nDONE. Put these in the registry entry of vault ${DEF.id} (data/vaults.json) — or, for vault 1 without a registry, in .env — and restart pm2-onixvault:`);
  log(`"pool": "${pool.toBase58()}", "baseMint": "${baseMint.toBase58()}"`);
  log(`\nconfig ${config.toBase58()}`);
}

main().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
