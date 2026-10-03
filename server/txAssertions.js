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

/**
 * A venue's buy transaction: the buyer is the fee payer and its slot is EMPTY; any other signer must be a
 * co-signer that venue is known to use, and must arrive already signed by it (Collector Crypt co-signs its
 * buys with `cc3nov…` on a noop instruction — measured by Onix.Cards, Aug 2026, and on this vault, 3 Oct).
 * Looser than single-signer by design, so whoever uses it MUST also measure the money by simulation.
 */
function checkBuyerWithKnownCosigners(tx, buyer, cosigners = []) {
  const allowed = new Set(cosigners);
  const ours = tx.signatures[0];
  if (!ours) return { assertion: 'buyer', message: 'no signer' };
  if (ours.publicKey.toBase58() !== buyer || !tx.feePayer || tx.feePayer.toBase58() !== buyer) return { assertion: 'buyer-mismatch', message: `first signer / fee payer is not ${buyer}` };
  if (ours.signature !== null) return { assertion: 'pre-signed', message: "the buyer's slot came already signed" };
  for (let i = 1; i < tx.signatures.length; i += 1) {
    const k = tx.signatures[i].publicKey.toBase58();
    if (!allowed.has(k)) return { assertion: 'cosigner', message: `extra signer ${k} is not a known co-signer of this venue` };
    if (tx.signatures[i].signature === null) return { assertion: 'cosigner', message: `co-signer ${k} did not sign` };
  }
  return null;
}

module.exports = {
  checkBuyerWithKnownCosigners, checkSingleSignerUnsigned };
