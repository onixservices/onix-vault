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

/**
 * Only the instructions a flow is known to need, nothing else. `shape` lists, per program, how many top-level
 * instructions may appear (`min`/`max`) and, when given, which 8-byte discriminators (hex) are accepted.
 * A program that is not in the shape is refused, whatever it does.
 */
function checkInstructionShape(tx, shape) {
  const byProgram = new Map(shape.map((s) => [s.programId, { ...s, n: 0 }]));
  for (const ix of tx.instructions) {
    const pid = ix.programId.toBase58();
    const rule = byProgram.get(pid);
    if (!rule) return { assertion: 'program', message: `program ${pid} is not one this flow uses` };
    if (rule.discriminators && !rule.discriminators.includes(Buffer.from(ix.data).subarray(0, 8).toString('hex'))) {
      return { assertion: 'instruction', message: `an instruction of ${rule.name || pid} that this flow does not use` };
    }
    rule.n += 1;
  }
  for (const r of byProgram.values()) {
    if (r.n < (r.min || 0)) return { assertion: 'shape', message: `expected ${r.min} instruction(s) of ${r.name || r.programId}, got ${r.n}` };
    if (r.max != null && r.n > r.max) return { assertion: 'shape', message: `at most ${r.max} instruction(s) of ${r.name || r.programId}, got ${r.n}` };
  }
  return null;
}

/** The priority fee a transaction asks for, in lamports (ComputeBudget price × limit; default limit 200k per instruction). */
function priorityFeeLamports(tx) {
  const CB = 'ComputeBudget111111111111111111111111111111';
  let price = 0n, limit = null;
  for (const ix of tx.instructions) {
    if (ix.programId.toBase58() !== CB) continue;
    const d = Buffer.from(ix.data);
    if (d[0] === 3 && d.length >= 9) price = d.readBigUInt64LE(1);
    if (d[0] === 2 && d.length >= 5) limit = BigInt(d.readUInt32LE(1));
  }
  const units = limit != null ? limit : BigInt(Math.min(1_400_000, 200_000 * tx.instructions.length));
  return Number((price * units) / 1_000_000n);
}

module.exports = {
  checkBuyerWithKnownCosigners, checkSingleSignerUnsigned, checkInstructionShape, priorityFeeLamports };
