/**
 * server/txAssertions.js — exactly one required signer, who is the fee payer and
 * the address we expect, and no signature already present. A transaction that
 * fails this is never signed. (Rule learned the hard way with Phantom: a foreign
 * pre-signature makes the wallet refuse to simulate.)
 */
'use strict';

function checkSingleSignerUnsigned(tx, expectedSigner) {
  if (tx.signatures.length !== 1) return { assertion: 'single-signer', message: `${tx.signatures.length} signers required (expected 1)` };
  const signer = tx.signatures[0].publicKey.toBase58();
  if (signer !== expectedSigner || tx.feePayer?.toBase58() !== expectedSigner) {
    return { assertion: 'signer-mismatch', message: `signer=${signer} feePayer=${tx.feePayer} expected=${expectedSigner}` };
  }
  if (!tx.signatures.every((s) => s.signature === null)) return { assertion: 'pre-signed', message: 'transaction already carries a signature' };
  return null;
}

module.exports = { checkSingleSignerUnsigned };
