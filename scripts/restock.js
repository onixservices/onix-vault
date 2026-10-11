#!/usr/bin/env node
/**
 * scripts/restock.js — the treasury buys the next item, by hand, on the server.
 *
 *   node scripts/restock.js --vault <id|custody>            # dry run: treasury, budget, the pick and every rejection
 *   node scripts/restock.js --vault <id|custody> --go       # buy it: asserted, simulated, signed by the custody key, persisted, broadcast
 *   node scripts/restock.js --vault <id|custody> --confirm  # confirm sent purchases against the chain (the server does this every 2 min)
 *
 * The same code path the server's sweep runs when ONIX_VAULT_RESTOCK=1. Runs as the service user
 * (the key never leaves the box): `node --env-file=.env scripts/restock.js …`.
 */
'use strict';
const { createServer } = require('../server/index');

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const GO = process.argv.includes('--go'), CONFIRM = process.argv.includes('--confirm');

async function main() {
  const id = arg('--vault'); if (!id) throw new Error('usage: restock.js --vault <id|custody> [--go|--confirm]');
  const { vaults } = createServer();
  const v = vaults.find((x) => x.meta.id === id || x.wallet === id); if (!v) throw new Error(`no vault "${id}" (${vaults.map((x) => x.meta.id).join(', ') || 'none'})`);
  if (!v.restock) throw new Error('this vault has no restock (no custody signer)');
  console.log(`${GO ? 'RESTOCK (mainnet)' : CONFIRM ? 'restock confirm' : 'restock dry-run'} · ${v.meta.name} · custody ${v.wallet} · rules: ${v.meta.rulesText}`);
  if (CONFIRM) { console.log(await v.restock.confirm()); console.table(v.restock.list({ limit: 10 })); return; }
  const r = await v.restock.execute({ go: GO });
  console.log(`treasury $${r.treasuryUsd} · budget $${r.budgetUsd} · ${r.considered} listings looked at`);
  if (Object.keys(r.rejected).length) console.log('rejected:', r.rejected);
  console.log(r.pick ? `pick: ${r.pick.name} (${r.pick.mint}) · $${r.pick.priceUsd} · index $${r.pick.insuredUsd} · ${r.pick.ratio}× · seller ${r.pick.seller}` : `no pick: ${r.why}`);
  if (r.dry) console.log('\n(dry-run: the venue\'s transaction passed assertions and simulation; nothing signed. Repeat with --go.)');
  if (r.bought) console.log(`\nBOUGHT · ${r.bought.signature}\nhttps://solscan.io/tx/${r.bought.signature}\nThe server confirms it against the chain within 2 minutes and adds it to the manifest.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
