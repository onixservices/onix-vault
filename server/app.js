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
  const { readWallet, webDir = path.join(__dirname, '..', 'web') } = deps;
  const vaults = deps.vaults || [{
    wallet: deps.vaultWallet, meta: deps.vaultMeta || {}, service: deps.service, stats: deps.stats || null, admissions: deps.admissions || null,
    trader: deps.trader || null, itemsAge: deps.itemsAge || (() => null), signerConfigured: deps.signerConfigured || (() => false),
  }];
  const byWallet = new Map(vaults.map((v) => [v.wallet, v]));

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  const pick = (req, res, next) => { const v = byWallet.get(req.params.vault); if (!v) return next(new VaultError(404, 'unknown vault')); req.vb = v; next(); };
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const need = (x, what) => { if (!x) throw new VaultError(503, `${what} not configured for this vault`); return x; };
  const summary = async (v) => ({ vault: v.wallet, ...v.meta, rules: v.admissions ? v.admissions.rules : null, stats: v.stats ? await v.stats.read() : null });

  app.get('/v1/health', (req, res) => res.json({ ok: true, vaults: vaults.map((v) => ({ vault: v.wallet, signerConfigured: v.signerConfigured(), itemsAgeMs: v.itemsAge() })), vaultWallet: vaults[0].wallet, signerConfigured: vaults[0].signerConfigured(), itemsAgeMs: vaults[0].itemsAge() }));

  // ── what the page reads (no RPC key ever reaches the browser) ──
  app.get('/v1/vaults', wrap(async (req, res) => {
    res.json({ readAt: new Date().toISOString(), vaults: await Promise.all(vaults.map(summary)) });
  }));
  app.get('/v1/vaults/:vault/stats', pick, wrap(async (req, res) => {
    const st = need(req.vb.stats, 'stats');
    res.json({ ...(await st.read({ fresh: req.query.fresh === '1' })), ageMs: st.ageMs() });
  }));
  app.get('/v1/vaults/:vault/activity', pick, wrap(async (req, res) => {
    const doors = req.vb.service.listActivity({ limit: 50 });
    const admits = req.vb.admissions ? req.vb.admissions.list({ limit: 50 }).map((a) => ({ type: 'admit', at: a.at, mint: a.mint, from: a.owner, status: a.status, tokens: a.tokens, tokensNote: a.tokensNote, tokensAmount: a.tokensAmount, unlockAt: a.unlockAt, owedUsd: a.owedUsd, valueUsd: a.valueUsd, signature: a.signature, tokensSignature: a.tokensSignature })) : [];
    res.json({ readAt: new Date().toISOString(), activity: [...doors, ...admits].sort((x, y) => y.at - x.at).slice(0, 50) });
  }));
  app.get('/v1/wallets/:wallet/eligible-items', wrap(async (req, res) => {
    if (!readWallet) throw new VaultError(503, 'wallet reader not configured');
    res.json({ readAt: new Date().toISOString(), ...(await readWallet(req.params.wallet)) });
  }));

  // ── the Admit door ("Send a card") ──
  app.get('/v1/vaults/:vault/eligible-items', pick, wrap(async (req, res) => {
    res.json({ readAt: new Date().toISOString(), ...(await need(req.vb.admissions, 'admissions').eligible(String(req.query.wallet || ''))) });
  }));
  app.post('/v1/vaults/:vault/admissions/build', pick, wrap(async (req, res) => {
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
  app.post('/v1/vaults/:vault/trades/build', pick, wrap(async (req, res) => {
    const { owner, side, amount, slippageBps } = req.body || {};
    res.json({ readAt: new Date().toISOString(), ...(await trader(req).build({ owner, side, amount: Number(amount), slippageBps: slippageBps == null ? 100 : Number(slippageBps) })) });
  }));

  // ── items, the gacha door, redemptions ──
  app.get('/v1/vaults/:vault/items', pick, wrap(async (req, res) => {
    // read first, then measure: the age served is the age of the items served
    const items = await req.vb.service.listItems();
    res.json({ readAt: new Date().toISOString(), itemsAgeMs: req.vb.itemsAge(), items });
  }));
  app.post('/v1/vaults/:vault/reservations', pick, wrap(async (req, res) => {
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
    app.use(express.static(webDir, { index: 'index.html', extensions: ['html'], maxAge: 0 }));
    app.get(/^\/(?!v1\/).*/, (req, res) => res.sendFile(path.join(webDir, 'index.html')));
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
