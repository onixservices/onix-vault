/**
 * server/commissions.js — every card a vault sells pays the creator and Onix.
 *
 * The wire does not change: the buyer (a player, or a gacha through the API) pays the full price to the vault's
 * custody wallet, as before. What changes is the book-keeping and the custody's next fee-claim transaction:
 *
 *   SALE_SPLIT          5% creator · 2% Onix · 93% treasury — the one source the page, the docs and the ledger read
 *   splitOfSale(usd)    the three parts in micro-USDC; the creator and Onix are floored, the treasury takes the rest
 *   recordSale(...)     one row per sale, written in the SAME SQLite transaction that marks the item delivered;
 *                       the same sale twice is one row (UNIQUE source + reference)
 *   owed()              what the custody has yet to pay, and the one creator those rows name
 *   encumberedUnits()   owed + paying: money in the custody that is not the treasury's — the restock never spends it
 *   markPaying / settle / release / reconcile
 *                       the payout's life: owed → paying (the fee claim that carries the legs is persisted) →
 *                       paid (it landed) · back to owed (it failed or never landed)
 *
 * The creator's leg can only ever go to the creator the vault registered (`vaults.creator` / the registry entry),
 * snapshotted on each row; server/feeclaim.js refuses to pay when the two disagree. Without a registered creator,
 * or when the creator IS the custody, the 5% stays in the treasury and the row says why.
 * Sales made before this rule existed are `pre_rule` (server/db.js marks them once) and owe nothing.
 */
'use strict';
const crypto = require('crypto');
const { isAddress } = require('./inputs');

const SALE_SPLIT = Object.freeze({ creator: 5, onix: 2, treasury: 93 });
const SOURCES = Object.freeze(['play', 'gacha']);
const UNITS = 1e6;   // USDC has 6 decimals

/** @returns {{ priceUnits: number, creatorUnits: number, onixUnits: number, treasuryUnits: number }} */
function splitOfSale(priceUsd, split = SALE_SPLIT) {
  if (Math.abs(split.creator + split.onix + split.treasury - 100) > 1e-9) throw new Error('sale split must sum to 100');
  if (typeof priceUsd !== 'number' || !Number.isFinite(priceUsd) || priceUsd < 0) throw new Error(`splitOfSale: invalid price ${priceUsd}`);
  const priceUnits = Math.round(priceUsd * UNITS);
  const creatorUnits = Math.floor(priceUnits * split.creator / 100);
  const onixUnits = Math.floor(priceUnits * split.onix / 100);
  return { priceUnits, creatorUnits, onixUnits, treasuryUnits: priceUnits - creatorUnits - onixUnits };
}

function createCommissions({ db, vaultWallet, creator = null, now = Date.now, log = console }) {
  // the creator's share goes to the registered creator, or nowhere: never to an address a request names
  let waived = null, creatorWallet = null;
  if (!creator) waived = 'no_creator';
  else if (!isAddress(creator)) { waived = 'creator_invalid'; log.warn(`[commissions ${vaultWallet.slice(0, 6)}] the registered creator "${String(creator).slice(0, 24)}" is not a wallet address — the creator's share stays in the treasury`); }
  else if (creator === vaultWallet) waived = 'creator_is_custody';
  else creatorWallet = creator;

  const SELECT = `SELECT s.*, c.sig AS payout_sig FROM vault_sales s LEFT JOIN vault_fee_claims c ON c.id = s.payout_id`;
  const view = (r) => ({
    id: r.id, vault: r.vault, source: r.source, refId: r.ref_id, mint: r.mint,
    priceUnits: r.price_units, creatorUnits: r.creator_units, onixUnits: r.onix_units, treasuryUnits: r.treasury_units,
    priceUsd: r.price_units / UNITS, creatorUsd: r.creator_units / UNITS, onixUsd: r.onix_units / UNITS, treasuryUsd: r.treasury_units / UNITS,
    creatorWallet: r.creator_wallet, creatorWaived: r.creator_waived, status: r.status, payoutId: r.payout_id, payoutSignature: r.payout_sig || null,
    at: r.created_at, updatedAt: r.updated_at,
  });
  const get = (source, refId) => db.prepare(`${SELECT} WHERE s.vault = ? AND s.source = ? AND s.ref_id = ?`).get(vaultWallet, source, refId) || null;

  /** One row per sale; a second call for the same sale returns the first row. Meant to run inside the caller's transaction. */
  function recordSale({ source, refId, mint = null, priceUsd, at = now() }) {
    if (!SOURCES.includes(source)) throw new Error(`recordSale: unknown source "${source}"`);
    if (typeof refId !== 'string' || !refId) throw new Error('recordSale: a sale needs a reference (the play or reservation id)');
    if (typeof priceUsd !== 'number' || !(priceUsd > 0)) throw new Error(`recordSale: invalid price ${priceUsd}`);
    const s = splitOfSale(priceUsd);
    const creatorUnits = waived ? 0 : s.creatorUnits;
    db.prepare(`INSERT OR IGNORE INTO vault_sales (id, vault, source, ref_id, mint, price_units, creator_units, onix_units, treasury_units, creator_wallet, creator_waived, status, payout_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owed', NULL, ?, ?)`)
      .run(crypto.randomUUID(), vaultWallet, source, refId, mint, s.priceUnits, creatorUnits, s.onixUnits, s.priceUnits - creatorUnits - s.onixUnits, waived ? null : creatorWallet, waived, at, at);
    return view(get(source, refId));
  }

  /** The rows waiting for a payout: ids, sums, and the distinct creators the rows with a creator's share name. */
  function owed() {
    const rows = db.prepare("SELECT id, price_units, creator_units, onix_units, creator_wallet FROM vault_sales WHERE vault = ? AND status = 'owed' ORDER BY created_at, rowid").all(vaultWallet);
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
    return { ids: rows.map((r) => r.id), count: rows.length, priceUnits: sum('price_units'), creatorUnits: sum('creator_units'), onixUnits: sum('onix_units'),
      creatorWallets: [...new Set(rows.filter((r) => r.creator_units > 0 && r.creator_wallet).map((r) => r.creator_wallet))] };
  }

  function encumberedUnits() {
    return db.prepare("SELECT COALESCE(SUM(creator_units + onix_units), 0) u FROM vault_sales WHERE vault = ? AND status IN ('owed', 'paying')").get(vaultWallet).u;
  }

  /** owed → paying, for exactly these rows; returns how many moved (the caller rolls back when it is not all of them). */
  function markPaying(ids, payoutId, at = now()) {
    if (!ids.length) return 0;
    return db.prepare(`UPDATE vault_sales SET status = 'paying', payout_id = ?, updated_at = ? WHERE vault = ? AND status = 'owed' AND id IN (${ids.map(() => '?').join(', ')})`).run(payoutId, at, vaultWallet, ...ids).changes;
  }
  const settle = (payoutId, at = now()) => db.prepare("UPDATE vault_sales SET status = 'paid', updated_at = ? WHERE vault = ? AND status = 'paying' AND payout_id = ?").run(at, vaultWallet, payoutId).changes;
  const release = (payoutId, at = now()) => (payoutId == null
    ? db.prepare("UPDATE vault_sales SET status = 'owed', updated_at = ? WHERE vault = ? AND status = 'paying' AND payout_id IS NULL").run(at, vaultWallet)
    : db.prepare("UPDATE vault_sales SET status = 'owed', payout_id = NULL, updated_at = ? WHERE vault = ? AND status = 'paying' AND payout_id = ?").run(at, vaultWallet, payoutId)).changes;

  /** Rows left `paying` by a crash, a rollback or an older server: settled or released by what their claim says. */
  function reconcile(at = now()) {
    const out = { paid: 0, released: 0, waiting: 0 };
    for (const { payout_id: payoutId } of db.prepare("SELECT DISTINCT payout_id FROM vault_sales WHERE vault = ? AND status = 'paying'").all(vaultWallet)) {
      const claim = payoutId ? db.prepare('SELECT status FROM vault_fee_claims WHERE id = ?').get(payoutId) : null;
      if (claim && claim.status === 'sent') { out.waiting += db.prepare("SELECT count(*) n FROM vault_sales WHERE vault = ? AND status = 'paying' AND payout_id = ?").get(vaultWallet, payoutId).n; continue; }
      if (claim && claim.status === 'landed') out.paid += settle(payoutId, at);
      else out.released += release(payoutId, at);
    }
    return out;
  }

  function list({ limit = 200 } = {}) {
    return db.prepare(`${SELECT} WHERE s.vault = ? ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?`).all(vaultWallet, limit).map(view);
  }

  /** For the Activity tab: `source:refId` → the split, the status and the payout of the latest sales. */
  function summaries({ limit = 200 } = {}) {
    return Object.fromEntries(list({ limit }).map((s) => [`${s.source}:${s.refId}`, { creatorUsd: s.creatorUsd, onixUsd: s.onixUsd, treasuryUsd: s.treasuryUsd, status: s.status, payoutId: s.payoutId, payoutSignature: s.payoutSignature }]));
  }

  return { recordSale, owed, encumberedUnits, markPaying, settle, release, reconcile, list, summaries, get: (source, refId) => { const r = get(source, refId); return r ? view(r) : null; }, creatorWallet, creatorWaived: waived, SALE_SPLIT };
}

module.exports = { createCommissions, splitOfSale, SALE_SPLIT, SOURCES };
