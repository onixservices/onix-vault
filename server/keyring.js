/**
 * server/keyring.js — one custody wallet per vault, derived from ONE master seed; no key is
 * ever written to disk. SLIP-0010 (ed25519) hardened derivation with node's own crypto —
 * the path `m/44'/501'/<index>'/0'` is the Solana convention (Phantom derives the same way),
 * so the wallets can be recovered in a standard tool from the seed alone.
 *
 * The seed is `VAULT_MASTER_SEED` (32 bytes, hex), generated ON THE SERVER by the setup
 * script, read through config.js as `KEYRING_SEED`, never logged, never returned. A vault
 * row stores only its `custody_index`; the key exists only in memory, when it signs.
 */
'use strict';
const crypto = require('crypto');
const { Keypair } = require('@solana/web3.js');
const C = require('./config');

const HARDENED = 0x80000000;

/** SLIP-0010 master node for ed25519. */
function masterNode(seed) {
  const I = crypto.createHmac('sha512', 'ed25519 seed').update(seed).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

/** SLIP-0010 hardened child (ed25519 only has hardened children). */
function childNode(node, index) {
  const data = Buffer.alloc(1 + 32 + 4);
  data[0] = 0x00; node.key.copy(data, 1); data.writeUInt32BE((index + HARDENED) >>> 0, 33);
  const I = crypto.createHmac('sha512', node.chainCode).update(data).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

/** @param {Buffer} seed  @param {string} path  e.g. "m/44'/501'/3'/0'" (every segment hardened) */
function derivePath(seed, path) {
  const segs = path.split('/');
  if (segs[0] !== 'm') throw new Error('keyring: path must start with m');
  let node = masterNode(seed);
  for (const s of segs.slice(1)) {
    if (!/^\d+'$/.test(s)) throw new Error(`keyring: ed25519 segments must be hardened (${s})`);
    node = childNode(node, parseInt(s, 10));
  }
  return node;
}

function custodyPath(index) {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED) throw new Error('keyring: index must be a non-negative integer');
  return `m/44'/501'/${index}'/0'`;
}

function parseSeed(hex) {
  const s = String(hex || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error('keyring: VAULT_MASTER_SEED must be 32 bytes as 64 hex characters');
  return Buffer.from(s, 'hex');
}

/** The keypair for a custody index, from a seed (tests and rehearsals pass the seed; production reads config). */
function keypairFor(index, seedHex = C.KEYRING_SEED) {
  const node = derivePath(parseSeed(seedHex), custodyPath(index));
  return Keypair.fromSeed(node.key);
}

/** The signer interface the bundles use (same shape as signer.js). The key is derived when it signs, never kept. */
function custodySigner(index, seedHex = () => C.KEYRING_SEED) {
  const seed = typeof seedHex === 'function' ? seedHex : () => seedHex;
  return {
    configured: () => { try { parseSeed(seed()); return true; } catch { return false; } },
    publicKey: () => keypairFor(index, seed()).publicKey.toBase58(),
    signTransaction: (tx) => { tx.partialSign(keypairFor(index, seed())); return tx; },
    index,
  };
}

/**
 * The key the draws derive their server seeds from (server/draw.js serverSeedFor). From the master seed under its own
 * label, so it is never a custody key, and there is nothing new to generate, store or back up.
 */
function drawKey(seedHex = C.KEYRING_SEED) {
  return crypto.createHmac('sha256', parseSeed(seedHex)).update('onix-vault/draw-key/v1', 'utf8').digest();
}

function configured() { try { parseSeed(C.KEYRING_SEED); return true; } catch { return false; } }

module.exports = { derivePath, custodyPath, keypairFor, custodySigner, drawKey, configured, parseSeed };
