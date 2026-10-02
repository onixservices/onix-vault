const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair } = require('@solana/web3.js');
const { createStatsReader, BAND } = require('./stats');
const { POOL_LAYOUT } = require('../src/reader/pool');

// What the page shows at the top: backing (index and realisable, never summed with the
// pool), and — only when a pool exists — price, supply, market cap, graduation progress.
const items = [
  { mint: 'A', custodianValueUsd: 100 }, { mint: 'B', custodianValueUsd: 50 }, { mint: 'C', custodianValueUsd: null },
];

function poolBytes({ sqrtPrice, partnerFee = 0n, totalFee = 0n, migrated = false }) {
  const b = new Uint8Array(POOL_LAYOUT.SIZE);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(POOL_LAYOUT.sqrtPrice, sqrtPrice & ((1n << 64n) - 1n), true);
  dv.setBigUint64(POOL_LAYOUT.sqrtPrice + 8, sqrtPrice >> 64n, true);
  dv.setBigUint64(POOL_LAYOUT.partnerQuoteFee, partnerFee, true);
  dv.setBigUint64(POOL_LAYOUT.totalTradingQuoteFee, totalFee, true);
  b[POOL_LAYOUT.isMigrated] = migrated ? 1 : 0;
  return Buffer.from(b).toString('base64');
}

describe('stats — backing without a pool', () => {
  test('index and realisable are both there, priced items are counted, pool is null and says why', async () => {
    const stats = createStatsReader({ readItems: async () => items, chain: {}, config: { haircut: 0.89, graduationUsd: 3500 }, now: () => 1000 });
    const s = await stats.read();
    assert.equal(s.items.count, 2);
    assert.equal(s.backing.indexUsd, 150);
    assert.equal(s.backing.realisableUsd, 133.5);
    assert.equal(s.backing.multiplier, 0.89);
    assert.equal(s.pool, null);
    assert.equal(s.poolStatus, 'not launched');
    assert.deepEqual(s.band, BAND);
    assert.equal(s.readAt, 1000);
  });
});

describe('stats — with a pool', () => {
  test('price from the pool bytes × supply = market cap; ratio over realisable; graduation progress; fees in USDC', async () => {
    // sqrtPrice for price 0.0002 (base 6 dp, quote 6 dp): sqrt(0.0002) * 2^64
    const sqrt = BigInt(Math.round(Math.sqrt(0.0002) * 2 ** 32)) << 32n;
    const chain = {
      getAccountInfoBase64: async (addr) => { assert.equal(addr, 'POOL'); return { data: [poolBytes({ sqrtPrice: sqrt, partnerFee: 2_500_000n, totalFee: 12_000_000n })] }; },
      getTokenSupplyUi: async (mint) => { assert.equal(mint, 'MINT'); return 10_000_000; },
    };
    const stats = createStatsReader({ readItems: async () => items, chain, config: { haircut: 0.89, graduationUsd: 3500, pool: 'POOL', baseMint: 'MINT', baseDecimals: 6, quoteDecimals: 6 }, now: () => 1 });
    const s = await stats.read();
    assert.ok(Math.abs(s.pool.priceUsd - 0.0002) < 1e-9);
    assert.equal(s.pool.supply, 10_000_000);
    assert.ok(Math.abs(s.pool.mcapUsd - 2000) < 1e-6);
    assert.ok(Math.abs(s.pool.ratio - 2000 / 133.5) < 1e-9);
    assert.equal(s.pool.graduationUsd, 3500);
    assert.ok(Math.abs(s.pool.graduationProgress - 2000 / 3500) < 1e-9);
    assert.equal(s.pool.partnerFeeClaimableUsd, 2.5);
    assert.equal(s.pool.feesLifetimeUsd, 12);
    assert.equal(s.pool.isMigrated, false);
    assert.equal(s.poolStatus, 'live');
  });

  test('pool configured but unreadable → pool null, status says so, backing still served (never a 500 for the page)', async () => {
    const chain = { getAccountInfoBase64: async () => { throw new Error('rpc down'); }, getTokenSupplyUi: async () => 1 };
    const stats = createStatsReader({ readItems: async () => items, chain, config: { haircut: 0.89, graduationUsd: 3500, pool: 'POOL', baseMint: 'MINT' }, now: () => 1 });
    const s = await stats.read();
    assert.equal(s.pool, null);
    assert.match(s.poolStatus, /unreadable/);
    assert.equal(s.backing.indexUsd, 150);
  });

  test('cached for cacheMs; the age is reported', async () => {
    let reads = 0;
    const stats = createStatsReader({ readItems: async () => { reads++; return items; }, chain: {}, config: { haircut: 0.89 }, now: (() => { let t = 0; return () => (t += 1000); })(), cacheMs: 5000 });
    await stats.read(); await stats.read();
    assert.equal(reads, 1);
    await stats.read({ fresh: true }); assert.equal(reads, 2, 'fresh:true re-reads');
    assert.ok(stats.ageMs() >= 0);
  });
});
