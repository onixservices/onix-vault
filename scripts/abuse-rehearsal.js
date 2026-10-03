#!/usr/bin/env node
/**
 * scripts/abuse-rehearsal.js — attack a running Onix.Vault server through its PUBLIC routes and check every refusal.
 *
 *   node scripts/abuse-rehearsal.js                                  # against https://vault.onix.finance
 *   node scripts/abuse-rehearsal.js --base http://127.0.0.1:3004
 *
 * Nothing here signs, sends or spends: each attack is a request the server must REFUSE before any transaction exists
 * (or, for the funded ones, before the wallet would ever see it). Rate limits are not hammered against production
 * (that would lock the address for an hour) — they are covered by server/app.test.js. Prints a table; exit 1 on any miss.
 */
'use strict';
const { Keypair } = require('@solana/web3.js');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'https://vault.onix.finance').replace(/\/$/, '');
const STRANGER = Keypair.generate().publicKey.toBase58();       // a wallet with nothing in it
const rows = [];

async function call(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (Buffer.isBuffer(body) || typeof body === 'string') init.body = body;
    else { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  }
  const r = await fetch(BASE + path, init);
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
}
async function expect(name, attack, want, fn) {
  try {
    const r = await fn();
    const ok = Array.isArray(want) ? want.includes(r.status) : r.status === want;
    rows.push({ attack: name, guard: attack, expected: String(want), got: r.status, ok: ok ? 'PASS' : 'MISS', why: (r.body && r.body.error) ? String(r.body.error).slice(0, 90) : '' });
  } catch (e) { rows.push({ attack: name, guard: attack, expected: String(want), got: 'ERR', ok: 'MISS', why: e.message.slice(0, 90) }); }
}

async function main() {
  const { vaults } = await (await fetch(BASE + '/v1/vaults')).json();
  const live = vaults.find((v) => v.stats && v.stats.poolStatus === 'migrated');
  const anyVault = live || vaults[0];
  const V = anyVault ? anyVault.vault : null;
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);

  // ── uploads ──
  await expect('SVG with a script as the coin image', 'type read from the bytes, never SVG', 415, () => call('POST', '/v1/vaults/create/upload', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>' + ' '.repeat(80) + '</svg>', { 'content-type': 'image/svg+xml' }));
  await expect('text labelled image/png', 'magic bytes, not the header', 415, () => call('POST', '/v1/vaults/create/upload', Buffer.alloc(300, 0x41), { 'content-type': 'image/png' }));
  await expect('a 1.5 MB "image"', 'size cap 1 MB', 413, () => call('POST', '/v1/vaults/create/upload', Buffer.concat([PNG, Buffer.alloc(1_500_000)]), { 'content-type': 'image/png' }));
  await expect('path traversal on the upload preview', 'ids validated before the disk', 404, () => call('GET', '/v1/vaults/create/uploads/..%2F..%2F.env'));

  // ── the Create door ──
  await expect('open a vault on items the wallet does not hold', 'eligibility read on chain', [400, 422], () => call('POST', '/v1/vaults/create/open', { owner: STRANGER, name: 'Fake', symbol: 'FAKEX', mints: [Keypair.generate().publicKey.toBase58()] }));
  await expect('a reserved symbol (USDC)', 'reserved list', 422, () => call('POST', '/v1/vaults/create/open', { owner: STRANGER, name: 'Fake', symbol: 'USDC', mints: [Keypair.generate().publicKey.toBase58()] }));
  await expect('an off-list rule (creator fee 99%)', 'rules are lists', 422, () => call('POST', '/v1/vaults/create/open', { owner: STRANGER, name: 'Fake', symbol: 'FAKEY', mints: [Keypair.generate().publicKey.toBase58()], rules: { creatorFeePct: 99 } }));
  await expect('an http (not https) link', 'links validated', 400, () => call('POST', '/v1/vaults/create/open', { owner: STRANGER, name: 'Fake', symbol: 'FAKEZ', mints: [Keypair.generate().publicKey.toBase58()], links: { x: 'javascript:alert(1)' } }));
  await expect('confirm a creation that does not exist', 'creation id checked', 404, () => call('POST', '/v1/vaults/create/confirm', { creationId: 'nope' }));
  await expect('abandon someone else\'s creation', 'owner checked', [403, 404], () => call('POST', '/v1/vaults/create/abandon', { creationId: 'nope', owner: STRANGER }));
  await expect('a 100 KB JSON body', 'body limit 64 KB', 413, () => call('POST', '/v1/vaults/create/open', { owner: STRANGER, name: 'x'.repeat(100_000) }));

  if (V) {
    // ── trade / play / admit / gacha on a real vault ──
    await expect('build a buy for a wallet with no USDC', 'simulated first: 402 with the two numbers, the wallet never sees it', 402, () => call('POST', `/v1/vaults/${V}/trades/build`, { owner: STRANGER, side: 'buy', amount: 5 }));
    await expect('a negative trade amount', 'input validated', 400, () => call('POST', `/v1/vaults/${V}/trades/quote`, { side: 'buy', amount: -5 }));
    await expect('a stranger adds an item to the vault', 'only the creator adds', 403, () => call('POST', `/v1/vaults/${V}/admissions/build`, { owner: STRANGER, mint: Keypair.generate().publicKey.toBase58() }));
    await expect('a play paid by a wallet with no USDC', 'simulated first: 402, no play row', 402, () => call('POST', `/v1/vaults/${V}/plays`, { band: 'b1', player: STRANGER, currency: 'usdc', clientSeed: 'abuse' }));
    await expect('a client seed with markup', 'seed format', 400, () => call('POST', `/v1/vaults/${V}/plays`, { band: 'b1', player: STRANGER, currency: 'usdc', clientSeed: '<img src=x>' }));
    await expect('submit a payment for a play that does not exist', 'play id checked', 404, () => call('POST', `/v1/vaults/${V}/plays/nope/submit`, { signature: '1'.repeat(88) }));
    await expect('settle a reservation that does not exist', 'reservation id checked', 404, () => call('POST', `/v1/vaults/${V}/reservations/nope/settle`, { paymentSignature: '1'.repeat(88) }));
    await expect('reserve an item the vault does not hold', 'items read on chain', [404, 409, 422], () => call('POST', `/v1/vaults/${V}/reservations`, { mint: Keypair.generate().publicKey.toBase58(), integrator: STRANGER, winner: STRANGER }));
  }
  await expect('an unknown vault', 'vaults resolved per request', 404, () => call('GET', `/v1/vaults/${Keypair.generate().publicKey.toBase58()}/stats`));
  await expect('health leaks no secret', 'health says what is configured, never a value', 200, async () => { const r = await call('GET', '/v1/health'); const s = JSON.stringify(r.body); if (/[0-9a-f]{64}|\[\s*\d+\s*,\s*\d+/.test(s)) return { status: 500, body: { error: 'looks like key material' } }; return r; });

  console.log(`\nabuse rehearsal against ${BASE} · ${new Date().toISOString()}${V ? ` · vault ${V}` : ''}\n`);
  console.table(rows.map((r) => ({ result: r.ok, attack: r.attack, expected: r.expected, got: r.got })));
  const miss = rows.filter((r) => r.ok !== 'PASS');
  if (miss.length) { for (const m of miss) console.log(`MISS · ${m.attack}: expected ${m.expected}, got ${m.got} — ${m.why}`); process.exit(1); }
  console.log(`${rows.length}/${rows.length} refused as designed.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
