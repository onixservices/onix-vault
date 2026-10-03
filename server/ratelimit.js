/**
 * server/ratelimit.js — a token bucket per key (an IP, a wallet), in memory, no dependency.
 *
 *   const rl = createRateLimiter({ capacity: 20, perMs: 3_600_000 });   // 20 per hour, refilled continuously
 *   rl.take(key)          → true (allowed, one token spent) | false (empty: refuse with 429)
 *   rl.remaining(key)     → tokens left now
 *
 * Buckets that have refilled completely are dropped on the next sweep, so the map never grows
 * with addresses that came once. It is a first fence, not a wall: the real limits (one creation per
 * wallet, deposits before the config is paid, uploads by hash) live in the services.
 */
'use strict';

function createRateLimiter({ capacity = 10, perMs = 60_000, now = Date.now } = {}) {
  const buckets = new Map();
  const rate = capacity / perMs;   // tokens per ms
  let lastSweep = now();
  function bucket(key) {
    const t = now();
    let b = buckets.get(key);
    if (!b) { b = { tokens: capacity, at: t }; buckets.set(key, b); }
    else { b.tokens = Math.min(capacity, b.tokens + (t - b.at) * rate); b.at = t; }
    if (t - lastSweep > perMs) { lastSweep = t; for (const [k, v] of buckets) if (v !== b && Math.min(capacity, v.tokens + (t - v.at) * rate) >= capacity) buckets.delete(k); }
    return b;
  }
  return {
    take(key) { const b = bucket(String(key || '?')); if (b.tokens < 1) return false; b.tokens -= 1; return true; },
    remaining(key) { return Math.floor(bucket(String(key || '?')).tokens); },
    size() { return buckets.size; },
  };
}

module.exports = { createRateLimiter };
