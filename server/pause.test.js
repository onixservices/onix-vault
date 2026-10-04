const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPause } = require('./pause');
const { buildApp } = require('./app');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vault-pause-'));

describe('pause — the emergency stop is a file', () => {
  test('no file → not paused; data/PAUSE → everything paused; data/PAUSE-<id> → only that vault', () => {
    const dir = tmp(); let t = 0;
    const p = createPause({ dir, now: () => t, ttlMs: 5000 });
    assert.equal(p.isPaused(null), false);
    assert.equal(p.isPaused({ wallet: 'W1', id: 'occ' }), false);
    fs.writeFileSync(path.join(dir, 'PAUSE-occ'), '');
    t += 5000;
    assert.equal(p.isPaused({ wallet: 'W1', id: 'occ' }), true);
    assert.equal(p.isPaused({ wallet: 'W2', id: 'other' }), false);
    assert.equal(p.isPaused(null), false, 'one vault paused does not pause the platform');
    fs.writeFileSync(path.join(dir, 'PAUSE'), '');
    t += 5000;
    assert.equal(p.isPaused({ wallet: 'W2', id: 'other' }), true);
    assert.equal(p.isPaused(null), true);
    assert.deepEqual(p.state(), { global: true, vaults: ['occ'] });
  });
  test('the file is read at most every few seconds, and removing it lifts the pause', () => {
    const dir = tmp(); let t = 0;
    const p = createPause({ dir, now: () => t, ttlMs: 5000 });
    assert.equal(p.isPaused(), false);
    fs.writeFileSync(path.join(dir, 'PAUSE'), '');
    assert.equal(p.isPaused(), false, 'cached for ttlMs');
    t += 5000; assert.equal(p.isPaused(), true);
    fs.unlinkSync(path.join(dir, 'PAUSE'));
    t += 5000; assert.equal(p.isPaused(), false);
  });
  test('a missing directory reads as not paused (never throws)', () => {
    assert.equal(createPause({ dir: path.join(tmp(), 'nope') }).isPaused(), false);
  });
});

describe('pause — the routes that move value answer 503; reads keep working', () => {
  const vault = { wallet: 'W1', meta: { id: 'occ' }, service: { listItems: async () => [] }, itemsAge: () => 0, signerConfigured: () => true };
  const call = async (app, method, url, body) => {
    const server = app.listen(0); const { port } = server.address();
    try {
      const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    } finally { server.close(); }
  };
  test('paused: plays, settle, reservations, creation and admissions → 503; health says paused; items still read', async () => {
    const app = buildApp({ vaults: [vault], pause: { isPaused: () => true, state: () => ({ global: true, vaults: [] }) } });
    for (const [m, u] of [['POST', '/v1/vaults/W1/plays'], ['POST', '/v1/vaults/W1/plays/x/submit'], ['POST', '/v1/vaults/W1/reservations'], ['POST', '/v1/vaults/W1/reservations/x/settle'], ['POST', '/v1/vaults/create/open'], ['POST', '/v1/vaults/create/deposited'], ['POST', '/v1/vaults/create/abandon'], ['POST', '/v1/vaults/W1/admissions']]) {
      const r = await call(app, m, u, {});
      assert.equal(r.status, 503, `${m} ${u}`); assert.match(r.body.error, /paused/);
    }
    const h = await call(app, 'GET', '/v1/health');
    assert.equal(h.status, 200); assert.equal(h.body.paused.global, true);
    assert.equal((await call(app, 'GET', '/v1/vaults/W1/items')).status, 200);
  });
  test('not paused: the same routes reach the services (no 503 from the pause)', async () => {
    const app = buildApp({ vaults: [vault], pause: { isPaused: () => false, state: () => ({ global: false, vaults: [] }) } });
    const r = await call(app, 'POST', '/v1/vaults/W1/reservations', {});
    assert.notEqual(r.status, 503);
  });
});
