#!/usr/bin/env node
/**
 * return-item.js — the OPERATOR's path to move an item OUT of a vault to a wallet,
 * outside the doors (closing a vault, returning a stray transfer, rehearsal cleanup).
 *
 *   node scripts/return-item.js --vault <id> --to <wallet>            # dry-run: every item
 *   node scripts/return-item.js --vault <id> --to <wallet> --mint <m>  # dry-run: one item
 *   … --go                                                             # sign and broadcast
 *
 * Runs on the server with the server's environment (same .env, same registry, same key).
 * Same path as a delivery: build → assert (single unsigned signer = the vault) → SIMULATE
 * → sign → broadcast. Every transfer is a public transaction; this script prints each one.
 * There is deliberately no HTTP route for this.
 */
'use strict';
const { Transaction } = require('@solana/web3.js');
const { createServer } = require('../server/index');
const { checkSingleSignerUnsigned } = require('../server/txAssertions');
const chain = require('../server/chain');

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const GO = process.argv.includes('--go');
const VAULT_ID = arg('--vault'), TO = arg('--to'), MINT = arg('--mint');

async function main() {
  if (!VAULT_ID || !TO) throw new Error('usage: return-item.js --vault <id> --to <wallet> [--mint <mint>] [--go]');
  const { vaults } = createServer();
  const v = vaults.find((b) => b.meta.id === VAULT_ID);
  if (!v) throw new Error(`unknown vault id ${VAULT_ID} (registry has: ${vaults.map((b) => b.meta.id).join(', ')})`);
  if (!v.signer.configured()) throw new Error('this vault has no signer configured');
  const from = v.signer.publicKey();
  if (from !== v.wallet) throw new Error(`signer ${from} is not the vault wallet ${v.wallet}`);

  const items = (await v.readItems()).filter((it) => !MINT || it.mint === MINT);
  if (!items.length) throw new Error(MINT ? `mint ${MINT} is not in vault ${VAULT_ID}` : `vault ${VAULT_ID} holds nothing`);
  console.log(`${GO ? 'RETURN (mainnet)' : 'return dry-run'} · vault ${v.meta.name} (${v.wallet}) → ${TO} · ${items.length} item(s)\n`);

  const bs58 = require('bs58'); const encode = bs58.encode || bs58.default.encode;
  const { createTransferBuilder, productionDeps } = require('../server/transfer');
  const transfer = createTransferBuilder(productionDeps(chain));
  let done = 0;
  for (const it of items) {
    process.stdout.write(`${it.mint}  ${(it.name || '').slice(0, 40).padEnd(40)}  $${it.custodianValueUsd ?? '—'}  `);
    const b64 = await transfer.buildTransferTx({ mint: it.mint, fromAddress: from, toAddress: TO, recentBlockhash: await chain.getLatestBlockhash() });
    const tx = Transaction.from(Buffer.from(b64, 'base64'));
    const fail = checkSingleSignerUnsigned(tx, from);
    if (fail) { console.log(`✗ assertions: ${fail.assertion}`); continue; }
    const sim = await chain.simulateTransaction(b64);
    if (sim && sim.err) { console.log(`✗ simulation: ${JSON.stringify(sim.err)} ${(sim.logs || []).slice(-2).join(' | ')}`); continue; }
    if (!GO) { console.log('ok (simulated, not signed)'); continue; }
    v.signer.signTransaction(tx);
    const sig = encode(tx.signatures.find((s) => s.publicKey.toBase58() === from).signature);
    await chain.sendRawTransaction(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'));
    console.log(`→ ${sig}`);
    done += 1;
  }
  console.log(`\n${GO ? `${done} transfer(s) broadcast` : 'dry-run: nothing signed. Repeat with --go.'}`);
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
