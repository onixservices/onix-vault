/**
 * server/redemptionsRepo.js — redemptions, I/O only. v1 is semi-manual: a burn is
 * recorded as `verifying`; the operator verifies it against the rule and the
 * vault wallet delivers. Both signatures are public. Rules live in vaultService.js.
 */
'use strict';

function add(db, { id, mint, recipient, burnSig, createdAt }) {
  db.prepare(`INSERT INTO vault_redemptions (id, mint, recipient, burn_sig, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'verifying', ?, ?)`).run(id, mint, recipient, burnSig, createdAt, createdAt);
  return get(db, id);
}
function get(db, id) { return db.prepare('SELECT * FROM vault_redemptions WHERE id = ?').get(id) || null; }
function byBurnSig(db, sig) { return db.prepare('SELECT * FROM vault_redemptions WHERE burn_sig = ?').get(sig) || null; }
function listPublic(db) {
  return db.prepare('SELECT id, mint, recipient, burn_sig, status, tokens_burned, price_usd_at_burn, delivery_sig, created_at, updated_at FROM vault_redemptions ORDER BY created_at DESC').all();
}
function transition(db, id, from, to, { at, set = {} } = {}) {
  const cols = Object.keys(set);
  const sql = `UPDATE vault_redemptions SET status = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ? AND status = ?`;
  return db.prepare(sql).run(to, at, ...cols.map((c) => set[c]), id, from).changes > 0;
}

module.exports = { add, get, byBurnSig, listPublic, transition };
