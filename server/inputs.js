/**
 * server/inputs.js — what a client sends that is stored and shown on the public page is checked at the door:
 * an address is a wallet address, a signature is base58 text, an image is an https URL. Anything else never
 * reaches the database, the API or the page (4 Oct 2026: a signature field was free text rendered in Activity).
 */
'use strict';
const { PublicKey } = require('@solana/web3.js');

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** A base58 public key that round-trips (32 bytes). */
function isAddress(s) {
  if (typeof s !== 'string' || !BASE58.test(s)) return false;
  try { return new PublicKey(s).toBase58() === s; } catch { return false; }
}

/** A transaction signature as text: base58 only, never longer than one (88 chars) with room to spare. */
function isSignatureText(s) { return typeof s === 'string' && s.length <= 100 && BASE58.test(s); }

/** An image the page may show: an https URL, normalised by the URL parser (quotes and brackets come out encoded). */
function safeImageUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; }
}

module.exports = { isAddress, isSignatureText, safeImageUrl };
