const { test, describe } = require('node:test');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { buildApp } = require('./app');
const { VaultError } = require('./vaultService');
const { parseSecret } = require('./signer');

// What an error may say in public: a known status keeps its message (minus any API key in a URL);
// anything unexpected answers a generic 500 with a reference, and the text stays in the server's log.
const call = async (app, url) => {
  const server = app.listen(0); const { port } = server.address();
  try { const r = await fetch(`http://127.0.0.1:${port}${url}`); return { status: r.status, body: await r.json() }; }
  finally { server.close(); }
};
const vaultThatThrows = (e) => ({ wallet: 'W1', meta: { id: 'v1' }, service: { listItems: async () => { throw e; } }, itemsAge: () => 0, signerConfigured: () => false });
const quietly = async (fn) => { const orig = console.error; const logged = []; console.error = (...a) => logged.push(a.join(' ')); try { return { r: await fn(), logged }; } finally { console.error = orig; } };

describe('errors — what leaves the server', () => {
  test('an unexpected error → 500 with a generic message and a reference; the RPC URL, its key and SQLite text stay out of the body', async () => {
    for (const msg of ['request to https://rpc.example.test/?api-key=SECRET123 failed, reason: ECONNRESET', 'UNIQUE constraint failed: vault_plays.payment_sig']) {
      const { r, logged } = await quietly(() => call(buildApp({ vaults: [vaultThatThrows(new Error(msg))], webDir: null }), '/v1/vaults/W1/items'));
      assert.equal(r.status, 500);
      assert.doesNotMatch(JSON.stringify(r.body), /SECRET123|rpc.example|UNIQUE|vault_plays/);
      assert.match(r.body.error, /internal error \(ref [0-9a-f]{8}\)/);
      assert.ok(logged.some((l) => l.includes(r.body.ref)), 'the reference is in the log, next to the real error');
      assert.ok(!logged.some((l) => l.includes('SECRET123')), 'not even the log keeps the key');
    }
  });
  test('a known error keeps its message, minus any API key in a URL', async () => {
    const r = await call(buildApp({ vaults: [vaultThatThrows(new VaultError(409, 'the venue at https://x.test/buy?api-key=SECRET123&a=1 refused'))], webDir: null }), '/v1/vaults/W1/items');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /the venue at https:\/\/x\.test\/buy\?api-key=…&a=1 refused/);
  });
  test('a malformed VAULT_SECRET_KEY is refused without echoing any of it', () => {
    for (const bad of ['[12,34,abcQZXW', 'QZXW0OIl']) {
      assert.throws(() => parseSecret(bad), (e) => /VAULT_SECRET_KEY is malformed/.test(e.message) && !e.message.includes('QZXW'));
    }
  });
});

describe('headers — the app sends the same security headers as the proxy', () => {
  test('CSP (scripts only from the site), no framing, nosniff, referrer policy; no x-powered-by', async () => {
    const app = buildApp({ vaults: [], webDir: null });
    const server = app.listen(0); const { port } = server.address();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/health`);
      assert.match(r.headers.get('content-security-policy') || '', /script-src 'self';.*frame-ancestors 'none'/);
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(r.headers.get('x-powered-by'), null);
    } finally { server.close(); }
  });
  // 9 Oct 2026: the Create preview read the picked file through a blob: URL, which img-src refuses —
  // "that file is not an image the browser can read" for every valid PNG. The page and the policy agree here.
  test('the page never loads an image from a scheme img-src refuses', async () => {
    const app = buildApp({ vaults: [], webDir: null });
    const server = app.listen(0); const { port } = server.address();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/health`);
      const imgSrc = (r.headers.get('content-security-policy').match(/img-src ([^;]+)/) || [, ''])[1];
      const page = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
      if (!/blob:/.test(imgSrc)) assert.equal(/createObjectURL/.test(page), false, 'web/app.js builds a blob: URL for an image, and img-src has no blob:');
    } finally { server.close(); }
  });
});
