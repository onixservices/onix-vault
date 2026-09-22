const { test } = require('node:test');
const assert = require('node:assert/strict');
const { POOL_LAYOUT, decodeVirtualPool, priceFromSqrtPrice } = require('./pool');

// Derive the layout from the program's IDL, independently of pool.js, and compare.
function layoutFromIdl() {
  const { DynamicBondingCurveIdl: idl } = require('@meteora-ag/dynamic-bonding-curve-sdk');
  const sizes = { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16, i64: 8, bool: 1, pubkey: 32, publicKey: 32 };
  const sz = (ty) => {
    if (typeof ty === 'string') return sizes[ty];
    if (ty.array) return sz(ty.array[0]) * ty.array[1];
    const d = idl.types.find((x) => x.name === (ty.defined.name || ty.defined));
    return d.type.fields.reduce((s, f) => s + sz(f.type), 0);
  };
  const out = {};
  const walk = (name, base) => {
    let off = base;
    for (const f of idl.types.find((x) => x.name === name).type.fields) {
      out[f.name] = off;
      const nested = f.type.defined && (f.type.defined.name || f.type.defined);
      if (nested === 'PoolMetrics') walk(nested, off);
      off += sz(f.type);
    }
    return off;
  };
  out.SIZE = walk('PoolState', 8);
  return out;
}

test('every offset in POOL_LAYOUT matches the program IDL', () => {
  const idl = layoutFromIdl();
  assert.equal(POOL_LAYOUT.SIZE, idl.SIZE);
  assert.equal(POOL_LAYOUT.config, idl.config);
  assert.equal(POOL_LAYOUT.creator, idl.creator);
  assert.equal(POOL_LAYOUT.baseMint, idl.base_mint);
  assert.equal(POOL_LAYOUT.baseReserve, idl.base_reserve);
  assert.equal(POOL_LAYOUT.quoteReserve, idl.quote_reserve);
  assert.equal(POOL_LAYOUT.protocolQuoteFee, idl.protocol_quote_fee);
  assert.equal(POOL_LAYOUT.partnerQuoteFee, idl.partner_quote_fee);
  assert.equal(POOL_LAYOUT.sqrtPrice, idl.sqrt_price);
  assert.equal(POOL_LAYOUT.isMigrated, idl.is_migrated);
  assert.equal(POOL_LAYOUT.totalTradingQuoteFee, idl.total_trading_quote_fee);
  assert.equal(POOL_LAYOUT.creatorQuoteFee, idl.creator_quote_fee);
});

test('decodeVirtualPool reads the fields we wrote into a synthetic account', () => {
  const bytes = new Uint8Array(POOL_LAYOUT.SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setBigUint64(POOL_LAYOUT.quoteReserve, 2_356_029_835n, true);
  dv.setBigUint64(POOL_LAYOUT.partnerQuoteFee, 1_234_567n, true);
  dv.setBigUint64(POOL_LAYOUT.totalTradingQuoteFee, 9_999_999n, true);
  dv.setBigUint64(POOL_LAYOUT.sqrtPrice, 123n, true);
  dv.setBigUint64(POOL_LAYOUT.sqrtPrice + 8, 1n, true); // high 64 bits
  bytes[POOL_LAYOUT.isMigrated] = 1;
  bytes[POOL_LAYOUT.baseMint] = 7;
  const p = decodeVirtualPool(bytes);
  assert.equal(p.quoteReserve, 2_356_029_835n);
  assert.equal(p.partnerQuoteFee, 1_234_567n);
  assert.equal(p.totalTradingQuoteFee, 9_999_999n);
  assert.equal(p.sqrtPrice, (1n << 64n) + 123n);
  assert.equal(p.isMigrated, true);
  assert.equal(p.baseMint[0], 7);
});

test('decodeVirtualPool refuses bytes that are not a pool', () => {
  assert.throws(() => decodeVirtualPool(new Uint8Array(10)));
});

test('priceFromSqrtPrice agrees with the SDK on the dry-run start price', () => {
  const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
  const { buildParams } = require('../curve/params');
  const cfg = sdk.buildCurveWithMarketCap(buildParams());
  const ours = priceFromSqrtPrice(BigInt(cfg.sqrtStartPrice.toString()), 6, 6);
  const theirs = Number(sdk.getPriceFromSqrtPrice(cfg.sqrtStartPrice, 6, 6).toString());
  assert.ok(Math.abs(ours - theirs) / theirs < 1e-9, `${ours} vs ${theirs}`);
});
