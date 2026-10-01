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
const express = require('express');
const { VaultError } = require('./vaultService');

function buildApp({ service, vaultWallet, signerConfigured = () => false, itemsAge = () => null }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  const onlyThisVault = (req, res, next) => (req.params.vault === vaultWallet ? next() : next(new VaultError(404, 'unknown vault')));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  app.get('/v1/health', (req, res) => res.json({ ok: true, vaultWallet, signerConfigured: signerConfigured(), itemsAgeMs: itemsAge() }));

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
