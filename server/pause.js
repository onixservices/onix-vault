/**
 * server/pause.js — the emergency stop. A file, not a route: nothing to authenticate, nothing to attack.
 *
 *   touch data/PAUSE              → every vault stops moving value
 *   touch data/PAUSE-<id|wallet>  → only that vault stops
 *   rm the file                   → back to normal within a few seconds
 *
 * Paused means: no creation steps, no plays started or settled, no gacha reservations or settlements, no admissions,
 * no treasury round, no draws or deliveries from the sweep. Payments already made are kept and processed when the
 * pause lifts; nothing is refunded or lost by pausing. Trading on the token's pool is Meteora's and is not affected.
 */
'use strict';
const fsDefault = require('fs');

function createPause({ dir, now = Date.now, ttlMs = 5000, fs = fsDefault } = {}) {
  let cache = { t: -Infinity, global: false, vaults: new Set() };
  function read() {
    if (now() - cache.t < ttlMs) return cache;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    cache = { t: now(), global: names.includes('PAUSE'), vaults: new Set(names.filter((n) => n.startsWith('PAUSE-')).map((n) => n.slice(6))) };
    return cache;
  }
  /** @param {{wallet?: string, id?: string}|null} vault  null = the platform-wide question */
  function isPaused(vault = null) {
    const c = read();
    if (c.global) return true;
    return !!(vault && ((vault.wallet && c.vaults.has(vault.wallet)) || (vault.id && c.vaults.has(vault.id))));
  }
  function state() { const c = read(); return { global: c.global, vaults: [...c.vaults] }; }
  return { isPaused, state };
}

/** A pause that never pauses (tests, scripts). */
const neverPaused = { isPaused: () => false, state: () => ({ global: false, vaults: [] }) };

module.exports = { createPause, neverPaused };
