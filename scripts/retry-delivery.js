#!/usr/bin/env node
/**
 * retry-delivery.js — the OPERATOR's path for a paid reservation whose delivery failed.
 *
 *   node scripts/retry-delivery.js                 # list reservations in `delivery_failed`
 *   node scripts/retry-delivery.js <reservationId> # run that delivery again
 *
 * Runs on the server, with the server's environment (same .env, same DB, same key —
 * there is deliberately no HTTP route for this). The payment is not re-read: it was
 * verified when the reservation entered `settling`. The delivery goes through the
 * production path again: build → assert → simulate → sign → persist → broadcast.
 */
'use strict';
const { createServer } = require('../server/index');

async function main() {
  const id = process.argv[2];
  const { service, db } = createServer();
  if (!id) {
    const rows = db.prepare("SELECT id, mint, winner, exit_price_usd, payment_sig, fail_reason, updated_at FROM vault_reservations WHERE status = 'delivery_failed' ORDER BY updated_at").all();
    if (!rows.length) { console.log('no reservation in delivery_failed'); return; }
    for (const r of rows) console.log(`${r.id}  mint ${r.mint}  → ${r.winner}  $${r.exit_price_usd}  paid ${r.payment_sig}\n    ${new Date(r.updated_at).toISOString()}  ${r.fail_reason}`);
    return;
  }
  const out = await service.retryDelivery({ reservationId: id });
  console.log(`settled · delivery ${out.deliverySignature} · ${out.mint} → ${out.winner}`);
}

main().catch((e) => { console.error(`✗ ${e.statusCode || ''} ${e.message}`); process.exit(1); });
