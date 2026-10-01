/**
 * params.js — Vault #1's bonding-curve configuration, as data.
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
  // ≈ realisable backing of the OPENING lot (staged launch, 30 Sep: canary + ~5-10
  // cheap cards, the rest admitted during the week), so the ratio opens near 1.0×.
  // Read from the vault wallet on launch day, never typed. Placeholder: $250.
  initialMarketCapUsd: 250,
  // DECIDED 30 Sep: ~3-4× the FULL backing (37 cards ≈ $1,420 realisable) so the
  // market-cap ÷ backing ratio stays legible during the curve (at $10k it would read
  // ~10×). Plausible in the window; graduation is not a condition for anything —
  // admission tokens sit in a time lock, not in the DBC's lockedVesting.
  migrationMarketCapUsd: 3_500,
  // Whole tokens. Placeholder: 10M (6 decimals).
  totalTokenSupply: 10_000_000,
  // Locked vesting (anchored to MIGRATION — see docs/curve-config.md). DECIDED 30 Sep:
  // used ONLY for the operator's post-migration allocation; admission tokens never go
  // here (Jupiter Lock, 12 months). Amount still PENDING. Placeholder: none.
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
