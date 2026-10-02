/**
 * params.js — the bonding-curve configuration every Onix.Vault pool is created with, as data.
 *
 * DECIDED 2 Oct 2026 (after the first two launches were closed and the creator economics were
 * redesigned — see docs/curve-config.md for each field's reasoning and what Jupiter Studio,
 * Believe and SV151 do):
 *   · the creator is paid on chain from the first trade (creatorTradingFeePercentage)
 *   · the first 60 seconds are sniper-proof (fee scheduler 99% → 10%)
 *   · 30% of the USDC raised goes to the vault's treasury at graduation (migrationFee)
 *   · the creator's 50% sits in lockedVesting: released at graduation, linearly over 6 months
 *   · the curve opens at 2× realisable backing and graduates at gradMult × the opening cap
 *
 * Nothing here creates anything. See dry-run.js.
 */
const {
  TokenType, TokenAuthorityOption, BaseFeeMode, CollectFeeMode, MigrationOption,
  MigrationFeeOption, MigratedCollectFeeMode, DammV2DynamicFeeMode, ActivationType,
} = require('@meteora-ag/dynamic-bonding-curve-sdk');

const FEE_BPS = 1000;            // 10%, the base fee for the life of the curve
const MONTH_SECONDS = Math.round(30.4375 * 86_400);

/** The split and the shape every vault gets. Product decisions, not request fields. */
const DECIDED = Object.freeze({
  totalTokenSupply: 10_000_000,          // whole tokens, 6 decimals
  creatorPct: 50,                         // of the supply, in lockedVesting (the other 50% is the curve)
  openMult: 2,                            // opening market cap = 2 × realisable backing → the creator's half is worth the items on day one
  gradMultDefault: 2.5,                   // graduation = gradMult × opening cap; the creator picks 2 | 2.5 | 3
  gradMultOptions: Object.freeze([2, 2.5, 3]),
  vestingMonths: 6,                       // creator's allocation: cliff at migration, then linear
  creatorTradingFeePercentage: 40,        // of the partner-side fee → creator 3.2% of volume, partner 4.8% (vault treasury 3.2 + Onix 1.6)
  creatorFeePctOptions: Object.freeze([20, 30, 40, 50]),
  migrationFeePercentage: 30,             // of the USDC raised, to the fee claimer (the vault's custody wallet) at graduation
  migratedPoolFeeBps: 100,                // the graduated DAMM v2 pool's fee (1%)
  antiSniper: Object.freeze({ startingFeeBps: 9900, numberOfPeriod: 6, totalDuration: 60 }), // 99% → 10% over the first 60 s
});

/**
 * The curve params for ONE vault: its realisable backing sets the opening cap; the creator's
 * choices (gradMult, creatorFeePct) stay inside the decided options.
 */
function paramsFor({ backingUsd, gradMult = DECIDED.gradMultDefault, creatorFeePct = DECIDED.creatorTradingFeePercentage, supply = DECIDED.totalTokenSupply } = {}) {
  if (!(backingUsd > 0)) throw new Error('paramsFor: backingUsd must be > 0');
  if (!DECIDED.gradMultOptions.includes(gradMult)) throw new Error(`paramsFor: gradMult must be one of ${DECIDED.gradMultOptions.join(', ')}`);
  if (!DECIDED.creatorFeePctOptions.includes(creatorFeePct)) throw new Error(`paramsFor: creatorFeePct must be one of ${DECIDED.creatorFeePctOptions.join(', ')}`);
  const r2 = (n) => Math.round(n * 100) / 100;
  const openingMcapUsd = r2(backingUsd * DECIDED.openMult), graduationUsd = r2(openingMcapUsd * gradMult);
  const creatorTokens = Math.round(supply * DECIDED.creatorPct / 100);
  return {
    view: { openingMcapUsd, graduationUsd, supply, creatorPct: DECIDED.creatorPct, curvePct: 100 - DECIDED.creatorPct, creatorTokens, creatorFeePct, gradMult, vestingMonths: DECIDED.vestingMonths, migrationFeePct: DECIDED.migrationFeePercentage, antiSniper: DECIDED.antiSniper },
    params: buildParams({
      initialMarketCapUsd: openingMcapUsd, migrationMarketCapUsd: graduationUsd, totalTokenSupply: supply,
      creatorTradingFeePercentage: creatorFeePct, migrationFeePercentage: DECIDED.migrationFeePercentage, migratedPoolFeeBps: DECIDED.migratedPoolFeeBps,
      antiSniper: DECIDED.antiSniper,
      lockedVesting: {
        totalLockedVestingAmount: creatorTokens, numberOfVestingPeriod: DECIDED.vestingMonths, cliffUnlockAmount: 0,
        totalVestingDuration: DECIDED.vestingMonths * MONTH_SECONDS, cliffDurationFromMigrationTime: 0,
      },
    }),
  };
}

/** The SDK's `buildCurveWithMarketCap` input, from plain numbers. */
function buildParams(p) {
  const anti = p.antiSniper || DECIDED.antiSniper;
  return {
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: 6,
      tokenQuoteDecimal: 6,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,  // mint authority revoked: the supply is fixed
      totalTokenSupply: p.totalTokenSupply,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        // anti-sniper: 99% for the first period, down to the base fee by the end of the window — the sniper pays the creator
        feeSchedulerParam: { startingFeeBps: anti.startingFeeBps, endingFeeBps: FEE_BPS, numberOfPeriod: anti.numberOfPeriod, totalDuration: anti.totalDuration },
      },
      dynamicFeeEnabled: false,   // "10% of every trade" has to stay true on a volatile day
      collectFeeMode: CollectFeeMode.QuoteToken, // fees arrive in USDC, ready to buy items
      creatorTradingFeePercentage: p.creatorTradingFeePercentage,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: p.migrationFeePercentage, creatorFeePercentage: 0 }, // all of it to the fee claimer = the vault's treasury
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

module.exports = { FEE_BPS, MONTH_SECONDS, DECIDED, paramsFor, buildParams };
