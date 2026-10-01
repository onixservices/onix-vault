/**
 * pool.js — read a Meteora DBC virtual pool straight from its account bytes. Pure.
 *
 * No SDK in the browser: the layout below is derived from the program's IDL and a test
 * asserts every offset against it, so the page can decode a pool with a DataView and
 * nothing else. Works in Node and in the browser (see the export at the bottom).
 */

/** Byte offsets inside the VirtualPool account (8-byte Anchor discriminator included). */
const POOL_LAYOUT = {
  SIZE: 424,
  config: 72,               // pubkey
  creator: 104,             // pubkey
  baseMint: 136,            // pubkey
  baseReserve: 232,         // u64
  quoteReserve: 240,        // u64
  protocolQuoteFee: 256,    // u64  claimable by the protocol
  partnerQuoteFee: 272,     // u64  claimable by the partner (us) — the whole mechanism
  sqrtPrice: 280,           // u128 Q64.64
  isMigrated: 305,          // u8
  totalTradingQuoteFee: 336,// u64  lifetime, before the protocol's cut
  creatorQuoteFee: 360,     // u64
};

function u64(dv, off) { return dv.getBigUint64(off, true); }
function u128(dv, off) { return dv.getBigUint64(off, true) + (dv.getBigUint64(off + 8, true) << 64n); }
function pubkey(bytes, off) { return bytes.slice(off, off + 32); }

/** @param {Uint8Array} bytes raw account data */
function decodeVirtualPool(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < POOL_LAYOUT.SIZE) {
    throw new Error(`not a VirtualPool account (${bytes && bytes.length} bytes, expected ${POOL_LAYOUT.SIZE})`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    config: pubkey(bytes, POOL_LAYOUT.config),
    baseMint: pubkey(bytes, POOL_LAYOUT.baseMint),
    baseReserve: u64(dv, POOL_LAYOUT.baseReserve),
    quoteReserve: u64(dv, POOL_LAYOUT.quoteReserve),
    protocolQuoteFee: u64(dv, POOL_LAYOUT.protocolQuoteFee),
    partnerQuoteFee: u64(dv, POOL_LAYOUT.partnerQuoteFee),
    creatorQuoteFee: u64(dv, POOL_LAYOUT.creatorQuoteFee),
    totalTradingQuoteFee: u64(dv, POOL_LAYOUT.totalTradingQuoteFee),
    sqrtPrice: u128(dv, POOL_LAYOUT.sqrtPrice),
    isMigrated: bytes[POOL_LAYOUT.isMigrated] === 1,
  };
}

/**
 * Spot price in quote per base, from a Q64.64 sqrt price. Same formula as the SDK's
 * getPriceFromSqrtPrice; a test checks the two agree. Returns a Number — fine for display,
 * not for settlement (nothing here settles anything).
 */
function priceFromSqrtPrice(sqrtPrice, baseDecimals, quoteDecimals) {
  const s = Number(sqrtPrice) / 2 ** 64;
  return s * s * 10 ** (baseDecimals - quoteDecimals);
}

const api = { POOL_LAYOUT, decodeVirtualPool, priceFromSqrtPrice };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else if (typeof window !== 'undefined') window.OnixVaultPool = api;
