#!/usr/bin/env node
/**
 * scripts/payout.js — the custody's fee claim and the sales it owes, by hand, on the server.
 *
 *   node scripts/payout.js --vault <id|custody>              # dry run: fees claimable, sales owed, the legs, the simulated deltas and SOL; nothing signed
 *   node scripts/payout.js --vault <id|custody> --go         # claim the fees (and pay the sales owed when ONIX_VAULT_SALE_COMMISSION=1)
 *   node scripts/payout.js --vault <id|custody> --go --pay   # claim AND pay the sales owed, whatever the flag says: the first payout, watched on Solscan
 *   node scripts/payout.js --vault <id|custody> --confirm    # confirm sent claims against the chain (the server does this every 2 min)
 *   node scripts/payout.js --vault <id|custody> --ledger     # every sale in the ledger: split, status, payout
 *
 * The same code path the server's round runs every 15 minutes (server/feeclaim.js + server/commissions.js). Runs as the
 * service user (the key never leaves the box): `sudo -u onixvault node --env-file=.env scripts/payout.js …`.
 */
'use strict';
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const GO = process.argv.includes('--go'), CONFIRM = process.argv.includes('--confirm'), LEDGER = process.argv.includes('--ledger'), PAY = process.argv.includes('--pay');
// --pay: the vault reads the flag once, when the server is built — set it before
if (PAY) process.env.ONIX_VAULT_SALE_COMMISSION = '1';
const { createServer } = require('../server/index');

const usd = (n) => (n < 0 ? '−' : '') + '$' + Math.abs(n || 0).toFixed(2);
const short = (s) => (s ? s.slice(0, 8) + '…' : '');

async function main() {
  const id = arg('--vault'); if (!id) throw new Error('usage: payout.js --vault <id|custody> [--go [--pay] | --confirm | --ledger]');
  const { vaults } = createServer();
  const v = vaults.find((x) => x.meta.id === id || x.wallet === id); if (!v) throw new Error(`no vault "${id}" (${vaults.map((x) => x.meta.id).join(', ') || 'none'})`);
  if (!v.feeclaim || !v.commissions) throw new Error('this vault has no fee claim');
  const mode = GO ? (PAY ? 'PAYOUT (mainnet)' : 'FEE CLAIM (mainnet)') : CONFIRM ? 'confirm' : LEDGER ? 'ledger' : 'dry-run';
  console.log(`${mode} · ${v.meta.name} · custody ${v.wallet} · creator ${v.commissions.creatorWallet || `none (${v.commissions.creatorWaived})`}`);
  if (LEDGER) {
    console.table(v.commissions.list({ limit: 100 }).map((s) => ({ at: new Date(s.at).toISOString(), source: s.source, ref: short(s.refId), item: short(s.mint), price: s.priceUsd, creator: s.creatorUsd, onix: s.onixUsd, treasury: s.treasuryUsd, status: s.status, payout: s.payoutSignature ? short(s.payoutSignature) : s.payoutId || '' })));
    console.log(`owed now (creator + Onix): ${usd(v.commissions.encumberedUnits() / 1e6)}`);
    return;
  }
  if (CONFIRM) { console.log(await v.feeclaim.confirm()); console.table(v.feeclaim.list({ limit: 10 })); return; }
  const r = await v.feeclaim.execute({ go: GO });
  if (r.why && r.curveUnits == null) { console.log(`no claim: ${r.why}`); return; }
  console.log(`fees: curve ${usd(r.curveUnits / 1e6)}${r.takeCurve ? '' : ' (waits)'} · pool ${usd(r.poolUnits / 1e6)}${r.takePool ? '' : ' (waits)'}`);
  console.log(`sales: ${r.salesOwedCount} owed${r.takeSales ? ` · paying ${r.salesCount}: creator ${usd(r.creatorUnits / 1e6)} → ${r.creatorWallet || 'stays (no creator)'} · Onix ${usd(r.salesOnixUnits / 1e6)}` : r.salesOwedCount ? ' · NOT paid in this run (ONIX_VAULT_SALE_COMMISSION is not 1; use --go --pay)' : ''}`);
  if (r.why) { console.log(`no claim: ${r.why}`); return; }
  console.log(`legs: treasury ${usd(r.treasuryUnits / 1e6)} · Onix +${usd(r.onixUnits / 1e6)} · creator +${usd(r.creatorUnits / 1e6)}${r.feesDeferred ? ' · the fee claims did not fit in the transaction: legs only, fees next round' : ''}`);
  console.log(`simulated: treasury ${r.treasuryDelta} · Onix ${r.onixDelta} · creator ${r.creatorDelta} (micro-USDC, each equal to the plan) · SOL ${r.solSpent == null ? 'not touched (no legs)' : r.solSpent + ' lamports'}`);
  if (r.dry) console.log('\n(dry-run: built, asserted, simulated; nothing signed. Repeat with --go.)');
  if (r.claimed) console.log(`\nSENT · ${r.claimed.signature}\nhttps://solscan.io/tx/${r.claimed.signature}\nThe server confirms it against the chain within 2 minutes; the sales it carries turn paid then. Or: --confirm.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
