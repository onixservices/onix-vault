#!/usr/bin/env node
/**
 * server/index.js — production wiring. The only place the pieces meet.
 *
 * One server, N vaults (server/registry.js). Each vault is a BUNDLE: its own wallet and
 * signer (an env var named in the registry), items reader, stats, admissions, trader and
 * delivery — over one shared DB where every row carries its vault.
 *
 * Delivery = build the transfer (origin = vault wallet) → assert single unsigned
 * signer → SIMULATE (a delivery that would fail on chain is never signed) → sign →
 * PERSIST the signed tx on the reservation → broadcast. A crash between persist and
 * broadcast never delivers twice: the rebroadcast is the same signature.
 */
'use strict';
const { Transaction } = require('@solana/web3.js');
const C = require('./config');
const defaultChain = require('./chain');
const defaultSigner = require('./signer');
const { getDb } = require('./db');
const { createItemsReader } = require('./items');
const { createStatsReader } = require('./stats');
const { createWalletReader } = require('./wallet');
const { createCurveTrader, productionCurveDeps } = require('./curve');
const { createAdmissions, VAULT_RULES } = require('./admissions');
const { loadVaults } = require('./registry');
const das = require('../src/reader/das');
const { createTransferBuilder, productionDeps } = require('./transfer');
const { checkSingleSignerUnsigned } = require('./txAssertions');
const { createVaultService, VaultError } = require('./vaultService');
const { buildApp } = require('./app');

/**
 * Everything one vault needs, from its registry entry. Any piece replaceable (the devnet
 * rehearsal swaps the items reader for a fixture and the signer for a throwaway keypair;
 * the delivery path is the production one).
 */
function createVaultBundle(def, { db, chain, readItems: readItemsOverride = null, signer: signerOverride = null }) {
  const vaultWallet = def.wallet;
  const signer = signerOverride || (def.secretEnv === 'VAULT_SECRET_KEY' ? defaultSigner : defaultSigner.fromEnv(def.secretEnv));
  const readItems = readItemsOverride || createItemsReader({ rpcUrl: C.RPC_URL, vaultWallet, marketRefUrl: C.MARKET_REF_URL, cacheMs: C.ITEMS_CACHE_MS });
  const transfer = createTransferBuilder(productionDeps(chain));
  const bs58 = require('bs58');
  const encode = bs58.encode || bs58.default?.encode;

  const deliver = async ({ mint, toAddress, reservationId }) => {
    if (!signer.configured()) throw new VaultError(503, 'vault signer not configured');
    const from = signer.publicKey();
    if (from !== vaultWallet) throw new VaultError(503, `signer ${from} is not the configured vault wallet ${vaultWallet}`);
    const b64 = await transfer.buildTransferTx({ mint, fromAddress: from, toAddress, recentBlockhash: await chain.getLatestBlockhash() });
    const tx = Transaction.from(Buffer.from(b64, 'base64'));
    const fail = checkSingleSignerUnsigned(tx, from);
    if (fail) throw new Error(`delivery tx does not pass assertions: ${fail.assertion}`);
    // The deliverability check the gacha has used since Aug 2026: simulate before signing.
    const sim = await chain.simulateTransaction(b64);
    if (sim?.err) throw new Error(`delivery would fail on chain: ${JSON.stringify(sim.err)} · ${(sim.logs || []).slice(-3).join(' | ')}`);
    signer.signTransaction(tx);
    const sig = encode(tx.signatures.find((s) => s.publicKey.toBase58() === from).signature);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    db.prepare('UPDATE vault_reservations SET delivery_tx_b64 = ?, updated_at = ? WHERE id = ?').run(signedB64, Date.now(), reservationId);
    try { await chain.sendRawTransaction(signedB64); }
    catch (e) { console.warn(`[vault ${def.id}] broadcast of delivery ${reservationId} failed (persisted; rebroadcast possible): ${e.message}`); }
    return { sig };
  };

  const service = createVaultService({
    db, readItems, chain, deliver,
    config: { vaultWallet, usdcMint: C.USDC_MINT, memoProgramId: C.MEMO_PROGRAM_ID, reservationTtlMs: C.RESERVATION_TTL_MS, strikesToBlock: C.STRIKES_TO_BLOCK, redeemPremium: C.REDEEM_PREMIUM },
  });
  const stats = createStatsReader({ readItems, chain, config: { haircut: C.HAIRCUT, graduationUsd: def.graduationUsd, pool: def.pool, baseMint: def.baseMint, baseDecimals: C.BASE_DECIMALS, quoteDecimals: C.QUOTE_DECIMALS }, cacheMs: C.ITEMS_CACHE_MS });
  const admissions = createAdmissions({ db, chain, vaultWallet, rules: def.rules, rpcUrl: C.RPC_URL, fetchAssets: das.fetchAssetsByOwner, buildTransfer: (a) => transfer.buildTransferTx(a), haircut: C.HAIRCUT });
  const trader = def.pool ? createCurveTrader({ pool: def.pool, baseDecimals: C.BASE_DECIMALS, quoteDecimals: C.QUOTE_DECIMALS, quoteMint: C.USDC_MINT, baseMint: def.baseMint, ...productionCurveDeps({ rpcUrl: C.RPC_URL, chain }) }) : null;
  const meta = { id: def.id, name: def.name, operator: def.operator, custodians: def.custodians, description: def.description, token: def.token, graduationUsd: def.graduationUsd };
  return { wallet: vaultWallet, def, meta, service, stats, admissions, trader, readItems, signer, itemsAge: readItems.ageMs || (() => null), signerConfigured: signer.configured };
}

/**
 * Builds the whole server from the registry (or, for a rehearsal, from the one vault
 * passed in with its pieces).
 */
function createServer({ readItems = null, db: dbOverride = null, signer = null, vaultWallet = null, chain = defaultChain, vaults: defs = null } = {}) {
  const db = dbOverride || getDb();
  const list = defs || (vaultWallet
    ? [{ id: '1', name: 'Vault #1', operator: 'Onix', wallet: vaultWallet, secretEnv: 'VAULT_SECRET_KEY', rules: VAULT_RULES.vault1, custodians: VAULT_RULES.vault1.custodians, pool: C.POOL || null, baseMint: C.BASE_MINT || null, graduationUsd: C.GRADUATION_USD, token: { name: 'Veonix', symbol: 'VEONIX', image: '/token/veonix.png' } }]
    : loadVaults());
  const bundles = list.map((def, i) => createVaultBundle(def, { db, chain, readItems: i === 0 ? readItems : null, signer: i === 0 ? signer : null }));
  // rows written before the `vault` column existed belong to the primary vault
  for (const t of ['vault_reservations', 'vault_redemptions', 'vault_admissions']) db.prepare(`UPDATE ${t} SET vault = ? WHERE vault IS NULL`).run(bundles[0].wallet);
  const readWallet = createWalletReader({ rpcUrl: C.RPC_URL });
  const app = buildApp({ vaults: bundles, readWallet });
  const primary = bundles[0];
  return { app, db, vaults: bundles, service: primary.service, admissions: primary.admissions };
}

function main() {
  const { app, vaults } = createServer();
  app.listen(C.PORT, '127.0.0.1', () => {
    for (const v of vaults) console.log(`[vault] ${v.meta.name} (${v.meta.id}) · ${v.wallet} · pool ${v.def.pool || '—'} · signer ${v.signerConfigured() ? 'configured' : 'NOT configured (list only)'}`);
    console.log(`[vault] Onix.Vault server on 127.0.0.1:${C.PORT} · ${vaults.length} vault(s)`);
  });
  setInterval(() => { for (const v of vaults) { try { v.service.sweepExpired(); } catch (e) { console.warn(`[vault ${v.meta.id}] sweep failed`, e.message); } } }, 60_000).unref();
  setInterval(() => { for (const v of vaults) v.admissions.verifyPending().then((r) => { if (r.verified) console.log(`[vault ${v.meta.id}] ${r.verified} admission(s) verified on chain`); }).catch((e) => console.warn(`[vault ${v.meta.id}] admissions verify failed`, e.message)); }, 45_000).unref();
}

if (require.main === module) main();
module.exports = { main, createServer, createVaultBundle };
