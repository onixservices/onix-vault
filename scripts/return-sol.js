#!/usr/bin/env node
/**
 * return-sol.js — the OPERATOR's path to send the SOL a custody wallet holds back to a wallet
 * (an abandoned creation, a closed vault). Dry-run by default; `--go` signs with the derived key.
 *
 *   node scripts/return-sol.js --index <custodyIndex> --to <wallet> [--keep 0] [--go]
 */
'use strict';
const { Transaction, PublicKey, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const keyring = require('../server/keyring');
const chain = require('../server/chain');
const { checkSingleSignerUnsigned } = require('../server/txAssertions');

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const GO = process.argv.includes('--go');
const FEE = 5000;

async function main() {
  const index = Number(arg('--index')), to = arg('--to'), keep = Math.round(Number(arg('--keep', 0)) * LAMPORTS_PER_SOL);
  if (!Number.isInteger(index) || !to) throw new Error('usage: return-sol.js --index <n> --to <wallet> [--keep sol] [--go]');
  const signer = keyring.custodySigner(index);
  if (!signer.configured()) throw new Error('VAULT_MASTER_SEED not configured');
  const from = new PublicKey(signer.publicKey());
  const bal = await chain.getBalanceLamports(from.toBase58());
  const amount = bal - FEE - keep;
  console.log(`${GO ? 'RETURN SOL (mainnet)' : 'return-sol dry-run'} · custody #${index} ${from.toBase58()} has ${bal / LAMPORTS_PER_SOL} SOL → ${to} ${amount / LAMPORTS_PER_SOL} SOL`);
  if (amount <= 0) throw new Error('nothing to return');
  const tx = new Transaction({ feePayer: from, recentBlockhash: await chain.getLatestBlockhash() });
  tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(to), lamports: amount }));
  const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  const fail = checkSingleSignerUnsigned(Transaction.from(Buffer.from(b64, 'base64')), from.toBase58());
  if (fail) throw new Error(`assertions: ${fail.assertion}`);
  const sim = await chain.simulateTransaction(b64);
  if (sim && sim.err) throw new Error(`simulation: ${JSON.stringify(sim.err)}`);
  if (!GO) { console.log('ok (simulated, not signed). Repeat with --go.'); return; }
  signer.signTransaction(tx);
  const bs58 = require('bs58'); const encode = bs58.encode || bs58.default.encode;
  const sig = encode(tx.signatures.find((s) => s.publicKey.equals(from)).signature);
  await chain.sendRawTransaction(tx.serialize().toString('base64'));
  console.log(`→ ${sig}`);
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
