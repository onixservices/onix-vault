const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const spec = require('./openapi.json');

// The public contract cannot drift from the code (4 Oct 2026: a day of hardening changed status codes on a dozen routes
// and the spec still described the day before). Read the routes straight from app.js and hold the spec to them.
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const routes = [...src.matchAll(/app\.(get|post)\('([^']+)',([^\n]*)/g)]
  .map(([, method, route, rest]) => ({ method, route, rest, openapi: route.replace(/:(\w+)/g, '{$1}') }))
  .filter((r) => r.route.startsWith('/v1/'));

describe('openapi.json — the public contract matches the routes', () => {
  test('every /v1 route the app serves is documented with its method', () => {
    const missing = routes.filter((r) => !(spec.paths[r.openapi] && spec.paths[r.openapi][r.method])).map((r) => `${r.method.toUpperCase()} ${r.openapi}`);
    assert.deepEqual(missing, []);
  });
  test('every route the emergency pause stops documents 503', () => {
    const missing = routes.filter((r) => /\bhalt\b/.test(r.rest)).filter((r) => !spec.paths[r.openapi][r.method].responses['503']).map((r) => `${r.method.toUpperCase()} ${r.openapi}`);
    assert.deepEqual(missing, []);
  });
  test('every rate-fenced route documents 429', () => {
    const missing = routes.filter((r) => /fence\('/.test(r.rest)).filter((r) => !spec.paths[r.openapi][r.method].responses['429']).map((r) => `${r.method.toUpperCase()} ${r.openapi}`);
    assert.deepEqual(missing, []);
  });
  test('the activity types are the ones the server emits (the redemption door left the contract in 1.5.0)', () => {
    const types = spec.paths['/v1/vaults/{vault}/activity'].get.responses['200'].content['application/json'].schema.properties.activity.items.properties.type.enum;
    assert.ok(!types.includes('redeem'), types.join(','));
  });
  test('admissions/build answers what server/admissions.js returns: a transfer, never tokens owed', () => {
    const props = spec.paths['/v1/vaults/{vault}/admissions/build'].post.responses['200'].content['application/json'].schema.properties;
    assert.deepEqual(Object.keys(props).sort(), ['message', 'mint', 'realisableUsd', 'transaction', 'valueUsd']);
    assert.ok(!/owed tokens/.test(spec.paths['/v1/vaults/{vault}/admissions/build'].post.description));
  });
  test('health says whether the server is paused; errors may carry a reference; slippage is bounded', () => {
    assert.ok(spec.components.schemas.Health.properties.paused, 'Health.paused');
    assert.ok(spec.components.schemas.Error.properties.ref, 'Error.ref');
    const q = spec.paths['/v1/vaults/{vault}/trades/quote'].post.requestBody.content['application/json'].schema.properties.slippageBps;
    assert.equal(q.minimum, 1); assert.equal(q.maximum, 500);
  });
});
