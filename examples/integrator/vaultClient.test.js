const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVaultClient, VaultApiError } = require('./vaultClient');

test('the client speaks the v1 paths and carries Idempotency-Key and x-api-key', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push([init.method, url, init.headers, init.body]); return { ok: true, status: 200, json: async () => ({ items: [], reservationId: 'R' }) }; };
  const c = createVaultClient({ baseUrl: 'https://vault.onix.finance/', vault: 'V', apiKey: 'k', fetchImpl });
  await c.items(); await c.reserve({ mint: 'M', integrator: 'I', winner: 'W', idempotencyKey: 'id1' }); await c.settle('R', 'SIG');
  assert.equal(seen[0][1], 'https://vault.onix.finance/v1/vaults/V/items');
  assert.equal(seen[1][2]['Idempotency-Key'], 'id1'); assert.equal(seen[1][2]['x-api-key'], 'k');
  assert.deepEqual(JSON.parse(seen[2][3]), { paymentSignature: 'SIG' });
});

test('errors carry the service status and body', async () => {
  const c = createVaultClient({ baseUrl: 'http://x', vault: 'V', fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: 'already reserved', code: 409 }) }) });
  await assert.rejects(c.reserve({ mint: 'M', integrator: 'I', winner: 'W' }), (e) => e instanceof VaultApiError && e.statusCode === 409);
});
