/**
 * server/draw.js — the provably-fair draw behind the Play door (commit-reveal). PURE: no I/O,
 * no state; fully determined by (serverSeed, playId, clientSeed, nonce, snapshot), so anyone
 * recomputes the result and lands on the same item.
 *
 *   commit  = sha256(serverSeed), published BEFORE the player pays (it binds the server)
 *   digest  = HMAC-SHA256(key = serverSeed, msg = `${playId}|${clientSeed}|${nonce}`)
 *   r       = uint64BE(digest[8..16]) / 2^64  →  index in the band's snapshot, sorted by mint
 *
 * The band is chosen by the player (every item in it has the same odds: 1/n). The clientSeed
 * that counts is the one in the memo of the confirmed payment — fixed on chain after the commit,
 * so neither side controls the outcome alone. A re-draw (item gone meanwhile) is nonce + 1,
 * always recorded and shown in the proof.
 *
 * Ported from Onix.Cards' drawService (Aug 2026), which runs the same scheme in production.
 */
'use strict';
const crypto = require('crypto');

const TWO_POW_64 = 2 ** 64;
const MAX_REDRAWS = 5;

function sha256Hex(utf8) { return crypto.createHash('sha256').update(utf8, 'utf8').digest('hex'); }

/** A fresh commit for a play: single-use seed + the hash to publish. */
function generateCommit() {
  const serverSeed = crypto.randomBytes(32).toString('hex');
  return { serverSeed, serverSeedHash: sha256Hex(serverSeed) };
}

function computeDigest({ serverSeed, playId, clientSeed, nonce }) {
  return crypto.createHmac('sha256', Buffer.from(serverSeed, 'hex')).update(`${playId}|${clientSeed}|${nonce}`, 'utf8').digest('hex');
}

function toUnit(digestHex, byteOffset) {
  return Number(Buffer.from(digestHex, 'hex').subarray(byteOffset, byteOffset + 8).readBigUInt64BE(0)) / TWO_POW_64;
}

/**
 * @param {string[]} snapshot  the band's mints at play time (any order; sorted here)
 * @returns {{ digest, r, index, mint }}
 */
function draw({ serverSeed, playId, clientSeed, nonce = 0, snapshot }) {
  if (!Array.isArray(snapshot) || !snapshot.length) { const e = new Error('nothing to draw from'); e.code = 'empty-band'; throw e; }
  const digest = computeDigest({ serverSeed, playId, clientSeed, nonce });
  const r = toUnit(digest, 8);
  const pool = [...snapshot].sort();
  const index = Math.min(Math.floor(r * pool.length), pool.length - 1);
  return { digest, r, index, mint: pool[index] };
}

/** What the proof page checks. */
function verifyCommit({ serverSeed, serverSeedHash }) { return sha256Hex(serverSeed) === serverSeedHash; }

/** A clientSeed is whatever the player chose, bounded so it fits a memo. */
function validClientSeed(s) { return typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s); }

module.exports = { generateCommit, sha256Hex, computeDigest, draw, verifyCommit, validClientSeed, MAX_REDRAWS };
