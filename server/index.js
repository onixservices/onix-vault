#!/usr/bin/env node
/**
 * server/index.js — production wiring. The only place the pieces meet.
 *
 * Delivery = build the transfer (origin = vault wallet) → assert single unsigned
 * signer → sign → PERSIST the signed tx on the reservation → broadcast. A crash
 * between persist and broadcast never delivers twice: the rebroadcast is the same
 * signature.
 */
'use strict';
const { Transaction } = require('@solana/web3.js');
const C = require('./config');
const chain = require('./chain');
const signer = require('./signer');
const { getDb } = require('./db');
const { createItemsReader } = require('./items');
const { createTransferBuilder, productionDeps } = require('./transfer');
const { checkSingleSignerUnsigned } = require('./txAssertions');
const { createVaultService, VaultError } = require('./vaultService');
const { buildApp } = require('./app');

function main() {
  if (!C.VAULT_WALLET) throw new Error('VAULT_WALLET not set');
  const db = getDb();
  const readItems = createItemsReader({ rpcUrl: C.RPC_URL, vaultWallet: C.VAULT_WALLET, marketRefUrl: C.MARKET_REF_URL, cacheMs: C.ITEMS_CACHE_MS });
  const transfer = createTransferBuilder(productionDeps(chain));
  const bs58 = require('bs58');
  const encode = bs58.encode || bs58.default?.encode;

  const deliver = async ({ mint, toAddress, reservationId }) => {
    if (!signer.configured()) throw new VaultError(503, 'vault signer not configured');
    const from = signer.publicKey();
    if (from !== C.VAULT_WALLET) throw new VaultError(503, `signer ${from} is not the configured vault wallet ${C.VAULT_WALLET}`);
    const b64 = await transfer.buildTransferTx({ mint, fromAddress: from, toAddress, recentBlockhash: await chain.getLatestBlockhash() });
    const tx = Transaction.from(Buffer.from(b64, 'base64'));
    const fail = checkSingleSignerUnsigned(tx, from);
    if (fail) throw new Error(`delivery tx does not pass assertions: ${fail.assertion}`);
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
      vaultWallet: C.VAULT_WALLET, usdcMint: C.USDC_MINT, memoProgramId: C.MEMO_PROGRAM_ID,
      reservationTtlMs: C.RESERVATION_TTL_MS, strikesToBlock: C.STRIKES_TO_BLOCK, redeemPremium: C.REDEEM_PREMIUM,
    },
  });
  const app = buildApp({ service, vaultWallet: C.VAULT_WALLET, signerConfigured: signer.configured, itemsAge: readItems.ageMs });
  app.listen(C.PORT, '127.0.0.1', () => {
    console.log(`[vault] Onix.Vault server on 127.0.0.1:${C.PORT} · vault ${C.VAULT_WALLET} · signer ${signer.configured() ? 'configured' : 'NOT configured (list only)'}`);
  });
  setInterval(() => { try { service.sweepExpired(); } catch (e) { console.warn('[vault] sweep failed', e.message); } }, 60_000).unref();
}

if (require.main === module) main();
module.exports = { main };
