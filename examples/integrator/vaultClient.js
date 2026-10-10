/**
 * examples/integrator/vaultClient.js — a complete client of the Onix.Vault API, in
 * plain Node (no dependencies beyond fetch). This is the SAME client Onix.Cards'
 * gacha uses in production; there is no privileged path.
 *
 *   const vault = createVaultClient({ baseUrl: 'https://vault.onix.finance', vault: '<vault wallet>', apiKey?: '...' });
 *   const items = await vault.items();
 *   const r = await vault.reserve({ mint, integrator: myWallet, winner: playerWallet, idempotencyKey });
 *   // sign r.paymentTransaction with `integrator`, send it, keep the signature
 *   const settled = await vault.settle(r.reservationId, paymentSignature);   // retry on 409 (not finalized), 429 and 503 (paused): none is a failure
 *
 *   // an integrator of EVERY vault: discover them, keep the graduated ones (only those sell)
 *   const vaults = await listVaults({ baseUrl: 'https://vault.onix.finance' });   // [{ vault, id, name, graduated, … }]
 */
'use strict';

class VaultApiError extends Error {
  constructor(statusCode, message, body) { super(message); this.name = 'VaultApiError'; this.statusCode = statusCode; this.body = body; }
}

function createVaultClient({ baseUrl, vault, apiKey = null, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  if (!baseUrl || !vault) throw new Error('vaultClient: baseUrl and vault are required');
  const root = `${baseUrl.replace(/\/$/, '')}/v1/vaults/${vault}`;

  async function call(method, path, { body, headers = {} } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(root + path, {
        method, signal: ctl.signal,
        headers: { 'content-type': 'application/json', ...(apiKey && { 'x-api-key': apiKey }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new VaultApiError(res.status, json.error || `HTTP ${res.status}`, json);
      return json;
    } finally { clearTimeout(t); }
  }

  return {
    items: async () => (await call('GET', '/items')).items,
    reserve: ({ mint, integrator, winner, idempotencyKey = null }) =>
      call('POST', '/reservations', { body: { mint, integrator, winner }, headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {} }),
    settle: (reservationId, paymentSignature) => call('POST', `/reservations/${reservationId}/settle`, { body: { paymentSignature } }),
    status: (reservationId) => call('GET', `/reservations/${reservationId}`),
  };
}

/** Every vault the server serves, with whether it sells yet (graduated). No address to configure. */
async function listVaults({ baseUrl, apiKey = null, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/vaults`, { signal: ctl.signal, headers: apiKey ? { 'x-api-key': apiKey } : {} });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new VaultApiError(res.status, json.error || `HTTP ${res.status}`, json);
    return (json.vaults || []).map((v) => ({ vault: v.vault, id: v.id, name: v.name, symbol: v.token ? v.token.symbol : null, graduated: Boolean(v.stats && v.stats.poolStatus === 'migrated') }));
  } finally { clearTimeout(t); }
}

module.exports = { createVaultClient, listVaults, VaultApiError };
