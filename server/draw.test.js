const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { generateCommit, sha256Hex, computeDigest, draw, verifyCommit, validClientSeed } = require('./draw');

// The draw is pure and recomputable: same inputs → same item, by anyone, with the published hash.
describe('draw — commit-reveal', () => {
  test('commit: the hash binds the seed; the seed verifies against it and only it', () => {
    const c = generateCommit();
    assert.equal(c.serverSeed.length, 64); assert.equal(c.serverSeedHash, sha256Hex(c.serverSeed));
    assert.equal(verifyCommit(c), true);
    assert.equal(verifyCommit({ serverSeed: generateCommit().serverSeed, serverSeedHash: c.serverSeedHash }), false);
  });
  test('deterministic: same seed/play/clientSeed/nonce → same digest and item; the snapshot order does not matter; nonce changes the item', () => {
    const seed = 'ab'.repeat(32), snapshot = ['M3', 'M1', 'M2', 'M5', 'M4'];
    const a = draw({ serverSeed: seed, playId: 'P1', clientSeed: 'hello', nonce: 0, snapshot });
    const b = draw({ serverSeed: seed, playId: 'P1', clientSeed: 'hello', nonce: 0, snapshot: [...snapshot].reverse() });
    assert.deepEqual(a, b);
    assert.equal(a.digest, computeDigest({ serverSeed: seed, playId: 'P1', clientSeed: 'hello', nonce: 0 }));
    assert.ok(a.index >= 0 && a.index < 5); assert.equal(a.mint, [...snapshot].sort()[a.index]);
    const c = draw({ serverSeed: seed, playId: 'P1', clientSeed: 'hello', nonce: 1, snapshot });
    assert.notEqual(c.digest, a.digest);
    const d = draw({ serverSeed: seed, playId: 'P1', clientSeed: 'other', nonce: 0, snapshot });
    assert.notEqual(d.digest, a.digest);
  });
  test('one item = that item; empty band refused; the index spreads over the band', () => {
    assert.equal(draw({ serverSeed: 'cd'.repeat(32), playId: 'P', clientSeed: 'x', snapshot: ['ONLY'] }).mint, 'ONLY');
    assert.throws(() => draw({ serverSeed: 'cd'.repeat(32), playId: 'P', clientSeed: 'x', snapshot: [] }), (e) => e.code === 'empty-band');
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(draw({ serverSeed: 'ef'.repeat(32), playId: 'P' + i, clientSeed: 'x', snapshot: ['A', 'B', 'C', 'D'] }).mint);
    assert.equal(seen.size, 4);
  });
  test('clientSeed: short, url-safe, never empty', () => {
    assert.equal(validClientSeed('abc_123-XYZ'), true);
    assert.equal(validClientSeed(''), false); assert.equal(validClientSeed('a|b'), false); assert.equal(validClientSeed('x'.repeat(33)), false);
  });
});
