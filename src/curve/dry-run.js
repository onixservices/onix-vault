#!/usr/bin/env node
/**
 * dry-run.js — build the curve config for a given backing and read back what it implies.
 * NO chain, NO keys.
 *
 *   node src/curve/dry-run.js [backingUsd=154] [gradMult=2.5] [creatorFeePct=40]
 *
 * Prints: the program's own validation result, opening and graduation caps, start/graduation
 * price, the USDC needed to graduate, how the supply splits (curve / migration / creator's
 * vesting), the anti-sniper schedule, and where each dollar of a trade goes.
 */
const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { paramsFor, DECIDED, FEE_BPS } = require('./params');
const { splitOfTrade } = require('./split');

const BN = require('bn.js');
const usd = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });

function main() {
  const backingUsd = Number(process.argv[2] || 154), gradMult = Number(process.argv[3] || DECIDED.gradMultDefault), creatorFeePct = Number(process.argv[4] || DECIDED.creatorTradingFeePercentage);
  const { params, view } = paramsFor({ backingUsd, gradMult, creatorFeePct });
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
    new BN(params.token.leftover || 0).mul(new BN(10).pow(new BN(dec.base))),
    supply,
  );
  const whole = (bn) => Number(bn.toString()) / 10 ** dec.base;
  const split = splitOfTrade(FEE_BPS, creatorFeePct);
  const anti = params.fee.baseFeeParams.feeSchedulerParam;

  console.log('ONIX.VAULT — curve dry run (nothing created)\n');
  console.log(`program validation      ${validation}`);
  console.log(`curve points            ${cfg.curve.length} (max ${sdk.MAX_CURVE_POINT})`);
  console.log('');
  console.log(`realisable backing      ${usd(backingUsd)}`);
  console.log(`opening market cap      ${usd(view.openingMcapUsd)}   (${DECIDED.openMult}× backing — the creator's ${view.creatorPct}% is worth the items on day one)`);
  console.log(`graduation market cap   ${usd(view.graduationUsd)}   (${gradMult}× opening)`);
  console.log(`start price             ${usd(startPrice.toString())} per token`);
  console.log(`price at graduation     ${usd(gradPrice.toString())} per token`);
  console.log(`USDC needed to graduate ${usd(quoteToGraduate)}   (migrationQuoteThreshold) → ${view.migrationFeePct}% of it (${usd(quoteToGraduate * view.migrationFeePct / 100)}) goes to the vault treasury at graduation`);
  console.log('');
  console.log(`total supply            ${params.token.totalTokenSupply.toLocaleString('en-US')}`);
  console.log(`  sold on the curve     ${whole(tk.bondingCurveSupply).toLocaleString('en-US')}`);
  console.log(`  migrates to DAMM v2   ${whole(tk.migrationSupply).toLocaleString('en-US')}`);
  console.log(`  creator (vesting)     ${whole(tk.lockedVestingSupply).toLocaleString('en-US')}   cliff at migration, linear ${view.vestingMonths} months`);
  console.log(`  leftover              ${whole(tk.leftoverSupply).toLocaleString('en-US')}`);
  console.log('');
  console.log(`anti-sniper             ${anti.startingFeeBps / 100}% → ${anti.endingFeeBps / 100}% over ${anti.totalDuration}s in ${anti.numberOfPeriod} steps`);
  console.log(`fee                     ${split.feePct}% of every trade (after the first minute)`);
  console.log(`  Meteora (protocol)    ${split.protocolPct.toFixed(2)}%`);
  console.log(`  creator (on chain)    ${split.creatorPct.toFixed(2)}%`);
  console.log(`  vault treasury        ${split.treasuryPct.toFixed(2)}%`);
  console.log(`  Onix                  ${split.onixPct.toFixed(2)}%`);
}

main();
