/**
 * server/signer.js — the only module that touches VAULT_SECRET_KEY.
 * Exposes publicKey() and signTransaction(); the secret never leaves, is never logged.
 */
'use strict';
const { Keypair } = require('@solana/web3.js');
const C = require('./config');

function parseSecret(secret) {
  const s = String(secret).trim();
  if (s.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
  const bs58 = require('bs58'); return Keypair.fromSecretKey((bs58.decode || bs58.default.decode)(s));
}

let kp = null;
function load() {
  if (kp) return kp;
  if (!C.SIGNER_SECRET) { const e = new Error('VAULT_SECRET_KEY not configured — the vault can list but cannot deliver'); e.statusCode = 503; throw e; }
  kp = parseSecret(C.SIGNER_SECRET);
  return kp;
}

module.exports = {
  configured: () => Boolean(C.SIGNER_SECRET),
  publicKey: () => load().publicKey.toBase58(),
  signTransaction: (tx) => { tx.partialSign(load()); return tx; },
};

/**
 * A signer over a Keypair you already hold — for rehearsals and tests, where the
 * key is throwaway and generated at runtime. Production never calls this: its
 * key comes from the environment through the default export above.
 */
module.exports.fromKeypair = (keypair) => ({
  configured: () => true,
  publicKey: () => keypair.publicKey.toBase58(),
  signTransaction: (tx) => { tx.partialSign(keypair); return tx; },
});

/**
 * A signer over the secret found in a named env var — one per vault, lazily parsed, never
 * logged. `configured()` is false (not an error) when the var is empty: that vault lists
 * but cannot deliver.
 */
module.exports.fromEnv = (envName) => {
  let k = null;
  const get = () => { if (!k) { const v = process.env[envName]; if (!v) { const e = new Error(`${envName} not configured — this vault can list but cannot deliver`); e.statusCode = 503; throw e; } k = parseSecret(v); } return k; };
  return {
    configured: () => Boolean(process.env[envName]),
    publicKey: () => get().publicKey.toBase58(),
    signTransaction: (tx) => { tx.partialSign(get()); return tx; },
  };
};
