const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction, SystemProgram } = require('@solana/web3.js');
const { derivePath, custodyPath, keypairFor, custodySigner, parseSeed, drawKey } = require('./keyring');

// One master seed, one custody wallet per vault, nothing on disk. The derivation is SLIP-0010
// ed25519 — checked against the vectors in the specification, so a wallet derived here is the
// wallet any standard tool derives from the same seed and path.
const SEED_HEX = '000102030405060708090a0b0c0d0e0f';           // SLIP-0010 test vector 1 (16 bytes)
const SEED_32 = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

describe('keyring — SLIP-0010 ed25519', () => {
  test('matches the specification\'s test vector 1 (m, m/0\', m/0\'/1\', m/0\'/1\'/2\'/2\'/1000000000\')', () => {
    const seed = Buffer.from(SEED_HEX, 'hex');
    const pub = (path) => Keypair.fromSeed(derivePath(seed, path).key).publicKey.toBuffer().toString('hex');
    assert.equal(derivePath(seed, 'm').key.toString('hex'), '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
    assert.equal(pub('m'), 'a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed');
    assert.equal(pub("m/0'"), '8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c');
    assert.equal(pub("m/0'/1'"), '1932a5270f335bed617d5b935c80aedb1a35bd9fc1e31acafd5372c30f5c1187');
    assert.equal(derivePath(seed, "m/0'").key.toString('hex'), '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
    assert.equal(pub("m/0'/1'/2'/2'/1000000000'"), '3c24da049451555d51a7014a37337aa4e12d41e485abccfa46b47dfb2af54b7a');
  });
  test('derivation refuses non-hardened segments and bad seeds', () => {
    assert.throws(() => derivePath(Buffer.from(SEED_HEX, 'hex'), 'm/44/501'), /hardened/);
    assert.throws(() => parseSeed('abc'), /64 hex/);
    assert.throws(() => custodyPath(-1), /index/);
    assert.equal(custodyPath(7), "m/44'/501'/7'/0'");
  });
  test('custody wallets: deterministic per index, different per index, and the signer signs with the derived key', () => {
    const a = keypairFor(0, SEED_32), a2 = keypairFor(0, SEED_32), b = keypairFor(1, SEED_32);
    assert.equal(a.publicKey.toBase58(), a2.publicKey.toBase58());
    assert.notEqual(a.publicKey.toBase58(), b.publicKey.toBase58());
    const s = custodySigner(3, SEED_32);
    assert.equal(s.configured(), true); assert.equal(s.publicKey(), keypairFor(3, SEED_32).publicKey.toBase58());
    const tx = new Transaction({ feePayer: keypairFor(3, SEED_32).publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() });
    tx.add(SystemProgram.transfer({ fromPubkey: keypairFor(3, SEED_32).publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    s.signTransaction(tx);
    assert.ok(tx.verifySignatures());
    assert.equal(custodySigner(3, '').configured(), false, 'no seed → not configured, never throws on the check');
  });
});

describe('keyring — the draw key', () => {
  test('deterministic from the master seed, different per seed, never a custody key; no seed → refused', () => {
    const k = drawKey(SEED_32);
    assert.equal(k.length, 32); assert.deepEqual(k, drawKey(SEED_32));
    assert.notDeepEqual(k, drawKey('ff'.repeat(32)));
    for (let i = 0; i < 5; i++) assert.notDeepEqual(k, Buffer.from(derivePath(parseSeed(SEED_32), custodyPath(i)).key));
    assert.throws(() => drawKey(''), /VAULT_MASTER_SEED/);
  });
});
