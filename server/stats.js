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

/** Redemption at 1.15× puts the floor near 0.87×; admission at 0.80× the ceiling at 1.25×. */
const BAND = Object.freeze({ floor: 0.87, ceiling: 1.25, redeemPremium: 1.15, admission: 0.80 });

function createStatsReader({ readItems, chain, config = {}, now = Date.now, cacheMs = 30_000 }) {
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
      const priceUsd = priceFromSqrtPrice(p.sqrtPrice, baseDecimals, quoteDecimals);
      const mcapUsd = priceUsd * supply;
      return {
        poolStatus: p.isMigrated ? 'migrated' : 'live',
        pool: {
          address: config.pool, baseMint: config.baseMint,
          priceUsd, supply, mcapUsd,
          ratio: realisableUsd > 0 ? mcapUsd / realisableUsd : null,
          graduationUsd, graduationProgress: graduationUsd ? Math.min(1, mcapUsd / graduationUsd) : null,
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
    const value = {
      readAt: now(),
      items: { count: items.length },
      backing: { indexUsd, realisableUsd, multiplier: haircut },
      band: BAND,
      ...poolPart,
    };
    cache = { at: now(), value };
    return value;
  }
  read.ageMs = () => (cache.value ? now() - cache.at : null);
  return { read, ageMs: read.ageMs };
}

module.exports = { createStatsReader, BAND };
