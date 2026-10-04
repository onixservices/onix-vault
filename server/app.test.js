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
  test('the Create door routes carry the whole body through open → deposited → submit → confirm → abandon, and mount the confirmed vault once', async () => {
    const got = [];
    const def = { id: 'myc', name: 'My', wallet: 'CUSTODY', creator: 'W9', secretEnv: null, pool: 'P', baseMint: 'M', rules: 'vault1', token: { symbol: 'MYC' } };
    const creator = {
      quote: async (a) => ({ wallet: a.owner, rules: a.rules, canCreate: true }),
      open: async (a) => { got.push(['open', a]); return { creationId: 'C1', custodyWallet: 'CUSTODY', depositTransactions: ['D1'] }; },
      deposited: async (a) => { got.push(['deposited', a]); return { creationId: 'C1', transaction: 'TX' }; },
      submit: async (a) => { got.push(['submit', a]); return { signature: 'S' }; },
      confirm: async (a) => { got.push(['confirm', a]); return def; },
      abandon: async (a) => { got.push(['abandon', a]); return { creationId: a.creationId, returned: [] }; },
      status: async (a) => ({ creationId: a.creationId, status: 'opened' }),
    };
    const mounted = [];   // in production addVault pushes into the same array the app serves; the fake does the same
    const app3 = buildApp({ vaults: mounted, readWallet, creator, addVault: (d) => { const b = { wallet: d.wallet, meta: { id: d.id, name: d.name, token: d.token }, service: { listItems: async () => [], listActivity: () => [], listRedemptions: () => [] }, stats: { read: async () => ({ pool: null }), ageMs: () => 0 }, admissions: null, trader: null, itemsAge: () => 0, signerConfigured: () => false }; mounted.push(b); return b; }, webDir: null });
    const s3 = await new Promise((r) => { const x = app3.listen(0, '127.0.0.1', () => r(x)); });
    const b3 = 'http://127.0.0.1:' + s3.address().port;
    const post = async (p, body) => { const r = await fetch(b3 + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    const q = await fetch(b3 + '/v1/vaults/create/quote?wallet=W9&rules=' + encodeURIComponent('{"category":"pokemon"}')); const qb = await q.json(); assert.equal(qb.wallet, 'W9'); assert.deepEqual(qb.rules, { category: 'pokemon' });
    assert.equal((await fetch(b3 + '/v1/vaults/create/quote?wallet=W9&rules=nope')).status, 400);
    const o = await post('/v1/vaults/create/open', { owner: 'W9', name: 'My', symbol: 'MYC', mints: ['a', 'b'], rules: { gradMult: 3 }, description: 'd', links: { x: 'https://x.com/a' } });
    assert.equal(o.status, 201); assert.deepEqual(got[0][1], { owner: 'W9', name: 'My', symbol: 'MYC', mints: ['a', 'b'], rules: { gradMult: 3 }, description: 'd', links: { x: 'https://x.com/a' }, imageId: undefined, bannerId: undefined });
    const d = await post('/v1/vaults/create/deposited', { creationId: 'C1' });
    assert.equal(d.status, 200); assert.deepEqual(got[1][1], { creationId: 'C1' });
    const sub = await post('/v1/vaults/create/submit', { creationId: 'C1', signedTransaction: 'TX2' });
    assert.equal(sub.status, 200); assert.deepEqual(got[2][1], { creationId: 'C1', signedTransaction: 'TX2' });
    const c = await post('/v1/vaults/create/confirm', { creationId: 'C1', signature: 'S' });
    assert.equal(c.status, 201); assert.equal(c.body.vault.vault, 'CUSTODY'); assert.equal(mounted.length, 1);
    const c2 = await post('/v1/vaults/create/confirm', { creationId: 'C1', signature: 'S' });
    assert.equal(c2.status, 201); assert.equal(mounted.length, 1, 'a second confirm does not mount twice');
    const ab = await post('/v1/vaults/create/abandon', { creationId: 'C1', owner: 'W9' });
    assert.equal(ab.status, 200); assert.deepEqual(got[got.length - 1][1], { creationId: 'C1', owner: 'W9' });
    assert.equal((await post('/v1/vaults/create/abandon', { creationId: 'C1' })).status, 400, 'owner is required');
    const st = await fetch(b3 + '/v1/vaults/create/C1'); assert.equal((await st.json()).status, 'opened');
    s3.close();
  });
  test('the Play door routes: bands, start (201), submit (202), get, list; activity merges plays', async () => {
    const got = [];
    const play = { bands: async () => ({ bands: [{ id: 'b1', items: 2 }], currencies: { usdc: true, token: true } }), start: async (a) => { got.push(a); return { playId: 'PL1', paymentTransaction: 'TX', serverSeedHash: 'H' }; }, submit: (a) => { got.push(a); return { playId: a.playId, status: 'submitted' }; }, get: (id) => ({ playId: id, status: 'delivered' }), list: () => [{ playId: 'PL1', at: 9, band: 'b1', currency: 'usdc', price: 25.3, unit: 'USDC', mint: 'M', player: 'P', status: 'delivered', paymentSignature: 'PS', deliverySignature: 'DS' }], busyMints: () => [] };
    const app4 = buildApp({ vaults: [{ wallet: 'V4', meta: { id: 'v4', name: 'V4', token: { symbol: 'FOUR' } }, service: { listItems: async () => [], listActivity: () => [], listRedemptions: () => [] }, stats: null, admissions: null, trader: null, play, itemsAge: () => 0, signerConfigured: () => true }], readWallet, webDir: null });
    const s4 = await new Promise((r) => { const x = app4.listen(0, '127.0.0.1', () => r(x)); });
    const b4 = 'http://127.0.0.1:' + s4.address().port;
    const post = async (p, body) => { const r = await fetch(b4 + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    const bands = await (await fetch(b4 + '/v1/vaults/V4/play')).json(); assert.equal(bands.tokenSymbol, 'FOUR'); assert.equal(bands.bands.length, 1);
    const st = await post('/v1/vaults/V4/plays', { band: 'b1', player: 'P', currency: 'usdc', clientSeed: 's' });
    assert.equal(st.status, 201); assert.deepEqual(got[0], { band: 'b1', player: 'P', currency: 'usdc', clientSeed: 's' });
    const sub = await post('/v1/vaults/V4/plays/PL1/submit', { signature: 'SIG' });
    assert.equal(sub.status, 202); assert.deepEqual(got[1], { playId: 'PL1', signature: 'SIG' });
    assert.equal((await (await fetch(b4 + '/v1/vaults/V4/plays/PL1')).json()).status, 'delivered');
    const act = await (await fetch(b4 + '/v1/vaults/V4/activity')).json();
    assert.equal(act.activity[0].type, 'play'); assert.equal(act.activity[0].to, 'P');
    s4.close();
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
  test('uploads: raw bytes in → 201 with the id; preview served with a fixed type and nosniff; SVG 415; the vault\'s image and banner under /token/; the metadata points at them', async () => {
    const { createUploads } = require('./uploads');
    const { getTestDb } = require('./db');
    const fs = require('fs'), os = require('os'), path = require('path');
    const uploads = createUploads({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'vault-up-')) });
    const db = getTestDb();
    let allowed = true;
    const appU = buildApp({ vaults: [], readWallet, db, uploads, uploadLimiter: () => allowed, webDir: null });
    const sU = await new Promise((r) => { const x = appU.listen(0, '127.0.0.1', () => r(x)); });
    const bU = 'http://127.0.0.1:' + sU.address().port;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]);
    const up = await fetch(bU + '/v1/vaults/create/upload', { method: 'POST', headers: { 'content-type': 'image/png' }, body: png });
    assert.equal(up.status, 201); const u = await up.json(); assert.match(u.uploadId, /\.png$/); assert.equal(u.type, 'image/png'); assert.equal(u.bytes, 308);
    const pv = await fetch(bU + u.url); assert.equal(pv.status, 200); assert.equal(pv.headers.get('content-type'), 'image/png'); assert.equal(pv.headers.get('x-content-type-options'), 'nosniff'); assert.equal((await pv.arrayBuffer()).byteLength, 308);
    const svg = await fetch(bU + '/v1/vaults/create/upload', { method: 'POST', headers: { 'content-type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg">' + ' '.repeat(100) + '</svg>' });
    assert.equal(svg.status, 415);
    // a lying content-type does not help: the bytes decide
    const lie = await fetch(bU + '/v1/vaults/create/upload', { method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.alloc(200, 0x41) }); assert.equal(lie.status, 415);
    allowed = false; assert.equal((await fetch(bU + '/v1/vaults/create/upload', { method: 'POST', body: png })).status, 429); allowed = true;
    assert.equal((await fetch(bU + '/v1/vaults/create/uploads/../../etc/passwd')).status, 404);
    // a vault row with the image → /token/<mint>.png serves it; banner absent → 404; metadata carries the image
    db.prepare(`INSERT INTO vaults (id, name, operator, wallet, pool, base_mint, config, graduation_usd, token_name, token_symbol, rules, created_by, created_at, image) VALUES ('t','T','o','W','P','MINT1','C',1,'T','T','custom','x',1,?)`).run(u.uploadId);
    const im = await fetch(bU + '/token/MINT1.png'); assert.equal(im.status, 200); assert.equal(im.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(bU + '/token/MINT1-banner.png')).status, 404);
    // fetch drops a custom Host header; http.get sends it for real
    const spoof = await new Promise((ok, ko) => require('http').get({ host: '127.0.0.1', port: sU.address().port, path: '/token/MINT1.json', headers: { Host: 'evil.test' } }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => ok(JSON.parse(d))); }).on('error', ko));
    assert.ok(!JSON.stringify(spoof).includes('evil.test'), 'the token metadata never takes its URLs from the Host header');
    const meta = await (await fetch(bU + '/token/MINT1.json')).json(); assert.match(meta.image, /\/token\/MINT1\.png$/); assert.equal(meta.banner, undefined); assert.match(meta.external_url, /#\/vault\/t$/); assert.equal(meta.extensions.website, meta.external_url); assert.equal(meta.twitter, undefined);
    sU.close();
  });
  test('fences: a limiter that denies turns the costly routes into 429 and leaves reads alone', async () => {
    const appF = buildApp({ service, stats, readWallet, trader, admissions, vaultWallet: VAULT, signerConfigured: () => false, itemsAge: () => 0, vaultMeta: {}, webDir: null, limits: { play: () => false, build: () => false, create: () => false } });
    const sF = await new Promise((r) => { const x = appF.listen(0, '127.0.0.1', () => r(x)); });
    const bF = 'http://127.0.0.1:' + sF.address().port;
    const jp = async (p, body) => { const r = await fetch(bF + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.status; };
    assert.equal(await jp('/v1/vaults/' + VAULT + '/trades/build', { owner: 'o', side: 'buy', amount: 1 }), 429);
    assert.equal(await jp('/v1/vaults/' + VAULT + '/plays', { band: 'b1' }), 429);
    assert.equal(await jp('/v1/vaults/' + VAULT + '/reservations', { mint: 'M' }), 429);
    assert.equal(await jp('/v1/vaults/' + VAULT + '/trades/quote', { side: 'buy', amount: 1 }), 200);
    assert.equal((await fetch(bF + '/v1/vaults/' + VAULT + '/items')).status, 200);
    sF.close();
  });
  test('fences reach every route that signs, settles or reads the chain on demand; reads served from cache stay open', async () => {
    const appR = buildApp({ service, stats, readWallet, trader, admissions, vaultWallet: VAULT, signerConfigured: () => false, itemsAge: () => 0, vaultMeta: {}, webDir: null, creator: {}, limits: { play: () => false, build: () => false, create: () => false, read: () => false } });
    const sR = await new Promise((r) => { const x = appR.listen(0, '127.0.0.1', () => r(x)); });
    const bR = 'http://127.0.0.1:' + sR.address().port;
    const st = async (m, p, body) => (await fetch(bR + p, { method: m, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).status;
    for (const p of ['/v1/vaults/create/deposited', '/v1/vaults/create/submit', '/v1/vaults/create/confirm', '/v1/vaults/create/abandon', '/v1/vaults/' + VAULT + '/plays/x/submit', '/v1/vaults/' + VAULT + '/reservations/x/settle', '/v1/vaults/' + VAULT + '/redemptions', '/v1/vaults/' + VAULT + '/trades/quote']) assert.equal(await st('POST', p, {}), 429, p);
    for (const p of ['/v1/wallets/W/eligible-items', '/v1/vaults/' + VAULT + '/eligible-items?wallet=W', '/v1/vaults/' + VAULT + '/trades/balances?wallet=W', '/v1/vaults/create/quote?wallet=W']) assert.equal(await st('GET', p), 429, p);
    assert.equal(await st('GET', '/v1/vaults/' + VAULT + '/stats?fresh=1'), 200, 'a fresh read over the fence is served from the cache, not refused');
    assert.equal(await st('GET', '/v1/vaults/' + VAULT + '/items'), 200);
    sR.close();
  });
  test('slippageBps outside 1–500 → 400', async () => {
    for (const s of [0, 501, -5, 1.5, 'x']) assert.equal((await post('/v1/vaults/' + VAULT + '/trades/quote', { side: 'buy', amount: 1, slippageBps: s })).status, 400, String(s));
    assert.equal((await post('/v1/vaults/' + VAULT + '/trades/quote', { side: 'buy', amount: 1, slippageBps: 300 })).status, 200);
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
