/**
 * server/stats.js — the numbers at the top of a vault page, read on the server so the
 * browser never needs an RPC key: backing (index and realisable, from the items) and,
 * only when a pool exists, price · supply · market cap · graduation progress · fees,
 * decoded from the pool account with the same pure decoder the CLI reader uses.
 *
 * Backing and the pool are two numbers and are never summed. The ratio is the only
 * place they meet.
 */
'use strict';
const { decodeVirtualPool, priceFromSqrtPrice } = require('../src/reader/pool');

/**
 * @param {function} [readConfig]  async (configPubkey) => { migrationQuoteThresholdUsd, lockedVestingTokens } — read once (a config is immutable)
 */
function createStatsReader({ readItems, chain, config = {}, now = Date.now, cacheMs = 30_000, readConfig = null, readDamm = null }) {
  let cfgCache = null;
  const haircut = config.haircut ?? 0.89;
  const graduationUsd = config.graduationUsd ?? null;
  const baseDecimals = config.baseDecimals ?? 6;
  const quoteDecimals = config.quoteDecimals ?? 6;
  let cache = { at: 0, value: null };

  async function readPool(realisableUsd) {
    if (!config.pool || !config.baseMint) return { pool: null, poolStatus: 'not launched' };
    try {
      const [acct, supply] = await Promise.all([chain.getAccountInfoBase64(config.pool), chain.getTokenSupplyUi(config.baseMint)]);
      if (!acct) return { pool: null, poolStatus: 'unreadable: pool account not found' };
      const p = decodeVirtualPool(Uint8Array.from(Buffer.from(acct.data[0], 'base64')));
      if (!cfgCache && readConfig) { try { cfgCache = await readConfig(p.config); } catch (e) { cfgCache = null; } }
      // after migration the curve's price is frozen; the live price is the graduated DAMM v2 pool's
      let priceUsd = priceFromSqrtPrice(p.sqrtPrice, baseDecimals, quoteDecimals), damm = null;
      if (p.isMigrated && readDamm && cfgCache && cfgCache.migrationFeeOption != null) {
        try { damm = await readDamm({ baseMint: config.baseMint, migrationFeeOption: cfgCache.migrationFeeOption }); if (damm && damm.priceUsd > 0) priceUsd = damm.priceUsd; } catch (e) { damm = { error: e.message }; }
      }
      const mcapUsd = priceUsd * supply;
      // what the curve graduates on: USDC in its reserve against the threshold in the config
      const raisedUsd = Number(p.quoteReserve) / 10 ** quoteDecimals;
      const thresholdUsd = cfgCache ? cfgCache.migrationQuoteThresholdUsd : null;
      const lockedTokens = cfgCache ? cfgCache.lockedVestingTokens : null;
      return {
        poolStatus: p.isMigrated ? 'migrated' : 'live',
        pool: {
          address: config.pool, baseMint: config.baseMint,
          priceUsd, supply, mcapUsd,
          ratio: realisableUsd > 0 ? mcapUsd / realisableUsd : null,
          graduationUsd,
          // progress is the curve's own condition (USDC raised ÷ threshold); the mcap-based number stays as a fallback when the config cannot be read
          graduationProgress: thresholdUsd ? Math.min(1, raisedUsd / thresholdUsd) : graduationUsd ? Math.min(1, mcapUsd / graduationUsd) : null,
          raisedUsd, graduationUsdc: thresholdUsd,
          openingMcapUsd: config.openingMcapUsd ?? null,
          locked: lockedTokens != null ? { tokens: lockedTokens, pct: Math.round(lockedTokens / supply * 1000) / 10, creatorPct: config.creatorPct ?? null, releasesAt: 'graduation', vestingMonths: config.vestingMonths ?? null, locker: cfgCache && cfgCache.locker ? cfgCache.locker : null } : null,
          damm: damm && !damm.error ? { address: damm.address, priceUsd: damm.priceUsd } : null,
          partnerFeeClaimableUsd: Number(p.partnerQuoteFee) / 10 ** quoteDecimals,
          feesLifetimeUsd: Number(p.totalTradingQuoteFee) / 10 ** quoteDecimals,
          isMigrated: p.isMigrated,
        },
      };
    } catch (e) {
      return { pool: null, poolStatus: `unreadable: ${e.message}` };
    }
  }

  async function read({ fresh = false } = {}) {
    if (!fresh && cache.value && now() - cache.at < cacheMs) return cache.value;
    const items = (await readItems()).filter((it) => it.custodianValueUsd != null);
    const indexUsd = items.reduce((s, it) => s + it.custodianValueUsd, 0);
    const realisableUsd = Math.round(indexUsd * haircut * 100) / 100;
    const poolPart = await readPool(realisableUsd);
    // the treasury: USDC in the custody wallet (migration fee, USDC plays) — what buys the next item; never part of backing
    let treasuryUsd = null;
    if (config.vaultWallet && config.usdcMint && chain.rpc) { try { const r = await chain.rpc('getTokenAccountsByOwner', [config.vaultWallet, { mint: config.usdcMint }, { encoding: 'jsonParsed' }]); treasuryUsd = Math.round((r.value || []).reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0) * 100) / 100; } catch (e) { treasuryUsd = null; } }
    const value = {
      readAt: now(),
      items: { count: items.length },
      backing: { indexUsd, realisableUsd, multiplier: haircut },
      treasury: { usdc: treasuryUsd },
      ...poolPart,
    };
    cache = { at: now(), value };
    return value;
  }
  read.ageMs = () => (cache.value ? now() - cache.at : null);
  return { read, ageMs: read.ageMs };
}

module.exports = { createStatsReader };
