/**
 * server/reservationsRepo.js — reservations, I/O only. The rules (price, TTL,
 * strikes) live in vaultService.js. States: reserved → settling → settled |
 * expired | cancelled | delivery_failed.
 */
'use strict';

function add(db, {
  id, mint, integrator, winner, exitPriceUsd, expiresAt, createdAt, idempotencyKey = null, paymentTxB64 = null,
}) {
  db.prepare(`
    INSERT INTO vault_reservations (id, mint, integrator, winner, exit_price_usd, status,
                                    expires_at, idempotency_key, payment_tx_b64, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?)
  `).run(id, mint, integrator, winner, exitPriceUsd, expiresAt, idempotencyKey, paymentTxB64, createdAt, createdAt);
  return get(db, id);
}

function byIdempotencyKey(db, key) {
  return db.prepare('SELECT * FROM vault_reservations WHERE idempotency_key = ?').get(key) || null;
}

function get(db, id) {
  return db.prepare('SELECT * FROM vault_reservations WHERE id = ?').get(id) || null;
}

/** A reserva VIVA de uma carta (uma só, por construção do serviço). */
function liveForMint(db, mint, now) {
  return db.prepare(
    "SELECT * FROM vault_reservations WHERE mint = ? AND status = 'reserved' AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
  ).get(mint, now) || null;
}

function listLive(db, now) {
  return db.prepare("SELECT * FROM vault_reservations WHERE status = 'reserved' AND expires_at > ?").all(now);
}

function listToExpire(db, now) {
  return db.prepare("SELECT * FROM vault_reservations WHERE status = 'reserved' AND expires_at <= ?").all(now);
}

/** Transição com guarda optimista: só muda se ainda estiver no estado `from`. */
function transition(db, id, from, to, { at, set = {} } = {}) {
  const cols = Object.keys(set);
  const sql = `UPDATE vault_reservations SET status = ?, updated_at = ?${cols.map(c => `, ${c} = ?`).join('')} WHERE id = ? AND status = ?`;
  const res = db.prepare(sql).run(to, at, ...cols.map(c => set[c]), id, from);
  return res.changes > 0;
}

/** Quantas reservas de um integrador expiraram sem liquidar — a reincidência. */
function expiredCountFor(db, integrator) {
  return db.prepare("SELECT COUNT(*) n FROM vault_reservations WHERE integrator = ? AND status = 'expired'").get(integrator).n;
}

/** Settled sales, newest first — the gacha door's public trail. */
function listSettled(db, limit = 100) {
  return db.prepare("SELECT * FROM vault_reservations WHERE status = 'settled' ORDER BY updated_at DESC LIMIT ?").all(limit);
}

function byPaymentSig(db, sig) {
  return db.prepare('SELECT * FROM vault_reservations WHERE payment_sig = ?').get(sig) || null;
}

module.exports = { add, get, byIdempotencyKey, liveForMint, listLive, listToExpire, transition, expiredCountFor, byPaymentSig, listSettled };
