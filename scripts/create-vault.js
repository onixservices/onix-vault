#!/usr/bin/env node
/**
 * create-vault.js — open a vault through the SAME door the page uses, with a server-side key
 * as the creator (no Phantom). This is how the operator's own vault is (re)launched, and the
 * rehearsal of the whole path: open → deposit → deposited (config, Onix pays) → launch → confirm.
 *
 *   node scripts/create-vault.js --name "Vault #1" --symbol VEONIX --mints a,b,c [--creator-env VAULT_SECRET_KEY]
 *                                [--category mixed] [--grad 2.5] [--fee 40] [--description "…"] [--go]
 *
 * Dry-run by default: reads the creator's wallet, prints what would open (items, backing, curve)
 * and stops before anything is signed. `--go` signs the deposits, waits, creates the config,
 * signs the launch, confirms, and prints the vault. Runs ON THE SERVER with its environment.
 */
'use strict';
const { Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createServer } = require('../server/index');
const defaultSigner = require('../server/signer');
const chain = require('../server/chain');

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const GO = process.argv.includes('--go');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signAndSend(signer, b64) {
  const tx = Transaction.from(Buffer.from(b64, 'base64'));
  signer.signTransaction(tx);
  const sig = await chain.sendRawTransaction(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'));
  await chain.waitForSignature(sig, { timeoutMs: 90_000 });
  return sig;
}

async function main() {
  const name = arg('--name'), symbol = String(arg('--symbol', '')).toUpperCase(), mints = String(arg('--mints', '')).split(',').map((s) => s.trim()).filter(Boolean);
  if (!name || !symbol || !mints.length) throw new Error('usage: create-vault.js --name <n> --symbol <S> --mints a,b,c [--creator-env VAULT_SECRET_KEY] [--category] [--grad] [--fee] [--description] [--go]');
  const creatorEnv = arg('--creator-env', 'VAULT_SECRET_KEY');
  const signer = creatorEnv === 'VAULT_SECRET_KEY' ? defaultSigner : defaultSigner.fromEnv(creatorEnv);
  if (!signer.configured()) throw new Error(`${creatorEnv} is not set`);
  const owner = signer.publicKey();
  const rules = { category: arg('--category', 'mixed'), gradMult: Number(arg('--grad', 2.5)), creatorFeePct: Number(arg('--fee', 40)) };
  const { creator } = createServer();

  console.log(`${GO ? 'CREATE VAULT (mainnet)' : 'create-vault dry-run'} · creator ${owner} · ${name} · $${symbol} · ${mints.length} item(s)\n`);
  const q = await creator.quote({ owner, rules });
  const picked = q.items.filter((it) => mints.includes(it.mint));
  const missing = mints.filter((m) => !picked.some((it) => it.mint === m));
  for (const it of picked) console.log(`  ${it.mint}  ${(it.name || '').slice(0, 40).padEnd(40)}  $${it.custodianValueUsd}`);
  if (missing.length) throw new Error(`not eligible or not held by the creator: ${missing.join(', ')}`);
  const idx = picked.reduce((s, it) => s + it.custodianValueUsd, 0), real = Math.round(idx * 0.89 * 100) / 100;
  console.log(`\nbacking     index $${idx} · realisable $${real}`);
  console.log(`curve       opens $${Math.round(real * 2 * 100) / 100} · graduates $${Math.round(real * 2 * rules.gradMult * 100) / 100} (${rules.gradMult}×) · creator fee ${rules.creatorFeePct}% · gas to custody ${q.gasSol} SOL`);
  const sol = (await chain.getBalanceLamports(owner)) / LAMPORTS_PER_SOL;
  console.log(`creator SOL ${sol}  (needs ≈ ${q.gasSol} gas + ~0.03 launch)`);
  if (!GO) { console.log('\n(dry-run: nothing signed. Repeat with --go.)'); return; }

  // 1. open → custody + deposit transactions
  const o = await creator.open({ owner, name, symbol, mints, rules, description: arg('--description') });
  console.log(`\n1. opened ${o.creationId} · custody ${o.custodyWallet} · ${o.depositTransactions.length} deposit tx(s)`);
  for (const [i, b64] of o.depositTransactions.entries()) console.log(`   deposit ${i + 1}: ${await signAndSend(signer, b64)}`);

  // 2. deposited → config (Onix pays) → launch tx
  let d = null;
  for (let t = 0; t < 10 && !d; t++) { try { d = await creator.deposited({ creationId: o.creationId }); } catch (e) { if (e.statusCode === 409) { console.log(`   waiting for custody to show the items… (${e.message})`); await sleep(5000); } else throw e; } }
  if (!d) throw new Error('custody never showed the items');
  console.log(`2. config ${d.config} · pool ${d.pool} · mint ${d.baseMint} · graduates $${d.curve.graduationUsd}`);

  // 3. launch — the creator signs the unsigned tx; the server completes with the mint key
  const tx = Transaction.from(Buffer.from(d.transaction, 'base64'));
  signer.signTransaction(tx);
  const s = await creator.submit({ creationId: o.creationId, signedTransaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') });
  console.log(`3. launched ${s.signature}`);
  await chain.waitForSignature(s.signature, { timeoutMs: 90_000 });

  // 4. confirm → registered and served
  let def = null;
  for (let t = 0; t < 10 && !def; t++) { try { def = await creator.confirm({ creationId: o.creationId, signature: s.signature }); } catch (e) { if (e.statusCode === 409) await sleep(3000); else throw e; } }
  if (!def) throw new Error('pool not visible after launch');
  console.log(`4. vault ${def.id} · custody ${def.wallet} (index ${def.custodyIndex}) · creator ${def.creator} · pool ${def.pool}`);
  console.log('\nRestart the API (systemctl restart pm2-onixvault) so the running server mounts it, or it appears on its next boot.');
}

main().catch((e) => { console.error(`\n✗ ${e.statusCode || ''} ${e.message}`); process.exit(1); });
