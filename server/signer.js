/**
 * server/signer.js — the only module that touches VAULT_SECRET_KEY.
 * Exposes publicKey() and signTransaction(); the secret never leaves, is never logged.
 */
'use strict';
const { Keypair } = require('@solana/web3.js');
const C = require('./config');

let kp = null;
function load() {
  if (kp) return kp;
  if (!C.SIGNER_SECRET) { const e = new Error('VAULT_SECRET_KEY not configured — the vault can list but cannot deliver'); e.statusCode = 503; throw e; }
  const s = String(C.SIGNER_SECRET).trim();
  if (s.startsWith('[')) kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
  else { const bs58 = require('bs58'); kp = Keypair.fromSecretKey((bs58.decode || bs58.default.decode)(s)); }
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
