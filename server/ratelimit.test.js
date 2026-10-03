const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('./ratelimit');

describe('rate limiter — a token bucket per key', () => {
  test('spends one token per take, refuses when empty, refills with time, keys are independent', () => {
    let t = 0;
    const rl = createRateLimiter({ capacity: 3, perMs: 3000, now: () => t });
    assert.deepEqual([rl.take('a'), rl.take('a'), rl.take('a'), rl.take('a')], [true, true, true, false]);
    assert.equal(rl.take('b'), true);
    t = 1000; assert.equal(rl.take('a'), true); assert.equal(rl.take('a'), false);   // one token back per second
    t = 10_000; assert.equal(rl.remaining('a'), 3);
  });
  test('buckets that refilled completely are dropped on the sweep', () => {
    let t = 0;
    const rl = createRateLimiter({ capacity: 2, perMs: 100, now: () => t });
    for (let i = 0; i < 50; i++) rl.take('ip' + i);
    assert.equal(rl.size(), 50);
    t = 1000; rl.take('fresh');
    assert.equal(rl.size(), 1);
  });
});
