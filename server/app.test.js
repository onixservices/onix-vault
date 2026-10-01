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
const trader = { quote: async (a) => ({ side: a.side, amountIn: a.amount, amountOut: a.amount * 100, tradingFeeUsd: a.amount * 0.08 }), build: async (a) => ({ quote: { amountOut: a.amount * 100 }, transaction: 'AAAA', message: 'BBBB', owner: a.owner }) };
const readWallet = async (w) => { if (w === 'bad') { const e = new Error('not a wallet address'); e.statusCode = 400; throw e; } return { wallet: w, total: 1, eligible: [{ mint: 'E' }], ineligible: [] }; };

// the reader's age moves when listItems re-reads the chain: the age served must be the
// age of the items served, not of the snapshot that was there before the read
let age = 5;
service.listItems = async () => { age = 0; return [{ mint: 'M', exitPriceUsd: 20, status: 'available' }]; };

let server, base;
before(async () => {
  const app = buildApp({ service, stats, readWallet, trader, vaultWallet: VAULT, signerConfigured: () => false, itemsAge: () => age, vaultMeta: { name: 'Vault #1', operator: 'Onix', custodians: ['Collector Crypt'] } });
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
    assert.equal(ac.status, 200); assert.equal(ac.body.activity[0].type, 'gacha');
    assert.equal((await j(`/v1/vaults/${Keypair.generate().publicKey.toBase58()}/stats`)).status, 404);
  });
  test('GET /v1/wallets/:wallet/eligible-items; a bad wallet is 400 with the reason', async () => {
    const ok = await j('/v1/wallets/SomeWallet/eligible-items');
    assert.equal(ok.status, 200); assert.equal(ok.body.eligible[0].mint, 'E');
    const bad = await j('/v1/wallets/bad/eligible-items');
    assert.equal(bad.status, 400); assert.match(bad.body.error, /not a wallet/);
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

describe('routes', () => {
  test('health says what is configured and never a secret', async () => {
    const r = await j('/v1/health');
    assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, vaultWallet: VAULT, signerConfigured: false, itemsAgeMs: 5 });
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
