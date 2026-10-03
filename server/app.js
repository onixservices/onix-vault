/**
 * server/app.js — thin routes. Every rule lives in the services; every vault is a bundle.
 *
 *   GET  /v1/health
 *   GET  /v1/vaults                                      every vault with its stats and rules
 *   GET  /v1/vaults/:vault/stats | items | activity | admissions | redemptions
 *   GET  /v1/vaults/:vault/eligible-items?wallet=
 *   POST /v1/vaults/:vault/admissions/build | admissions
 *   POST /v1/vaults/:vault/trades/quote | trades/build
 *   GET  /v1/vaults/:vault/trades/balances?wallet=        USDC and token held by a wallet
 *   POST /v1/vaults/:vault/reservations (+ /:id/settle, GET /:id)
 *   POST /v1/vaults/:vault/redemptions
 *   GET  /v1/wallets/:wallet/eligible-items              any registered custodian, any vault
 *   GET  /v1/vaults/create/quote?wallet=                  what a wallet could open a vault on
 *   POST /v1/vaults/create/open | deposited | submit | confirm | abandon   the Create door (custody + launch)
 *   GET  /v1/vaults/create/:creationId
 *   POST /v1/vaults/create/upload                          coin image / banner (raw bytes, ≤1 MB, png/jpg/webp by magic bytes)
 *   GET  /v1/vaults/create/uploads/:id                     preview of an upload before launch
 *   GET  /token/:mint.json · /token/:mint.png · /token/:mint-banner.png   token metadata and images
 *   GET  /v1/vaults/:vault/play                            bands, prices, odds
 *   POST /v1/vaults/:vault/plays · /plays/:id/submit · GET /plays/:id · GET /plays   the Play door
 *   GET  /v1/vaults/:vault/purchases                       what the treasury bought (server/restock.js)
 *   GET  /v1/vaults/:vault/fee-claims                      the trading fees claimed into the treasury (server/feeclaim.js)
 *
 * `:vault` is a vault wallet; an unknown one is 404, so the paths never change as vaults
 * are added. `x-api-key` is optional: it identifies the integrator for limits; it never
 * unlocks anything.
 */
'use strict';
const path = require('path');
const express = require('express');
const { VaultError } = require('./vaultService');

/**
 * @param {object} deps
 * @param {Array<object>} [deps.vaults]  bundles: { wallet, meta, service, stats, admissions, trader, itemsAge, signerConfigured }
 * @param {function} deps.readWallet   (wallet) => { eligible, ineligible } across all registered custodians
 * @param {string} [deps.webDir]       static page (web/); null = API only
 * Legacy single-vault args (service, stats, admissions, trader, vaultWallet, vaultMeta, signerConfigured, itemsAge) still work.
 */
function buildApp(deps) {
  const { readWallet, creator = null, addVault = null, db = null, uploads = null, webDir = path.join(__dirname, '..', 'web') } = deps;
  const uploadLimiter = deps.uploadLimiter || null;   // (ip) => boolean allowed
  // first fences per address on the routes that cost something (the real limits live in the services)
  const limits = deps.limits || {};
  const fence = (name) => (req, res, next) => { const f = limits[name]; if (f && !f(req.ip)) return next(new VaultError(429, `too many ${name} requests from this address — try again in a while`)); next(); };
  const keyringConfigured = deps.keyringConfigured || (() => false);
  const vaults = deps.vaults || (!deps.vaultWallet ? [] : [{
    wallet: deps.vaultWallet, meta: deps.vaultMeta || {}, service: deps.service, stats: deps.stats || null, admissions: deps.admissions || null,
    trader: deps.trader || null, itemsAge: deps.itemsAge || (() => null), signerConfigured: deps.signerConfigured || (() => false),
  }]);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');   // Caddy on the same box sets X-Forwarded-For; req.ip is the client
  app.use(express.json({ limit: '64kb' }));

  // resolved per request: a vault created through the door is in `vaults` the moment it is confirmed
  const pick = (req, res, next) => { const v = vaults.find((x) => x.wallet === req.params.vault); if (!v) return next(new VaultError(404, 'unknown vault')); req.vb = v; next(); };
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const need = (x, what) => { if (!x) throw new VaultError(503, `${what} not configured for this vault`); return x; };
  const summary = async (v) => ({ vault: v.wallet, ...v.meta, rules: v.admissions ? v.admissions.rules : null, stats: v.stats ? await v.stats.read() : null });
  const swapUrl = deps.swapUrl || 'https://onix.finance';

  app.get('/v1/health', (req, res) => res.json({ ok: true, keyring: keyringConfigured(), vaults: vaults.map((v) => ({ vault: v.wallet, signerConfigured: v.signerConfigured(), itemsAgeMs: v.itemsAge() })), ...(vaults[0] ? { vaultWallet: vaults[0].wallet, signerConfigured: vaults[0].signerConfigured(), itemsAgeMs: vaults[0].itemsAge() } : {}) }));

  // ── what the page reads (no RPC key ever reaches the browser) ──
  app.get('/v1/vaults', wrap(async (req, res) => {
    res.json({ readAt: new Date().toISOString(), swapUrl, vaults: await Promise.all(vaults.map(summary)) });
  }));
  // ── the Create door: items go into a derived custody wallet; the creator is the pool's creator; Onix is the partner ──
  const needCreator = () => { if (!creator) throw new VaultError(503, 'vault creation not configured'); return creator; };
  app.get('/v1/vaults/create/quote', wrap(async (req, res) => {
    let rules = {}; if (req.query.rules) { try { rules = JSON.parse(String(req.query.rules)); } catch { throw new VaultError(400, 'rules must be JSON'); } }
    res.json({ readAt: new Date().toISOString(), ...(await needCreator().quote({ owner: String(req.query.wallet || ''), rules })) });
  }));
  app.post('/v1/vaults/create/open', fence('create'), wrap(async (req, res) => {
    const { owner, name, symbol, mints, rules, description, links, imageId, bannerId } = req.body || {};
    res.status(201).json({ readAt: new Date().toISOString(), ...(await needCreator().open({ owner, name, symbol, mints, rules, description, links, imageId, bannerId })) });
  }));
  // images: raw bytes in, typed by content; served with a fixed type and nosniff so a browser never guesses
  const sendUpload = (res, id) => {
    const p = uploads && uploads.pathOf(id);
    if (!p) return res.status(404).json({ error: 'no such image', code: 404 });
    res.setHeader('Content-Type', uploads.typeOf(id)); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(p);
  };
  app.post('/v1/vaults/create/upload', express.raw({ type: () => true, limit: '1100kb' }), wrap(async (req, res) => {
    if (!uploads) throw new VaultError(503, 'image uploads are not configured');
    if (uploadLimiter && !uploadLimiter(req.ip)) throw new VaultError(429, 'too many uploads from this address — try again in a while');
    const r = uploads.store(req.body);
    res.status(201).json({ readAt: new Date().toISOString(), ...r, url: `/v1/vaults/create/uploads/${r.uploadId}` });
  }));
  app.get('/v1/vaults/create/uploads/:id', (req, res) => sendUpload(res, req.params.id));
  app.get('/token/:mint-banner.png', (req, res, next) => { const r = db ? db.prepare('SELECT banner FROM vaults WHERE base_mint = ?').get(req.params.mint) : null; if (!r || !r.banner) return next(); sendUpload(res, r.banner); });
  app.get('/token/:mint.png', (req, res, next) => { const r = db ? db.prepare('SELECT image FROM vaults WHERE base_mint = ?').get(req.params.mint) : null; if (!r || !r.image) return next(); sendUpload(res, r.image); });
  app.post('/v1/vaults/create/deposited', wrap(async (req, res) => {
    const { creationId } = req.body || {};
    res.json({ readAt: new Date().toISOString(), ...(await needCreator().deposited({ creationId })) });
  }));
  app.post('/v1/vaults/create/submit', wrap(async (req, res) => {
    const { creationId, signedTransaction } = req.body || {};
    res.json({ readAt: new Date().toISOString(), ...(await needCreator().submit({ creationId, signedTransaction })) });
  }));
  app.post('/v1/vaults/create/confirm', wrap(async (req, res) => {
    const { creationId, signature } = req.body || {};
    const def = await needCreator().confirm({ creationId, signature });
    const already = vaults.find((x) => x.wallet === def.wallet);
    const b = already || (addVault ? addVault(def) : null);
    res.status(201).json({ readAt: new Date().toISOString(), vault: b ? await summary(b) : def });
  }));
  app.post('/v1/vaults/create/abandon', wrap(async (req, res) => {
    const { creationId, owner } = req.body || {};
    if (!owner) throw new VaultError(400, 'owner is required');
    res.json({ readAt: new Date().toISOString(), ...(await needCreator().abandon({ creationId, owner })) });
  }));
  app.get('/v1/vaults/create/:creationId', wrap(async (req, res) => {
    res.json({ readAt: new Date().toISOString(), ...(await needCreator().status({ creationId: req.params.creationId })) });
  }));
  app.get('/token/:mint.json', (req, res, next) => {
    const r = db ? db.prepare('SELECT * FROM vaults WHERE base_mint = ?').get(req.params.mint) : null;
    if (!r) return next();
    const base = `${req.protocol}://${req.get('host')}`;
    // socials the scanners read (Meteora, RugCheck, Jupiter): the creator's X and the vault page as the website
    let links = {}; try { links = r.links_json ? JSON.parse(r.links_json) : {}; } catch { links = {}; }
    const website = links.site || `${base}/#/vault/${r.id}`;
    const ext = { website, ...(links.x ? { twitter: links.x } : {}) };
    res.json({ name: r.token_name, symbol: r.token_symbol, description: r.description || `${r.name} — a vault on Onix.Vault. One token per vault; backed by items a custodian holds.`, image: `${base}/token/${r.image ? r.base_mint + '.png' : 'default.png'}`, ...(r.banner ? { banner: `${base}/token/${r.base_mint}-banner.png` } : {}), external_url: website, ...ext, extensions: ext, properties: { category: 'image', files: [{ uri: `${base}/token/${r.image ? r.base_mint + '.png' : 'default.png'}`, type: 'image/png' }] } });
  });
  app.get('/v1/vaults/:vault/stats', pick, wrap(async (req, res) => {
    const st = need(req.vb.stats, 'stats');
    res.json({ ...(await st.read({ fresh: req.query.fresh === '1' })), ageMs: st.ageMs() });
  }));
  app.get('/v1/vaults/:vault/activity', pick, wrap(async (req, res) => {
    const doors = req.vb.service.listActivity({ limit: 50 });
    const admits = req.vb.admissions ? req.vb.admissions.list({ limit: 50 }).map((a) => ({ type: 'admit', at: a.at, mint: a.mint, from: a.owner, status: a.status, valueUsd: a.valueUsd, signature: a.signature })) : [];
    const plays = req.vb.play ? req.vb.play.list({ limit: 50 }).map((p) => ({ type: 'play', at: p.at, playId: p.playId, band: p.band, currency: p.currency, price: p.price, unit: p.unit, mint: p.mint, to: p.player, status: p.status, paymentSignature: p.paymentSignature, deliverySignature: p.deliverySignature })) : [];
    const bought = req.vb.restock ? req.vb.restock.list({ limit: 50 }).map((b) => ({ type: 'bought', at: b.at, mint: b.mint, name: b.name, priceUsd: b.priceUsd, insuredUsd: b.insuredUsd, status: b.status, signature: b.signature })) : [];
    const fees = req.vb.feeclaim ? req.vb.feeclaim.list({ limit: 50 }).map((f) => ({ type: 'fees', at: f.at, treasuryUsd: f.treasuryUsd, onixUsd: f.onixUsd, curveUsd: f.curveUsd, poolUsd: f.poolUsd, status: f.status, signature: f.signature })) : [];
    res.json({ readAt: new Date().toISOString(), activity: [...doors, ...admits, ...plays, ...bought, ...fees].sort((x, y) => y.at - x.at).slice(0, 50) });
  }));
  app.get('/v1/wallets/:wallet/eligible-items', wrap(async (req, res) => {
    if (!readWallet) throw new VaultError(503, 'wallet reader not configured');
    res.json({ readAt: new Date().toISOString(), ...(await readWallet(req.params.wallet)) });
  }));

  // ── the Admit door ("Send a card") ──
  app.get('/v1/vaults/:vault/eligible-items', pick, wrap(async (req, res) => {
    res.json({ readAt: new Date().toISOString(), ...(await need(req.vb.admissions, 'admissions').eligible(String(req.query.wallet || ''))) });
  }));
  app.post('/v1/vaults/:vault/admissions/build', pick, fence('build'), wrap(async (req, res) => {
    const { owner, mint } = req.body || {};
    res.json({ readAt: new Date().toISOString(), ...(await need(req.vb.admissions, 'admissions').build({ owner, mint })) });
  }));
  app.post('/v1/vaults/:vault/admissions', pick, wrap(async (req, res) => {
    const { mint, owner, signature, valueUsd } = req.body || {};
    res.status(202).json(need(req.vb.admissions, 'admissions').record({ mint, owner, signature, valueUsd: Number(valueUsd) }));
  }));
  app.get('/v1/vaults/:vault/admissions', pick, wrap(async (req, res) => {
    const a = need(req.vb.admissions, 'admissions');
    res.json({ readAt: new Date().toISOString(), rules: a.rules, admissions: a.list() });
  }));

  // ── the Buy door: quote on the live pool; build the swap for the USER to sign (never signed here) ──
  const trader = (req) => { if (!req.vb.trader) throw new VaultError(409, 'token not launched — there is no pool to trade on yet'); return req.vb.trader; };
  app.post('/v1/vaults/:vault/trades/quote', pick, wrap(async (req, res) => {
    const { side, amount, slippageBps } = req.body || {};
    res.json({ readAt: new Date().toISOString(), ...(await trader(req).quote({ side, amount: Number(amount), slippageBps: slippageBps == null ? 100 : Number(slippageBps) })) });
  }));
  app.get('/v1/vaults/:vault/trades/balances', pick, wrap(async (req, res) => {
    res.json({ readAt: new Date().toISOString(), wallet: String(req.query.wallet || ''), ...(await trader(req).balances(String(req.query.wallet || ''))) });
  }));
  app.post('/v1/vaults/:vault/trades/build', pick, fence('build'), wrap(async (req, res) => {
    const { owner, side, amount, slippageBps } = req.body || {};
    res.json({ readAt: new Date().toISOString(), ...(await trader(req).build({ owner, side, amount: Number(amount), slippageBps: slippageBps == null ? 100 : Number(slippageBps) })) });
  }));

  // ── the Play door ──
  const playOf = (req) => need(req.vb.play, 'play');
  app.get('/v1/vaults/:vault/play', pick, wrap(async (req, res) => { const b = await playOf(req).bands(); res.json({ ...b, tokenSymbol: req.vb.meta.token ? req.vb.meta.token.symbol : null }); }));
  app.post('/v1/vaults/:vault/plays', pick, fence('play'), wrap(async (req, res) => {
    const { band, player, currency, clientSeed } = req.body || {};
    res.status(201).json({ readAt: new Date().toISOString(), ...(await playOf(req).start({ band, player, currency, clientSeed })) });
  }));
  app.post('/v1/vaults/:vault/plays/:id/submit', pick, wrap(async (req, res) => {
    res.status(202).json(playOf(req).submit({ playId: req.params.id, signature: req.body?.signature }));
  }));
  app.get('/v1/vaults/:vault/plays/:id', pick, wrap(async (req, res) => { res.json(playOf(req).get(req.params.id)); }));
  app.get('/v1/vaults/:vault/plays', pick, wrap(async (req, res) => { res.json({ readAt: new Date().toISOString(), plays: playOf(req).list() }); }));

  app.get('/v1/vaults/:vault/fee-claims', pick, wrap(async (req, res) => { res.json({ readAt: new Date().toISOString(), claims: need(req.vb.feeclaim, 'fee claims').list() }); }));
  app.get('/v1/vaults/:vault/purchases', pick, wrap(async (req, res) => { res.json({ readAt: new Date().toISOString(), purchases: need(req.vb.restock, 'restock').list() }); }));

  // ── items, the gacha door, redemptions ──
  app.get('/v1/vaults/:vault/items', pick, wrap(async (req, res) => {
    // read first, then measure: the age served is the age of the items served
    const items = await req.vb.service.listItems();
    res.json({ readAt: new Date().toISOString(), itemsAgeMs: req.vb.itemsAge(), items });
  }));
  app.post('/v1/vaults/:vault/reservations', pick, fence('build'), wrap(async (req, res) => {
    const { mint, integrator, winner } = req.body || {};
    res.status(201).json(await req.vb.service.reserve({ mint, integrator, winner, idempotencyKey: req.get('Idempotency-Key') || null }));
  }));
  app.post('/v1/vaults/:vault/reservations/:id/settle', pick, wrap(async (req, res) => {
    res.json(await req.vb.service.settle({ reservationId: req.params.id, paymentSignature: req.body?.paymentSignature }));
  }));
  app.get('/v1/vaults/:vault/reservations/:id', pick, wrap(async (req, res) => {
    res.json(req.vb.service.status({ reservationId: req.params.id }));
  }));
  app.post('/v1/vaults/:vault/redemptions', pick, wrap(async (req, res) => {
    const { mint, burnSignature, recipient } = req.body || {};
    res.status(202).json(req.vb.service.recordRedemption({ mint, burnSignature, recipient }));
  }));
  app.get('/v1/vaults/:vault/redemptions', pick, wrap(async (req, res) => {
    res.json({ redemptions: req.vb.service.listRedemptions() });
  }));

  app.all('/v1/*', (req, res) => res.status(404).json({ error: 'no such endpoint', code: 404 }));
  // the page: static, same origin, reads only /v1
  if (webDir) {
    // the page and its script are not fingerprinted: every load must revalidate (max-age=0 alone let browsers
    // keep a stale app.js for hours — 2 Oct 2026, the PO saw a one-hour-old page after three deploys)
    const noStale = (res) => { res.setHeader('Cache-Control', 'no-cache, must-revalidate'); res.setHeader('X-Content-Type-Options', 'nosniff'); };
    app.use(express.static(webDir, { index: 'index.html', extensions: ['html'], maxAge: 0, setHeaders: (res, file) => { if (/\.(html|js|css)$/.test(file)) noStale(res); else res.setHeader('Cache-Control', 'public, max-age=86400'); } }));
    app.get(/^\/(?!v1\/).*/, (req, res) => { noStale(res); res.sendFile(path.join(webDir, 'index.html')); });
  }

  // errors carry the service's status; never a bare 500 with no reason
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const code = err.statusCode || 500;
    if (code === 500) console.error('[vault]', err.stack || err);
    res.status(code).json({ error: err.message, code });
  });
  return app;
}

module.exports = { buildApp };
