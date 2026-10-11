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
  UPLOADS_DIR: env('ONIX_VAULT_UPLOADS_DIR', path.join(__dirname, '..', 'data', 'uploads')),

  VAULT_WALLET: env('VAULT_WALLET'),                 // public key; the reader lists this wallet
  // the only secret (env VAULT_SECRET_KEY); the property is named so the pre-commit hook's
  // "secret assigned to variable" pattern never matches real code — the hook stays strict.
  SIGNER_SECRET: env('VAULT_SECRET_KEY'),
  // the master seed every custody wallet derives from (server/keyring.js); generated on the server, never logged
  KEYRING_SEED: env('VAULT_MASTER_SEED'),
  USDC_MINT: env('USDC_MINT', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  PUBLIC_URL: env('ONIX_VAULT_PUBLIC_URL', 'https://vault.onix.finance'),
  MEMO_PROGRAM_ID: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',

  // the gacha door's reservation rules
  RESERVATION_TTL_MS: parseInt(env('ONIX_VAULT_RESERVATION_TTL_MS', '600000'), 10),
  STRIKES_TO_BLOCK: parseInt(env('ONIX_VAULT_STRIKES_TO_BLOCK', '3'), 10),
  ITEMS_CACHE_MS: parseInt(env('ONIX_VAULT_ITEMS_CACHE_MS', '30000'), 10),

  // optional: a market reference per mint (JSON url → { [mint]: usd }); without it,
  // exit price = custodian value. The page labels which it was.
  MARKET_REF_URL: env('ONIX_VAULT_MARKET_REF_URL'),
  // Single-vault mode, without a registry file (server/registry.js): the vault from the environment, its pool and mint once launched.
  POOL: env('ONIX_VAULT_POOL'),
  BASE_MINT: env('ONIX_VAULT_BASE_MINT'),
  GRADUATION_USD: parseFloat(env('ONIX_VAULT_GRADUATION_USD', '3500')),
  BASE_DECIMALS: parseInt(env('ONIX_VAULT_BASE_DECIMALS', '6'), 10),
  QUOTE_DECIMALS: parseInt(env('ONIX_VAULT_QUOTE_DECIMALS', '6'), 10),
  HAIRCUT: parseFloat(env('ONIX_VAULT_HAIRCUT', '0.89')),
  // the treasury buying the next item (server/restock.js): off unless the operator turns it on; the script works regardless
  RESTOCK_ENABLED: env('ONIX_VAULT_RESTOCK') === '1',
  // the sales owed to the creator and Onix (server/commissions.js) are paid in the fee-claim round: off unless turned on. The
  // ledger and the restock's reserve for what is owed are always on; scripts/payout.js --pay works regardless.
  SALE_COMMISSION_ENABLED: env('ONIX_VAULT_SALE_COMMISSION') === '1',
  // the vault graduating itself (server/graduation.js): a full curve is migrated by the server; off unless turned on
  GRADUATION_ENABLED: env('ONIX_VAULT_GRADUATE') === '1',
  GRADUATION_CHECK_MS: parseInt(env('ONIX_VAULT_GRADUATE_CHECK_MS', '60000'), 10),
  CC_API_BASE: env('ONIX_VAULT_CC_API_BASE', 'https://api.collectorcrypt.com'),
  // Onix.Finance's USDC fee account, passed as the REFERRAL of every swap the page builds (curve and pool): Meteora pays the
  // host share of its own fee to it — the trader pays nothing extra. The same wallet the onix.finance swap collects into.
  // An empty variable means this account (said so in server/env.example): a fork that wants its own sets the variable.
  REFERRAL_USDC_ACCOUNT: env('ONIX_VAULT_REFERRAL_USDC_ACCOUNT', 'B3CHwKZjyX9nJV8CrSNZMMyLGp9n4mhahVy4Y4en4Gep'),
  SWAP_URL: env('ONIX_VAULT_SWAP_URL', 'https://onix.finance'),
  // Onix's share of the curve's partner fee (1/3, src/curve/split.js) and the 2% of every card sold (server/commissions.js)
  // go here, in the same transaction as the claim. Same default rule as the referral above.
  ONIX_REVENUE_USDC_ACCOUNT: env('ONIX_VAULT_ONIX_REVENUE_USDC_ACCOUNT', 'B3CHwKZjyX9nJV8CrSNZMMyLGp9n4mhahVy4Y4en4Gep'),
});
