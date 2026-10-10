#!/usr/bin/env node
/**
 * rehearse-vault-devnet.js — the vault API, end to end, against DEVNET.
 *
 *   ONIX_VAULT_DEVNET_RPC=<devnet rpc with DAS> node scripts/rehearse-vault-devnet.js
 *
 * Same server code as production (`server/index.js` → createServer), with the
 * throwaway parts a rehearsal needs:
 *   - a throwaway VAULT wallet generated into `.devnet/` (never committed);
 *   - a test NFT (classic Token Metadata NFT) minted into that vault wallet;
 *   - the integrator = the devnet rehearsal wallet from rehearse-devnet.js, paying in
 *     the throwaway tUSDC mint created there;
 *   - the items reader replaced by a fixture naming the test NFT as a "test custodian"
 *     item worth $20 — nothing else differs.
 *
 * Then the integrator does what any integrator would: items → reserve → sign the
 * payment transaction the vault built → send → settle (retry while not finalized) →
 * and we read the NFT's owner back from the chain to prove the delivery.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const tm = require('@metaplex-foundation/mpl-token-metadata');

const RPC = process.env.ONIX_VAULT_DEVNET_RPC || 'https://api.devnet.solana.com';
const DIR = path.join(__dirname, '..', '.devnet');
const STATE = path.join(DIR, 'state.json');
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadOrCreate(file) {
  const p = path.join(DIR, file);
  if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
  const kp = Keypair.generate(); fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey))); return kp;
}

async function mintTestNft(conn, payer, owner, name) {
  const mint = await spl.createMint(conn, payer, payer.publicKey, payer.publicKey, 0); // freeze authority: the master edition requires one
  const ata = await spl.getOrCreateAssociatedTokenAccount(conn, payer, mint, owner);
  await spl.mintTo(conn, payer, mint, ata.address, payer, 1);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), tm.PROGRAM_ID.toBuffer(), mint.toBuffer()], tm.PROGRAM_ID);
  const ix = tm.createCreateMetadataAccountV3Instruction(
    { metadata, mint, mintAuthority: payer.publicKey, payer: payer.publicKey, updateAuthority: payer.publicKey },
    { createMetadataAccountArgsV3: { data: { name, symbol: 'TVLT', uri: 'https://onix.finance/vault/test-item.json', sellerFeeBasisPoints: 0, creators: null, collection: null, uses: null }, isMutable: true, collectionDetails: null } },
  );
  // the master edition is what makes DAS call it V1_NFT (without it: FungibleAsset,
  // which the delivery refuses by design — real cards always have one)
  const [edition] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), tm.PROGRAM_ID.toBuffer(), mint.toBuffer(), Buffer.from('edition')], tm.PROGRAM_ID);
  const edIx = tm.createCreateMasterEditionV3Instruction(
    { edition, mint, updateAuthority: payer.publicKey, mintAuthority: payer.publicKey, payer: payer.publicKey, metadata },
    { createMasterEditionArgs: { maxSupply: 0 } },
  );
  await sendAndConfirmTransaction(conn, new Transaction().add(ix, edIx), [payer], { commitment: 'confirmed' });
  return mint;
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  if (!state.quoteMint) throw new Error('run scripts/rehearse-devnet.js first (it creates the tUSDC mint and funds the integrator wallet)');
  const integrator = loadOrCreate('rehearsal-wallet.json');
  const vaultKp = loadOrCreate('vault-wallet.json');
  const winner = Keypair.generate();
  const tUSDC = new PublicKey(state.quoteMint);

  log('ONIX.VAULT — vault API rehearsal on DEVNET\n');
  log(`integrator ${integrator.publicKey.toBase58()}`);
  log(`vault      ${vaultKp.publicKey.toBase58()}  (throwaway)`);
  log(`winner     ${winner.publicKey.toBase58()}  (fresh)\n`);

  // the vault wallet needs a little SOL for the delivery's ATA + fee
  if ((await conn.getBalance(vaultKp.publicKey)) < 0.05 * LAMPORTS_PER_SOL) {
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: integrator.publicKey, toPubkey: vaultKp.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })), [integrator]);
    log('  ✓ 0.1 SOL to the vault wallet for fees/rent');
  }

  // a test item in the vault
  let testMint;
  if (state.testItemMint && (await conn.getTokenAccountBalance(spl.getAssociatedTokenAddressSync(new PublicKey(state.testItemMint), vaultKp.publicKey)).catch(() => ({ value: { uiAmount: 0 } }))).value.uiAmount === 1) {
    testMint = new PublicKey(state.testItemMint);
    log(`item       ${testMint.toBase58()}  (reused, still in the vault)`);
  } else {
    testMint = await mintTestNft(conn, integrator, vaultKp.publicKey, 'Test item (devnet)');
    state.testItemMint = testMint.toBase58();
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
    log(`item       ${testMint.toBase58()}  (minted into the vault)`);
  }

  // the SERVER, same code as production; the throwaway signer and the fixture reader
  // are injected, the rest (RPC, quote mint, DB path) comes through the environment
  process.env.ONIX_VAULT_RPC_URL = RPC;
  process.env.USDC_MINT = tUSDC.toBase58();
  process.env.ONIX_VAULT_DB_PATH = path.join(DIR, 'vault-rehearsal.db');
  const { createServer } = require('../server/index');
  const { fromKeypair } = require('../server/signer');
  const fixtureReader = async () => [{ mint: testMint.toBase58(), custodian: 'test-custodian', name: 'Test item (devnet)', category: 'Test', custodianValueUsd: 20, custodianValueBasis: 'fixture', marketRefUsd: null }];
  const { app } = createServer({ readItems: fixtureReader, signer: fromKeypair(vaultKp), vaultWallet: vaultKp.publicKey.toBase58() });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  log(`\nserver     ${baseUrl}  (in-process, production code, fixture reader)`);

  // the INTEGRATOR, through the public client
  const { createVaultClient } = require('../examples/integrator/vaultClient');
  const vault = createVaultClient({ baseUrl, vault: vaultKp.publicKey.toBase58() });

  const items = await vault.items();
  log(`\n1. items      ${items.length} → ${items[0].mint.slice(0, 8)}… exit $${items[0].exitPriceUsd} (${items[0].exitPriceBasis})`);

  const r = await vault.reserve({ mint: testMint.toBase58(), integrator: integrator.publicKey.toBase58(), winner: winner.publicKey.toBase58(), idempotencyKey: `rehearsal-${Date.now()}` });
  log(`2. reserve    ${r.reservationId} · $${r.exitPriceUsd} · expires in ${Math.round((r.expiresAt - Date.now()) / 1000)} s · paymentTransaction ${r.paymentTransaction.length} b64 chars`);

  const payTx = Transaction.from(Buffer.from(r.paymentTransaction, 'base64'));
  if (payTx.signatures.length !== 1 || payTx.feePayer.toBase58() !== integrator.publicKey.toBase58()) throw new Error('payment tx is not single-signer=integrator');
  payTx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; // the vault's blockhash may be older than our round trip
  const paySig = await sendAndConfirmTransaction(conn, payTx, [integrator], { commitment: 'finalized' });
  log(`3. paid       ${paySig}  (signed by the integrator, sent by the integrator, finalized)`);

  let settled;
  for (let i = 0; i < 20; i++) {
    try { settled = await vault.settle(r.reservationId, paySig); break; }
    catch (e) { if (e.statusCode === 409) { log(`   settle → 409 (${e.message}); retrying…`); await sleep(3000); continue; } throw e; }
  }
  if (!settled) throw new Error('never settled');
  log(`4. settled    status=${settled.status} · delivery ${settled.deliverySignature}`);

  // proof: the chain says the winner owns the item
  for (let i = 0; i < 20; i++) {
    const st = (await conn.getSignatureStatuses([settled.deliverySignature])).value[0];
    if (st && ['confirmed', 'finalized'].includes(st.confirmationStatus) && !st.err) break;
    if (st?.err) throw new Error(`delivery failed on chain: ${JSON.stringify(st.err)}`);
    await sleep(2000);
  }
  const winnerBal = (await conn.getTokenAccountBalance(spl.getAssociatedTokenAddressSync(testMint, winner.publicKey))).value.uiAmount;
  const vaultBal = (await conn.getTokenAccountBalance(spl.getAssociatedTokenAddressSync(testMint, vaultKp.publicKey)).catch(() => ({ value: { uiAmount: 0 } }))).value.uiAmount;
  log(`5. on chain   winner holds ${winnerBal} · vault holds ${vaultBal}`);
  const trail = await vault.status(r.reservationId);
  log(`6. trail      ${JSON.stringify({ status: trail.status, paymentSignature: trail.paymentSignature, deliverySignature: trail.deliverySignature })}`);

  server.close();
  if (winnerBal !== 1 || vaultBal !== 0) throw new Error('delivery did not land where it should');
  log('\nDONE. Reserve → pay (built by the vault, signed by the integrator) → settle (payment read from the chain) → delivered by the vault wallet. Same code as production.');
}

main().catch((e) => { console.error('\n✗', e.message || e); if (e.body) console.error(e.body); process.exit(1); });
