#!/usr/bin/env node
/**
 * dry-run.js — build the curve config and read back what it implies. NO chain, NO keys.
 *
 *   node src/curve/dry-run.js
 *
 * Prints: the program's own validation result, the derived start price, the price at
 * graduation, the quote needed to graduate, how the supply splits, and where each dollar
 * of a trade goes. If a placeholder is still in use it says so, loudly.
 */
const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { buildParams, PENDING, FEE_BPS } = require('./params');
const { splitOfTrade } = require('./split');

const BN = require('bn.js');
const usd = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });

function main() {
  const params = buildParams();
  const cfg = sdk.buildCurveWithMarketCap(params);

  // 1) the program's own rules, before anything is created
  // The validator also wants `leftoverReceiver` (an ACCOUNT, set at creation time; it
  // rejects the zero key on purpose). A throwaway random key satisfies the dry run — the
  // real receiver is chosen in the launch runbook, never here.
  const { PublicKey } = require('@solana/web3.js');
  let validation = "OK — passes the program's own parameter checks";
  try { sdk.validateConfigParameters({ ...cfg, leftoverReceiver: PublicKey.unique() }); }
  catch (e) { validation = 'FAILED — ' + e.message; }

  // 2) what the numbers imply
  const dec = { base: params.token.tokenBaseDecimal, quote: params.token.tokenQuoteDecimal };
  const startPrice = sdk.getPriceFromSqrtPrice(cfg.sqrtStartPrice, dec.base, dec.quote);
  const gradSqrt = sdk.getMigrationThresholdPrice(cfg.migrationQuoteThreshold, cfg.sqrtStartPrice, cfg.curve);
  const gradPrice = sdk.getPriceFromSqrtPrice(gradSqrt, dec.base, dec.quote);
  const quoteToGraduate = Number(cfg.migrationQuoteThreshold.toString()) / 10 ** dec.quote;

  const supply = new BN(params.token.totalTokenSupply).mul(new BN(10).pow(new BN(dec.base)));
  const tk = sdk.getTokenomics(
    new (require('decimal.js'))(params.initialMarketCap),
    new (require('decimal.js'))(params.migrationMarketCap),
    new BN(params.lockedVesting.totalLockedVestingAmount).mul(new BN(10).pow(new BN(dec.base))),
    new BN(0),
    supply,
  );
  const whole = (bn) => Number(bn.toString()) / 10 ** dec.base;
  const split = splitOfTrade(FEE_BPS);

  console.log('VAULTY #1 — curve dry run (nothing created)\n');
  console.log(`program validation      ${validation}`);
  console.log(`curve points            ${cfg.curve.length} (max ${sdk.MAX_CURVE_POINT})`);
  console.log('');
  console.log(`initial market cap      ${usd(params.initialMarketCap)}   ← PENDING placeholder`);
  console.log(`migration market cap    ${usd(params.migrationMarketCap)}   ← PENDING placeholder`);
  console.log(`start price             ${usd(startPrice.toString())} per token`);
  console.log(`price at graduation     ${usd(gradPrice.toString())} per token`);
  console.log(`USDC needed to graduate ${usd(quoteToGraduate)}   (migrationQuoteThreshold)`);
  console.log('');
  console.log(`total supply            ${params.token.totalTokenSupply.toLocaleString('en-US')}   ← PENDING placeholder`);
  console.log(`  sold on the curve     ${whole(tk.bondingCurveSupply).toLocaleString('en-US')}`);
  console.log(`  migrates to DAMM v2   ${whole(tk.migrationSupply).toLocaleString('en-US')}`);
  console.log(`  locked vesting        ${whole(tk.lockedVestingSupply).toLocaleString('en-US')}   ← PENDING (0 = no seed allocation)`);
  console.log(`  leftover              ${whole(tk.leftoverSupply).toLocaleString('en-US')}`);
  console.log('');
  console.log(`fee                     ${split.feePct}% of every trade`);
  console.log(`  Meteora (protocol)    ${split.protocolPct}%`);
  console.log(`  buys a card           ${split.buyCardPct}%`);
  console.log(`  buys back the token   ${split.buybackPct}%`);
  console.log(`  operator              ${split.operatorPct}%`);
  console.log('');
  console.log('PENDING inputs in use (src/curve/params.js):');
  for (const [k, v] of Object.entries(PENDING)) console.log(`  ${k.padEnd(28)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
}

main();
