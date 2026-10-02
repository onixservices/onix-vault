#!/usr/bin/env node
/**
 * return-usdc.js — the OPERATOR's path to send USDC out of a vault wallet (closing a
 * vault, returning funds lent for a rehearsal). Dry-run by default; `--go` signs.
 *
 *   node scripts/return-usdc.js --vault <id> --to <wallet> --amount 25 [--go]
 *
 * Runs on the server with the server's environment. The transfer is one SPL
 * `transferChecked` from the vault's USDC account to the recipient's (created if
 * missing, paid by the vault); simulated before it is signed.
 */
'use strict';
const { Transaction, PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { createServer } = require('../server/index');
const { checkSingleSignerUnsigned } = require('../server/txAssertions');
const chain = require('../server/chain');
const C = require('../server/config');

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const GO = process.argv.includes('--go');

async function main() {
  const id = arg('--vault'), to = arg('--to'), amount = Number(arg('--amount'));
  if (!id || !to || !(amount > 0)) throw new Error('usage: return-usdc.js --vault <id> --to <wallet> --amount <usdc> [--go]');
  const { vaults } = createServer();
  const v = vaults.find((b) => b.meta.id === id);
  if (!v) throw new Error(`unknown vault id ${id}`);
  const from = new PublicKey(v.signer.publicKey()), toPk = new PublicKey(to), mint = new PublicKey(C.USDC_MINT);
  const fromAta = spl.getAssociatedTokenAddressSync(mint, from), toAta = spl.getAssociatedTokenAddressSync(mint, toPk);
  const has = Number((await chain.rpc('getTokenAccountBalance', [fromAta.toBase58()])).value.uiAmount || 0);
  console.log(`${GO ? 'RETURN USDC (mainnet)' : 'return-usdc dry-run'} · ${v.meta.name} ${from.toBase58()} has $${has} → ${to} $${amount}`);
  if (has < amount) throw new Error(`the vault has $${has}, less than $${amount}`);
  const tx = new Transaction({ feePayer: from, recentBlockhash: await chain.getLatestBlockhash() });
  const toInfo = await chain.rpc('getAccountInfo', [toAta.toBase58(), { encoding: 'base64' }]);
  if (!toInfo.value) tx.add(spl.createAssociatedTokenAccountInstruction(from, toAta, toPk, mint));
  tx.add(spl.createTransferCheckedInstruction(fromAta, mint, toAta, from, Math.round(amount * 1e6), 6));
  const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  const fail = checkSingleSignerUnsigned(Transaction.from(Buffer.from(b64, 'base64')), from.toBase58());
  if (fail) throw new Error(`assertions: ${fail.assertion}`);
  const sim = await chain.simulateTransaction(b64);
  if (sim && sim.err) throw new Error(`simulation: ${JSON.stringify(sim.err)} ${(sim.logs || []).slice(-2).join(' | ')}`);
  if (!GO) { console.log('ok (simulated, not signed). Repeat with --go.'); return; }
  v.signer.signTransaction(tx);
  const bs58 = require('bs58'); const encode = bs58.encode || bs58.default.encode;
  const sig = encode(tx.signatures.find((s) => s.publicKey.equals(from)).signature);
  await chain.sendRawTransaction(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'));
  console.log(`→ ${sig}`);
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
