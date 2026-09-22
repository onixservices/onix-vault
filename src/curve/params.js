/**
 * params.js — Vaulty #1's bonding-curve configuration, as data.
 *
 * DECIDED values carry their reasoning in docs/curve-config.md. PENDING values are the
 * ones still waiting on a decision — they have a placeholder so the dry run can execute,
 * and the dry run prints them loudly so nobody mistakes a placeholder for a decision.
 *
 * Nothing here creates anything. See dry-run.js.
 */
const {
  TokenType, TokenAuthorityOption, BaseFeeMode, CollectFeeMode, MigrationOption,
  MigrationFeeOption, MigratedCollectFeeMode, DammV2DynamicFeeMode, ActivationType,
} = require('@meteora-ag/dynamic-bonding-curve-sdk');

const FEE_BPS = 1000; // 10%, flat. See docs/curve-config.md → Fees.

/** Inputs that are still a PO decision. Change here, and only here. */
const PENDING = {
  // ≈ realisable backing at launch, so the ratio opens near 1.0×. Depends on the
  // stock-rule N (rec. N=5 → ~$916). Placeholder: $950.
  initialMarketCapUsd: 950,
  // Graduation. Low = plausible in the window and unlocks vesting; high = means real
  // trading happened. Meteora's StockLaunch graduates at $750. Placeholder: $10,000.
  migrationMarketCapUsd: 10_000,
  // Whole tokens. Placeholder: 10M (6 decimals).
  totalTokenSupply: 10_000_000,
  // Locked vesting (anchored to MIGRATION — see the finding in docs/curve-config.md).
  // Placeholder: none, i.e. option 3 "no seed allocation at launch".
  lockedVesting: {
    totalLockedVestingAmount: 0,
    numberOfVestingPeriod: 0,
    cliffUnlockAmount: 0,
    totalVestingDuration: 0,
    cliffDurationFromMigrationTime: 0,
  },
  // We are partner AND creator. 0 = everything to the partner's feeClaimer.
  creatorTradingFeePercentage: 0,
  // Out of the migrating liquidity. Placeholder: 0.
  migrationFeePercentage: 0,
  // The graduated pool's own fee (10–1000 bps). Placeholder: 100 (1%).
  migratedPoolFeeBps: 100,
};

function buildParams(p = PENDING) {
  return {
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: 6,
      tokenQuoteDecimal: 6,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: p.totalTokenSupply,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: FEE_BPS,
          endingFeeBps: FEE_BPS,   // flat: the fee IS the product
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,   // "10% of every trade" has to stay true on a volatile day
      collectFeeMode: CollectFeeMode.QuoteToken, // fees arrive in USDC, ready to buy cards
      creatorTradingFeePercentage: p.creatorTradingFeePercentage,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: p.migrationFeePercentage, creatorFeePercentage: 0 },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: p.migratedPoolFeeBps,
      },
    },
    liquidityDistribution: {
      // Everything that migrates is locked; nothing walks out of the graduated pool.
      partnerPermanentLockedLiquidityPercentage: 100,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: p.lockedVesting,
    activationType: ActivationType.Timestamp,
    initialMarketCap: p.initialMarketCapUsd,
    migrationMarketCap: p.migrationMarketCapUsd,
  };
}

module.exports = { FEE_BPS, PENDING, buildParams };
