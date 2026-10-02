const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PublicKey } = require('@solana/web3.js');
const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { DECIDED, paramsFor, buildParams, FEE_BPS, MONTH_SECONDS } = require('./params');

// The curve every vault gets (decided 2 Oct 2026): the creator paid on chain, sniper-proof first
// minute, 30% of the raise to the treasury, 50% to the creator vesting from graduation.
describe('curve params — decided shape', () => {
  test('for $100 of backing: opens at $200, graduates at $500 (2.5×); 5M tokens vest to the creator over 6 months from migration', () => {
    const { params, view } = paramsFor({ backingUsd: 100 });
    assert.equal(view.openingMcapUsd, 200); assert.equal(view.graduationUsd, 500);
    assert.equal(view.creatorPct, 50); assert.equal(view.curvePct, 50); assert.equal(view.creatorTokens, 5_000_000);
    assert.equal(params.lockedVesting.totalLockedVestingAmount, 5_000_000);
    assert.equal(params.lockedVesting.numberOfVestingPeriod, 6);
    assert.equal(params.lockedVesting.totalVestingDuration, 6 * MONTH_SECONDS);
    assert.equal(params.lockedVesting.cliffDurationFromMigrationTime, 0);
    assert.equal(params.fee.creatorTradingFeePercentage, 40);
    assert.equal(params.migration.migrationFee.feePercentage, 30);
    assert.equal(params.migration.migrationFee.creatorFeePercentage, 0);
  });
  test('anti-sniper: the fee scheduler starts at 99% and ends at the 10% base over 6 periods in 60 s', () => {
    const { params } = paramsFor({ backingUsd: 100 });
    assert.deepEqual(params.fee.baseFeeParams.feeSchedulerParam, { startingFeeBps: 9900, endingFeeBps: FEE_BPS, numberOfPeriod: 6, totalDuration: 60 });
  });
  test('the creator picks graduation multiple and fee share only from the decided options', () => {
    assert.equal(paramsFor({ backingUsd: 100, gradMult: 3 }).view.graduationUsd, 600);
    assert.equal(paramsFor({ backingUsd: 100, creatorFeePct: 20 }).params.fee.creatorTradingFeePercentage, 20);
    assert.throws(() => paramsFor({ backingUsd: 100, gradMult: 10 }), /gradMult/);
    assert.throws(() => paramsFor({ backingUsd: 100, creatorFeePct: 90 }), /creatorFeePct/);
    assert.throws(() => paramsFor({ backingUsd: 0 }), /backingUsd/);
  });
  test('the program validates the decided config (for a $21 vault and a $1,420 vault)', () => {
    for (const backingUsd of [21.36, 1420]) {
      const { params } = paramsFor({ backingUsd });
      const cfg = sdk.buildCurveWithMarketCap(params);
      assert.doesNotThrow(() => sdk.validateConfigParameters({ ...cfg, leftoverReceiver: PublicKey.unique() }));
      // the scheduler compiled: 99% cliff, 6 periods, and the per-period reduction lands on the 10% base
      const bf = cfg.poolFees.baseFee;
      const cliff = Number(bf.cliffFeeNumerator.toString()), periods = Number(bf.firstFactor), reduction = Number(bf.thirdFactor.toString());
      assert.equal(cliff, 990_000_000); assert.equal(periods, 6);
      assert.ok(Math.abs(cliff - periods * reduction - 100_000_000) < 10, 'ends at 10%');
    }
  });
  test('DECIDED is frozen and buildParams keeps the fixed shape (SPL, immutable authority, DAMM v2, locked liquidity)', () => {
    assert.ok(Object.isFrozen(DECIDED));
    const p = buildParams({ initialMarketCapUsd: 10, migrationMarketCapUsd: 25, totalTokenSupply: 1_000_000, creatorTradingFeePercentage: 40, migrationFeePercentage: 30, migratedPoolFeeBps: 100, lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 } });
    assert.equal(p.token.tokenAuthorityOption, sdk.TokenAuthorityOption.Immutable);
    assert.equal(p.migration.migrationOption, sdk.MigrationOption.MET_DAMM_V2);
    assert.equal(p.liquidityDistribution.partnerPermanentLockedLiquidityPercentage, 100);
    assert.equal(p.fee.collectFeeMode, sdk.CollectFeeMode.QuoteToken);
  });
});
