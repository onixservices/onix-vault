/**
 * server/app.js — thin routes. Every rule lives in vaultService.js.
 *
 *   GET  /v1/health
 *   GET  /v1/vaults/:vault/items
 *   POST /v1/vaults/:vault/reservations                 (Idempotency-Key honoured)
 *   POST /v1/vaults/:vault/reservations/:id/settle
 *   GET  /v1/vaults/:vault/reservations/:id
 *   POST /v1/vaults/:vault/redemptions                  (v1: recorded; operator verifies)
 *   GET  /v1/vaults/:vault/redemptions
 *
 * `:vault` is the vault wallet. v1 serves one vault; a different `:vault` is 404,
 * so the paths will not change when the second vault exists.
 * `x-api-key` is optional: it identifies the integrator for limits; it never unlocks anything.
 */
'use strict';
const path = require('path');
const express = require('express');
const { VaultError } = require('./vaultService');

/**
 * @param {object} deps
 * @param {object} deps.service      vaultService
 * @param {object} deps.stats        { read(), ageMs() } — backing + pool, read server-side
 * @param {function} deps.readWallet (wallet) => { eligible, ineligible }
 * @param {object} deps.vaultMeta    { name, operator, custodians } — what the board shows next to the numbers
 * @param {object} [deps.trader]     { quote(), build() } — the Buy door (quotes + unsigned swaps for the user's wallet)
 * @param {string} [deps.webDir]     static page (web/); null = API only
 */
function buildApp({ service, stats, readWallet, trader = null, vaultWallet, vaultMeta = {}, signerConfigured = () => false, itemsAge = () => null, webDir = path.join(__dirname, '..', 'web') }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  const onlyThisVault = (req, res, next) => (req.params.vault === vaultWallet ? next() : next(new VaultError(404, 'unknown vault')));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  app.get('/v1/health', (req, res) => res.json({ ok: true, vaultWallet, signerConfigured: signerConfigured(), itemsAgeMs: itemsAge() }));

  // ── what the page reads (no RPC key ever reaches the browser) ──
  app.get('/v1/vaults', wrap(async (req, res) => {
    const st = stats ? await stats.read() : null;
    res.json({ readAt: new Date().toISOString(), vaults: [{ vault: vaultWallet, ...vaultMeta, stats: st }] });
  }));
  app.get('/v1/vaults/:vault/stats', onlyThisVault, wrap(async (req, res) => {
    if (!stats) throw new VaultError(503, 'stats not configured');
    res.json({ ...(await stats.read()), ageMs: stats.ageMs() });
  }));
  app.get('/v1/vaults/:vault/activity', onlyThisVault, wrap(async (req, res) => {
    res.json({ readAt: new Date().toISOString(), activity: service.listActivity({ limit: 50 }) });
  }));
  app.get('/v1/wallets/:wallet/eligible-items', wrap(async (req, res) => {
    if (!readWallet) throw new VaultError(503, 'wallet reader not configured');
    res.json({ readAt: new Date().toISOString(), ...(await readWallet(req.params.wallet)) });
  }));

  // ── the Buy door: quote on the live pool; build the swap for the USER to sign (never signed here) ──
  app.post('/v1/vaults/:vault/trades/quote', onlyThisVault, wrap(async (req, res) => {
    if (!trader) throw new VaultError(409, 'token not launched — there is no pool to trade on yet');
    const { side, amount, slippageBps } = req.body || {};
    res.json({ readAt: new Date().toISOString(), ...(await trader.quote({ side, amount: Number(amount), slippageBps: slippageBps == null ? 100 : Number(slippageBps) })) });
  }));
  app.post('/v1/vaults/:vault/trades/build', onlyThisVault, wrap(async (req, res) => {
    if (!trader) throw new VaultError(409, 'token not launched — there is no pool to trade on yet');
    const { owner, side, amount, slippageBps } = req.body || {};
    res.json({ readAt: new Date().toISOString(), ...(await trader.build({ owner, side, amount: Number(amount), slippageBps: slippageBps == null ? 100 : Number(slippageBps) })) });
  }));

  app.get('/v1/vaults/:vault/items', onlyThisVault, wrap(async (req, res) => {
    // read first, then measure: the age served is the age of the items served (an
    // object literal evaluates left to right — `itemsAge()` before the await reported
    // the previous snapshot's age for freshly read items; caught on the first public call)
    const items = await service.listItems();
    res.json({ readAt: new Date().toISOString(), itemsAgeMs: itemsAge(), items });
  }));

  app.post('/v1/vaults/:vault/reservations', onlyThisVault, wrap(async (req, res) => {
    const { mint, integrator, winner } = req.body || {};
    const out = await service.reserve({ mint, integrator, winner, idempotencyKey: req.get('Idempotency-Key') || null });
    res.status(201).json(out);
  }));

  app.post('/v1/vaults/:vault/reservations/:id/settle', onlyThisVault, wrap(async (req, res) => {
    res.json(await service.settle({ reservationId: req.params.id, paymentSignature: req.body?.paymentSignature }));
  }));

  app.get('/v1/vaults/:vault/reservations/:id', onlyThisVault, wrap(async (req, res) => {
    res.json(service.status({ reservationId: req.params.id }));
  }));

  app.post('/v1/vaults/:vault/redemptions', onlyThisVault, wrap(async (req, res) => {
    const { mint, burnSignature, recipient } = req.body || {};
    res.status(202).json(service.recordRedemption({ mint, burnSignature, recipient }));
  }));

  app.get('/v1/vaults/:vault/redemptions', onlyThisVault, wrap(async (req, res) => {
    res.json({ redemptions: service.listRedemptions() });
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
