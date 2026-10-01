#!/usr/bin/env node
/**
 * server/index.js — production wiring. The only place the pieces meet.
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
const { createTransferBuilder, productionDeps } = require('./transfer');
const { checkSingleSignerUnsigned } = require('./txAssertions');
const { createVaultService, VaultError } = require('./vaultService');
const { buildApp } = require('./app');

/**
 * Builds the whole server from the config, with any piece replaceable (the devnet
 * rehearsal swaps the items reader for a fixture and the signer for a throwaway
 * keypair; nothing else changes — the delivery path is the production one).
 */
function createServer({ readItems: readItemsOverride = null, db: dbOverride = null, signer = defaultSigner, vaultWallet = C.VAULT_WALLET, chain = defaultChain } = {}) {
  if (!vaultWallet) throw new Error('VAULT_WALLET not set');
  const db = dbOverride || getDb();
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
    // A frozen token, a wrong account set or a missing rent all show up here, not on chain.
    const sim = await chain.simulateTransaction(b64);
    if (sim?.err) throw new Error(`delivery would fail on chain: ${JSON.stringify(sim.err)} · ${(sim.logs || []).slice(-3).join(' | ')}`);
    signer.signTransaction(tx);
    const sig = encode(tx.signatures.find((s) => s.publicKey.toBase58() === from).signature);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    db.prepare('UPDATE vault_reservations SET delivery_tx_b64 = ?, updated_at = ? WHERE id = ?').run(signedB64, Date.now(), reservationId);
    try { await chain.sendRawTransaction(signedB64); }
    catch (e) { console.warn(`[vault] broadcast of delivery ${reservationId} failed (persisted; rebroadcast possible): ${e.message}`); }
    return { sig };
  };

  const service = createVaultService({
    db, readItems, chain, deliver,
    config: {
      vaultWallet, usdcMint: C.USDC_MINT, memoProgramId: C.MEMO_PROGRAM_ID,
      reservationTtlMs: C.RESERVATION_TTL_MS, strikesToBlock: C.STRIKES_TO_BLOCK, redeemPremium: C.REDEEM_PREMIUM,
    },
  });
  const stats = createStatsReader({ readItems, chain, config: { haircut: C.HAIRCUT, graduationUsd: C.GRADUATION_USD, pool: C.POOL, baseMint: C.BASE_MINT, baseDecimals: C.BASE_DECIMALS, quoteDecimals: C.QUOTE_DECIMALS }, cacheMs: C.ITEMS_CACHE_MS });
  const readWallet = createWalletReader({ rpcUrl: C.RPC_URL });
  const vaultMeta = { name: 'Vault #1', operator: 'Onix', custodians: ['Collector Crypt'], description: 'Graded trading cards in OmniVault, PWCC and PSA Vault' };
  const app = buildApp({ service, stats, readWallet, vaultWallet, vaultMeta, signerConfigured: signer.configured, itemsAge: readItems.ageMs || (() => null) });
  return { app, service, db };
}

function main() {
  const { app, service } = createServer();
  app.listen(C.PORT, '127.0.0.1', () => {
    console.log(`[vault] Onix.Vault server on 127.0.0.1:${C.PORT} · vault ${C.VAULT_WALLET} · signer ${defaultSigner.configured() ? 'configured' : 'NOT configured (list only)'}`);
  });
  setInterval(() => { try { service.sweepExpired(); } catch (e) { console.warn('[vault] sweep failed', e.message); } }, 60_000).unref();
}

if (require.main === module) main();
module.exports = { main, createServer };
