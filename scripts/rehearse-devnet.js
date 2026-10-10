#!/usr/bin/env node
/**
 * rehearse-devnet.js — the launch runbook, §1, executed against DEVNET.
 *
 *   node scripts/rehearse-devnet.js            # full run
 *   node scripts/rehearse-devnet.js --resume   # reuse .devnet/state.json from a previous run
 *
 * Same code path as the real launch (`src/curve/params.js` → `buildCurveWithMarketCap` →
 * the SDK client), with everything that is irreversible on mainnet made throwaway here:
 *
 *   - the signer is an EPHEMERAL keypair generated on first run into `.devnet/` (a folder the
 *     allowlist `.gitignore` never admits; the pre-commit hook refuses keypairs anyway);
 *   - the quote mint is a test SPL mint ("tUSDC", 6 decimals) minted to that keypair;
 *   - the base mint is created by the pool, exactly as on mainnet.
 *
 * It then does what the runbook asks: config → read back → pool → read back → one buy → one
 * sell → claim the partner fee → read the fee at the claimer, and decodes the pool with OUR
 * reader (`src/reader/pool.js`) next to the SDK's reading, so the proof page is proven too.
 *
 * Nothing here is reusable on mainnet without changing the RPC, the keypair and the quote mint
 * on purpose. That is the point.
 */
const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const {
  Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { buildParams } = require('../src/curve/params');
const { decodeVirtualPool, priceFromSqrtPrice } = require('../src/reader/pool');

const RPC = process.env.ONIX_VAULT_DEVNET_RPC || 'https://api.devnet.solana.com';
const DIR = path.join(__dirname, '..', '.devnet');
const STATE = path.join(DIR, 'state.json');
const RESUME = process.argv.includes('--resume');
const QUOTE_DECIMALS = 6;
const TEST_QUOTE_SUPPLY = 100_000;            // tUSDC minted to the rehearsal wallet
const BUY_QUOTE = 25;                         // tUSDC spent on the rehearsal buy
const SELL_FRACTION = 0.25;                   // fraction of the bought tokens sold back

const log = (...a) => console.log(...a);
const usd = (n, d = 6) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  if (RESUME && fs.existsSync(STATE)) return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  return {};
}
function saveState(s) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}
function loadOrCreateKeypair(file) {
  const p = path.join(DIR, file);
  if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
  const kp = Keypair.generate();
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

async function ensureSol(conn, pubkey, minSol) {
  let bal = await conn.getBalance(pubkey);
  if (bal >= minSol * LAMPORTS_PER_SOL) return bal;
  for (let i = 0; i < 4 && bal < minSol * LAMPORTS_PER_SOL; i++) {
    try {
      const sig = await conn.requestAirdrop(pubkey, 1 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, 'confirmed');
    } catch (e) {
      log(`  airdrop attempt ${i + 1} failed (${e.message.split('\n')[0]}); waiting…`);
      await sleep(4000);
    }
    bal = await conn.getBalance(pubkey);
  }
  if (bal < minSol * LAMPORTS_PER_SOL) {
    throw new Error(`Need ≥${minSol} SOL on devnet for ${pubkey.toBase58()}; have ${bal / LAMPORTS_PER_SOL}. ` +
      'Devnet faucet is rate-limited: fund it at https://faucet.solana.com and rerun with --resume.');
  }
  return bal;
}

async function send(conn, tx, signers, label) {
  tx.feePayer = signers[0].publicKey;
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' });
  log(`  ✓ ${label}  ${sig}`);
  return sig;
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const client = sdk.DynamicBondingCurveClient.create(conn, 'confirmed');
  const state = loadState();
  const payer = loadOrCreateKeypair('rehearsal-wallet.json'); // name contains "wallet", not "keypair"; still under .devnet/

  log('ONIX.VAULT — DEVNET REHEARSAL (runbook §1)\n');
  log(`rpc        ${RPC}`);
  log(`signer     ${payer.publicKey.toBase58()}  (ephemeral, devnet only)`);
  const sol = await ensureSol(conn, payer.publicKey, 0.5);
  log(`balance    ${sol / LAMPORTS_PER_SOL} SOL\n`);

  // ── 0. a throwaway quote mint, standing in for USDC ────────────────────────────────
  let quoteMint;
  if (state.quoteMint) {
    quoteMint = new PublicKey(state.quoteMint);
    log(`quote mint ${quoteMint.toBase58()}  (reused)`);
  } else {
    quoteMint = await spl.createMint(conn, payer, payer.publicKey, null, QUOTE_DECIMALS);
    const ata = await spl.getOrCreateAssociatedTokenAccount(conn, payer, quoteMint, payer.publicKey);
    await spl.mintTo(conn, payer, quoteMint, ata.address, payer, BigInt(TEST_QUOTE_SUPPLY) * 10n ** BigInt(QUOTE_DECIMALS));
    state.quoteMint = quoteMint.toBase58();
    saveState(state);
    log(`quote mint ${quoteMint.toBase58()}  (tUSDC, ${TEST_QUOTE_SUPPLY.toLocaleString('en-US')} minted)`);
  }
  const payerQuoteAta = spl.getAssociatedTokenAddressSync(quoteMint, payer.publicKey);
  const quoteBalance = async () => Number((await conn.getTokenAccountBalance(payerQuoteAta)).value.uiAmount);

  // ── 1. the config — the SAME params as the launch ──────────────────────────────────
  const params = buildParams();
  const curve = sdk.buildCurveWithMarketCap(params);
  let config;
  if (state.config) {
    config = new PublicKey(state.config);
    log(`\nconfig     ${config.toBase58()}  (reused)`);
  } else {
    const configKp = Keypair.generate();
    const tx = await client.partner.createConfig({
      ...curve,
      config: configKp.publicKey,
      feeClaimer: payer.publicKey,       // the whole mechanism: fees land here
      leftoverReceiver: payer.publicKey, // must be non-zero even with leftover = 0
      quoteMint,
      payer: payer.publicKey,
    });
    log('\n1. createConfig');
    await send(conn, tx, [payer, configKp], 'config created');
    config = configKp.publicKey;
    state.config = config.toBase58();
    saveState(state);
  }

  // read it back and diff the fields that are ours to get wrong
  const cfg = await client.state.getPoolConfig(config);
  const dec = { base: params.token.tokenBaseDecimal, quote: params.token.tokenQuoteDecimal };
  const startPrice = sdk.getPriceFromSqrtPrice(cfg.sqrtStartPrice, dec.base, dec.quote);
  const gradSqrt = sdk.getMigrationThresholdPrice(cfg.migrationQuoteThreshold, cfg.sqrtStartPrice, cfg.curve);
  const gradPrice = sdk.getPriceFromSqrtPrice(gradSqrt, dec.base, dec.quote);
  log(`   read back  quoteMint=${cfg.quoteMint.toBase58() === quoteMint.toBase58() ? 'ok' : 'MISMATCH'}` +
      `  feeClaimer=${cfg.feeClaimer.toBase58() === payer.publicKey.toBase58() ? 'ok' : 'MISMATCH'}` +
      `  collectFeeMode=${cfg.collectFeeMode}  migrationOption=${cfg.migrationOption}`);
  log(`   start price $${usd(startPrice.toString(), 8)}   graduation $${usd(gradPrice.toString(), 8)}   ` +
      `quote to graduate ${usd(Number(cfg.migrationQuoteThreshold.toString()) / 10 ** dec.quote)}`);

  // ── 2. the pool — this is the point of no return on mainnet ───────────────────────
  let baseMint, pool;
  if (state.baseMint) {
    baseMint = new PublicKey(state.baseMint);
    pool = new PublicKey(state.pool);
    log(`\npool       ${pool.toBase58()}  (reused)`);
  } else {
    const baseMintKp = Keypair.generate();
    const tx = await client.creator.createPool({
      name: 'Veonix (devnet rehearsal)',
      symbol: 'tVEONIX',
      uri: 'https://onix.finance/vault/rehearsal.json',
      payer: payer.publicKey,
      poolCreator: payer.publicKey,
      config,
      baseMint: baseMintKp.publicKey,
    });
    log('\n2. createPool  (mints the base token — on mainnet, irreversible)');
    await send(conn, tx, [payer, baseMintKp], 'pool created');
    baseMint = baseMintKp.publicKey;
    pool = sdk.deriveDbcPoolAddress(quoteMint, baseMint, config);
    state.baseMint = baseMint.toBase58();
    state.pool = pool.toBase58();
    saveState(state);
  }
  log(`   base mint  ${baseMint.toBase58()}`);
  log(`   pool       ${pool.toBase58()}`);

  const readPool = async (label) => {
    const wrapped = await client.state.getPool(pool); // the SDK wraps the account in { poolState }
    const vp = wrapped.poolState;
    const price = sdk.getPriceFromSqrtPrice(vp.sqrtPrice, dec.base, dec.quote);
    // OUR decoder, from the raw account, next to the SDK's
    const acc = await conn.getAccountInfo(pool);
    const ours = decodeVirtualPool(acc.data);
    const ourPrice = priceFromSqrtPrice(ours.sqrtPrice, dec.base, dec.quote);
    log(`   ${label}: price SDK $${usd(price.toString(), 8)} · ours $${usd(ourPrice, 8)} ` +
        `· quoteReserve ${usd(Number(vp.quoteReserve.toString()) / 10 ** dec.quote)} ` +
        `· partnerQuoteFee ${usd(Number(vp.partnerQuoteFee.toString()) / 10 ** dec.quote)} ` +
        `· protocolQuoteFee ${usd(Number(vp.protocolQuoteFee.toString()) / 10 ** dec.quote)}` +
        (Math.abs(Number(price.toString()) - ourPrice) / Number(price.toString()) < 1e-6 ? '' : '   ⚠ OUR DECODER DISAGREES'));
    return wrapped;
  };
  await readPool('after create');

  // ── 3. one buy ────────────────────────────────────────────────────────────────────
  log(`\n3. buy with ${BUY_QUOTE} tUSDC`);
  const before = await quoteBalance();
  let vp = await client.state.getPool(pool); // wrapped: swapQuote wants { poolState }
  const amountIn = new BN(BUY_QUOTE * 10 ** dec.quote);
  const currentPoint = await sdk.getCurrentPoint(conn, cfg.activationType);
  const q = client.pool.swapQuote({ virtualPool: vp, config: cfg, swapBaseForQuote: false, amountIn, slippageBps: 100, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint });
  log(`   quote: out ${usd(Number(q.outputAmount.toString()) / 10 ** dec.base)} tVEONIX · fee ${usd(Number(q.tradingFee.toString()) / 10 ** dec.quote)} tUSDC (trading) + ${usd(Number(q.protocolFee.toString()) / 10 ** dec.quote)} (protocol)`);
  const buyTx = await client.pool.swap({ owner: payer.publicKey, pool, amountIn, minimumAmountOut: q.minimumAmountOut, swapBaseForQuote: false, referralTokenAccount: null });
  await send(conn, buyTx, [payer], 'bought');
  const after = await quoteBalance();
  log(`   wallet tUSDC ${usd(before)} → ${usd(after)}  (Δ ${usd(after - before)})`);
  vp = await readPool('after buy');

  // ── 4. one sell ───────────────────────────────────────────────────────────────────
  const baseAta = spl.getAssociatedTokenAddressSync(baseMint, payer.publicKey);
  const baseBal = new BN((await conn.getTokenAccountBalance(baseAta)).value.amount);
  const sellIn = baseBal.muln(Math.round(SELL_FRACTION * 1000)).divn(1000);
  log(`\n4. sell ${usd(Number(sellIn.toString()) / 10 ** dec.base)} tVEONIX back into the curve`);
  const q2 = client.pool.swapQuote({ virtualPool: vp, config: cfg, swapBaseForQuote: true, amountIn: sellIn, slippageBps: 100, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: await sdk.getCurrentPoint(conn, cfg.activationType) });
  const sellTx = await client.pool.swap({ owner: payer.publicKey, pool, amountIn: sellIn, minimumAmountOut: q2.minimumAmountOut, swapBaseForQuote: true, referralTokenAccount: null });
  await send(conn, sellTx, [payer], 'sold');
  vp = await readPool('after sell');

  // ── 5. claim the partner fee — the fee → next item pipeline starts here ──────────────────
  log('\n5. claimPartnerTradingFee → feeClaimer');
  const feeBefore = await quoteBalance();
  const claimTx = await client.partner.claimPartnerTradingFee({
    feeClaimer: payer.publicKey, payer: payer.publicKey, pool,
    maxBaseAmount: new BN(0), maxQuoteAmount: vp.poolState.partnerQuoteFee,
  });
  await send(conn, claimTx, [payer], 'fee claimed');
  const feeAfter = await quoteBalance();
  log(`   feeClaimer tUSDC ${usd(feeBefore)} → ${usd(feeAfter)}  (Δ +${usd(feeAfter - feeBefore)} = the fee that would buy a card)`);
  await readPool('after claim');

  state.lastRun = new Date().toISOString();
  saveState(state);
  log(`\nstate saved to ${STATE}`);
  log('\nDONE. Every step above is the same call the mainnet launch makes; only the RPC, the signer and the quote mint are throwaway.');
}

main().catch((e) => { console.error('\n✗', e.message || e); if (e.logs) console.error(e.logs.join('\n')); process.exit(1); });
