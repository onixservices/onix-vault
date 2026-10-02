const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair } = require('@solana/web3.js');
const { buildApp } = require('./app');
const { VaultError } = require('./vaultService');

// Thin routes over a fake service, exercised through a real HTTP listener on an
// ephemeral port. The rules live in vaultService.test.js.
const VAULT = Keypair.generate().publicKey.toBase58();
const calls = [];
const service = {
  reserve: async (args) => { calls.push(['reserve', args]); return { reservationId: 'R1', ...args }; },
  settle: async (args) => { calls.push(['settle', args]); return { reservationId: args.reservationId, status: 'settled' }; },
  status: ({ reservationId }) => { if (reservationId === 'nope') throw new VaultError(404, 'unknown reservation'); return { reservationId, status: 'reserved' }; },
  recordRedemption: (args) => ({ redemptionId: 'X', status: 'verifying', ...args }),
  listRedemptions: () => [],
  listActivity: () => [{ type: 'gacha', at: 1, mint: 'M', to: 'W' }],
};
const stats = { read: async () => ({ readAt: 1, items: { count: 1 }, backing: { indexUsd: 20, realisableUsd: 17.8, multiplier: 0.89 }, pool: null, poolStatus: 'not launched' }), ageMs: () => 0 };
const trader = { balances: async (w) => ({ usdc: 116.64, token: 3314184.21 }), quote: async (a) => ({ side: a.side, amountIn: a.amount, amountOut: a.amount * 100, tradingFeeUsd: a.amount * 0.08 }), build: async (a) => ({ quote: { amountOut: a.amount * 100 }, transaction: 'AAAA', message: 'BBBB', owner: a.owner }) };
const admissions = { rules: { custodians: ['Collector Crypt'], category: 'graded-cards' }, eligible: async (w) => ({ wallet: w, total: 1, eligible: [{ mint: 'E', owedUsd: 10 }], ineligible: [] }), build: async (a) => ({ mint: a.mint, owedUsd: 10, transaction: 'TX', message: 'MSG' }), record: (a) => ({ id: 'A1', status: 'pending', ...a }), list: () => [{ id: 'A1', mint: 'M', owner: 'O', status: 'admitted', tokens: 'pending', owedUsd: 10, valueUsd: 14, signature: 'S', at: 5 }] };
const readWallet = async (w) => { if (w === 'bad') { const e = new Error('not a wallet address'); e.statusCode = 400; throw e; } return { wallet: w, total: 1, eligible: [{ mint: 'E' }], ineligible: [] }; };

// the reader's age moves when listItems re-reads the chain: the age served must be the
// age of the items served, not of the snapshot that was there before the read
let age = 5;
service.listItems = async () => { age = 0; return [{ mint: 'M', exitPriceUsd: 20, status: 'available' }]; };

let server, base;
before(async () => {
  const app = buildApp({ service, stats, readWallet, trader, admissions, vaultWallet: VAULT, signerConfigured: () => false, itemsAge: () => age, vaultMeta: { name: 'Vault #1', operator: 'Onix', custodians: ['Collector Crypt'] } });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const j = async (path, init) => { const res = await fetch(base + path, init); return { status: res.status, body: await res.json() }; };
const post = (path, body, headers = {}) => j(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('routes — what the page reads', () => {
  test('GET /v1/vaults lists the vaults with their stats; one vault today', async () => {
    const r = await j('/v1/vaults');
    assert.equal(r.status, 200); assert.equal(r.body.vaults.length, 1);
    assert.equal(r.body.vaults[0].vault, VAULT); assert.equal(r.body.vaults[0].name, 'Vault #1'); assert.equal(r.body.vaults[0].stats.backing.indexUsd, 20);
  });
  test('GET /v1/vaults/:vault/stats and /activity; another :vault is 404', async () => {
    const st = await j(`/v1/vaults/${VAULT}/stats`);
    assert.equal(st.status, 200); assert.equal(st.body.poolStatus, 'not launched'); assert.equal(st.body.backing.realisableUsd, 17.8);
    const ac = await j(`/v1/vaults/${VAULT}/activity`);
    assert.equal(ac.status, 200); assert.ok(ac.body.activity.some((e) => e.type === 'gacha'));
    assert.equal((await j(`/v1/vaults/${Keypair.generate().publicKey.toBase58()}/stats`)).status, 404);
  });
  test('the Create door routes carry the whole body (owner, name, symbol, mints) and mount the confirmed vault', async () => {
    const got = [];
    const creator = { quote: async (a) => ({ wallet: a.owner, canCreate: true }), build: async (a) => { got.push(a); return { creationId: 'C1', transaction: 'TX' }; }, confirm: async (a) => { got.push(a); return { id: 'myc', name: 'My', wallet: 'W9', secretEnv: null, pool: 'P', baseMint: 'M', rules: 'vault1', token: { symbol: 'MYC' } }; } };
    const mounted = [];
    const app3 = buildApp({ vaults: [], readWallet, creator, addVault: (def) => { mounted.push(def); const b = { wallet: def.wallet, meta: { id: def.id, name: def.name, token: def.token }, service: { listItems: async () => [], listActivity: () => [], listRedemptions: () => [] }, stats: { read: async () => ({ pool: null }), ageMs: () => 0 }, admissions: null, trader: null, itemsAge: () => 0, signerConfigured: () => false }; app3.locals.v = b; return b; }, webDir: null });
    const s3 = await new Promise((r) => { const x = app3.listen(0, '127.0.0.1', () => r(x)); });
    const b3 = 'http://127.0.0.1:' + s3.address().port;
    const post = async (p, body) => { const r = await fetch(b3 + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    const q = await fetch(b3 + '/v1/vaults/create/quote?wallet=W9'); assert.equal((await q.json()).wallet, 'W9');
    const b = await post('/v1/vaults/create/build', { owner: 'W9', name: 'My', symbol: 'MYC', mints: ['a', 'b'] });
    assert.equal(b.status, 200); assert.deepEqual(got[0], { owner: 'W9', name: 'My', symbol: 'MYC', mints: ['a', 'b'] });
    const c = await post('/v1/vaults/create/confirm', { creationId: 'C1', signature: 'S' });
    assert.equal(c.status, 201); assert.equal(c.body.vault.vault, 'W9'); assert.equal(mounted.length, 1);
    s3.close();
  });
  test('zero vaults is a served state: /v1/vaults is empty, health is ok, any vault path is 404', async () => {
    const app0 = buildApp({ vaults: [], readWallet, webDir: null });
    const s0 = await new Promise((r) => { const x = app0.listen(0, '127.0.0.1', () => r(x)); });
    const b0 = 'http://127.0.0.1:' + s0.address().port;
    const jj = async (p) => { const r = await fetch(b0 + p); return { status: r.status, body: await r.json() }; };
    assert.deepEqual((await jj('/v1/vaults')).body.vaults, []);
    assert.equal((await jj('/v1/health')).body.ok, true);
    assert.equal((await jj('/v1/vaults/' + VAULT + '/stats')).status, 404);
    s0.close();
  });
  test('GET /v1/vaults/:vault/trades/balances?wallet= — the two balances the panel shows', async () => {
    const b = await j('/v1/vaults/' + VAULT + '/trades/balances?wallet=W1');
    assert.equal(b.status, 200); assert.equal(b.body.usdc, 116.64); assert.equal(b.body.token, 3314184.21); assert.equal(b.body.wallet, 'W1');
  });
  test('GET /v1/wallets/:wallet/eligible-items; a bad wallet is 400 with the reason', async () => {
    const ok = await j('/v1/wallets/SomeWallet/eligible-items');
    assert.equal(ok.status, 200); assert.equal(ok.body.eligible[0].mint, 'E');
    const bad = await j('/v1/wallets/bad/eligible-items');
    assert.equal(bad.status, 400); assert.match(bad.body.error, /not a wallet/);
  });
  test('the Admit door: eligible-items for THIS vault, admissions/build, record (202), list; activity merges admissions', async () => {
    const e = await j(`/v1/vaults/${VAULT}/eligible-items?wallet=W`);
    assert.equal(e.status, 200); assert.equal(e.body.eligible[0].mint, 'E');
    const b = await post(`/v1/vaults/${VAULT}/admissions/build`, { owner: 'O', mint: 'M' });
    assert.equal(b.status, 200); assert.equal(b.body.message, 'MSG');
    const r = await post(`/v1/vaults/${VAULT}/admissions`, { mint: 'M', owner: 'O', signature: 'S', valueUsd: '14' });
    assert.equal(r.status, 202); assert.equal(r.body.valueUsd, 14);
    const l = await j(`/v1/vaults/${VAULT}/admissions`); assert.equal(l.status, 200); assert.equal(l.body.rules.category, 'graded-cards');
    const ac = await j(`/v1/vaults/${VAULT}/activity`); assert.deepEqual(ac.body.activity.map((x) => x.type), ['admit', 'gacha']);
    const v = await j('/v1/vaults'); assert.equal(v.body.vaults[0].rules.category, 'graded-cards');
  });
  test('POST trades/quote and trades/build pass through; amount is coerced; another :vault is 404', async () => {
    const q = await post(`/v1/vaults/${VAULT}/trades/quote`, { side: 'buy', amount: '10' });
    assert.equal(q.status, 200); assert.equal(q.body.amountOut, 1000); assert.equal(q.body.tradingFeeUsd, 0.8);
    const b = await post(`/v1/vaults/${VAULT}/trades/build`, { owner: 'W', side: 'sell', amount: 2 });
    assert.equal(b.status, 200); assert.equal(b.body.transaction, 'AAAA'); assert.equal(b.body.message, 'BBBB'); assert.equal(b.body.owner, 'W');
    assert.equal((await post(`/v1/vaults/${Keypair.generate().publicKey.toBase58()}/trades/quote`, { side: 'buy', amount: 1 })).status, 404);
  });
  test('without a trader (no pool yet) the trade routes answer 409 "not launched"', async () => {
    const app2 = buildApp({ service, stats, readWallet, vaultWallet: VAULT, webDir: null });
    const srv = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/v1/vaults/${VAULT}/trades/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ side: 'buy', amount: 1 }) });
    const body = await res.json(); srv.close();
    assert.equal(res.status, 409); assert.match(body.error, /not launched/);
  });
  test('the page is served at / (static web/), and unknown /v1 paths are 404 JSON', async () => {
    const res = await fetch(base + '/'); assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/html/);
    const r = await j('/v1/nope'); assert.equal(r.status, 404);
  });
});

describe('routes — two vaults, one server', () => {
  test('each vault answers for its own wallet; the list has both; an unknown wallet is 404', async () => {
    const V2 = Keypair.generate().publicKey.toBase58();
    const mk = (wallet, name, idx) => ({ wallet, meta: { id: String(idx), name }, service: { listItems: async () => [{ mint: 'M' + idx }], listActivity: () => [], listRedemptions: () => [] }, stats: { read: async () => ({ items: { count: idx }, backing: { indexUsd: idx }, pool: null, poolStatus: 'not launched' }), ageMs: () => 0 }, admissions: null, trader: null, itemsAge: () => 0, signerConfigured: () => false });
    const app2 = buildApp({ vaults: [mk(VAULT, 'Vault #1', 1), mk(V2, 'Test vault', 2)], readWallet, webDir: null });
    const srv = await new Promise((r) => { const s2 = app2.listen(0, '127.0.0.1', () => r(s2)); });
    const b = `http://127.0.0.1:${srv.address().port}`;
    const g = async (p) => { const r = await fetch(b + p); return { status: r.status, body: await r.json() }; };
    const list = await g('/v1/vaults'); assert.deepEqual(list.body.vaults.map((v) => v.name), ['Vault #1', 'Test vault']);
    assert.equal((await g(`/v1/vaults/${V2}/stats`)).body.items.count, 2);
    assert.equal((await g(`/v1/vaults/${VAULT}/items`)).body.items[0].mint, 'M1');
    assert.equal((await g(`/v1/vaults/${V2}/items`)).body.items[0].mint, 'M2');
    assert.equal((await g(`/v1/vaults/${Keypair.generate().publicKey.toBase58()}/items`)).status, 404);
    const h = await g('/v1/health'); assert.equal(h.body.vaults.length, 2);
    srv.close();
  });
});

describe('routes', () => {
  test('health says what is configured and never a secret', async () => {
    const r = await j('/v1/health');
    assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.vaultWallet, VAULT); assert.equal(r.body.signerConfigured, false); assert.equal(r.body.vaults.length, 1); assert.equal(r.body.vaults[0].vault, VAULT);
  });
  test('items for THIS vault; another :vault is 404', async () => {
    const ok = await j(`/v1/vaults/${VAULT}/items`);
    assert.equal(ok.status, 200); assert.equal(ok.body.items[0].mint, 'M'); assert.equal(typeof ok.body.readAt, 'string');
    assert.equal(ok.body.itemsAgeMs, 0, 'the age must be measured AFTER the read, for the items actually served');
    const other = await j(`/v1/vaults/${Keypair.generate().publicKey.toBase58()}/items`);
    assert.equal(other.status, 404); assert.equal(other.body.code, 404);
  });
  test('reservations: 201, Idempotency-Key passed through', async () => {
    const r = await post(`/v1/vaults/${VAULT}/reservations`, { mint: 'M', integrator: 'G', winner: 'W' }, { 'Idempotency-Key': 'k9' });
    assert.equal(r.status, 201); assert.equal(r.body.reservationId, 'R1');
    assert.deepEqual(calls.at(-1), ['reserve', { mint: 'M', integrator: 'G', winner: 'W', idempotencyKey: 'k9' }]);
  });
  test('settle delegates with id + signature; status 404 carries the service code', async () => {
    const r = await post(`/v1/vaults/${VAULT}/reservations/R1/settle`, { paymentSignature: 'P' });
    assert.equal(r.status, 200); assert.deepEqual(calls.at(-1), ['settle', { reservationId: 'R1', paymentSignature: 'P' }]);
    const s = await j(`/v1/vaults/${VAULT}/reservations/nope`);
    assert.equal(s.status, 404); assert.equal(s.body.error, 'unknown reservation');
  });
  test('redemptions: 202 on record, list is public', async () => {
    const r = await post(`/v1/vaults/${VAULT}/redemptions`, { mint: 'M', burnSignature: 'B', recipient: 'W' });
    assert.equal(r.status, 202); assert.equal(r.body.status, 'verifying');
    assert.equal((await j(`/v1/vaults/${VAULT}/redemptions`)).status, 200);
  });
});
