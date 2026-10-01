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
  listItems: async () => [{ mint: 'M', exitPriceUsd: 20, status: 'available' }],
  reserve: async (args) => { calls.push(['reserve', args]); return { reservationId: 'R1', ...args }; },
  settle: async (args) => { calls.push(['settle', args]); return { reservationId: args.reservationId, status: 'settled' }; },
  status: ({ reservationId }) => { if (reservationId === 'nope') throw new VaultError(404, 'unknown reservation'); return { reservationId, status: 'reserved' }; },
  recordRedemption: (args) => ({ redemptionId: 'X', status: 'verifying', ...args }),
  listRedemptions: () => [],
};

let server, base;
before(async () => {
  const app = buildApp({ service, vaultWallet: VAULT, signerConfigured: () => false, itemsAge: () => 5 });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const j = async (path, init) => { const res = await fetch(base + path, init); return { status: res.status, body: await res.json() }; };
const post = (path, body, headers = {}) => j(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('routes', () => {
  test('health says what is configured and never a secret', async () => {
    const r = await j('/v1/health');
    assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, vaultWallet: VAULT, signerConfigured: false, itemsAgeMs: 5 });
  });
  test('items for THIS vault; another :vault is 404', async () => {
    const ok = await j(`/v1/vaults/${VAULT}/items`);
    assert.equal(ok.status, 200); assert.equal(ok.body.items[0].mint, 'M'); assert.equal(typeof ok.body.readAt, 'string');
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
