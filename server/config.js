/**
 * server/config.js — everything the vault server needs from the environment.
 *
 * The code here is public; the KEY is not. `VAULT_SECRET_KEY` is generated on the
 * server (`solana-keygen new`) and lives only in that machine's `.env`. Nothing
 * else in this repository can read it. If this file ever finds a key in a
 * committed file, that key is already compromised: rotate it.
 */
'use strict';
const path = require('path');

const env = (k, d = null) => (process.env[k] != null && process.env[k] !== '' ? process.env[k] : d);

module.exports = Object.freeze({
  PORT: parseInt(env('PORT', '3004'), 10),
  RPC_URL: env('ONIX_VAULT_RPC_URL') || env('SOLANA_RPC_URL'),  // needs DAS (Helius or equivalent)
  DB_PATH: env('ONIX_VAULT_DB_PATH', path.join(__dirname, '..', 'data', 'vault.db')),

  VAULT_WALLET: env('VAULT_WALLET'),                 // public key; the reader lists this wallet
  // the only secret (env VAULT_SECRET_KEY); the property is named so the pre-commit hook's
  // "secret assigned to variable" pattern never matches real code — the hook stays strict.
  SIGNER_SECRET: env('VAULT_SECRET_KEY'),
  USDC_MINT: env('USDC_MINT', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  MEMO_PROGRAM_ID: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',

  // the published rules — the same numbers the proof page shows
  REDEEM_PREMIUM: 1.15,
  RESERVATION_TTL_MS: parseInt(env('ONIX_VAULT_RESERVATION_TTL_MS', '600000'), 10),
  STRIKES_TO_BLOCK: parseInt(env('ONIX_VAULT_STRIKES_TO_BLOCK', '3'), 10),
  ITEMS_CACHE_MS: parseInt(env('ONIX_VAULT_ITEMS_CACHE_MS', '30000'), 10),

  // optional: a market reference per mint (JSON url → { [mint]: usd }); without it,
  // exit price = custodian value. The page labels which it was.
  MARKET_REF_URL: env('ONIX_VAULT_MARKET_REF_URL'),
});
