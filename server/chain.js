/**
 * server/chain.js — the RPC calls the server makes. Thin, and all read-only except
 * `sendRawTransaction`, which only ever sends a transaction this server built,
 * asserted, simulated and signed.
 */
'use strict';
const C = require('./config');

async function rpc(method, params, rpcUrl = C.RPC_URL) {
  if (!rpcUrl) throw new Error('RPC_URL not configured');
  const res = await fetch(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) { const e = new Error(`RPC ${method}: ${json.error.message || JSON.stringify(json.error)}`); e.rpcError = json.error; throw e; }
  return json.result;
}

module.exports = {
  getParsedTransaction: (sig) => rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]),
  getSignatureStatuses: async (sigs) => (await rpc('getSignatureStatuses', [sigs, { searchTransactionHistory: true }])).value,
  getLatestBlockhash: async () => (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash,
  sendRawTransaction: (b64) => rpc('sendTransaction', [b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]),
  /** Deliverability check BEFORE signing: `sigVerify:false` so an unsigned tx simulates; the blockhash is replaced. */
  simulateTransaction: async (b64) => (await rpc('simulateTransaction', [b64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }])).value,
  getAsset: (id) => rpc('getAsset', { id }),
  getAccountInfoBase64: async (pubkey) => (await rpc('getAccountInfo', [pubkey, { encoding: 'base64' }])).value,
  getTokenSupplyUi: async (mint) => (await rpc('getTokenSupply', [mint])).value.uiAmount,
  /** Poll until a signature is confirmed (or fails / times out). Used only for transactions this server sent. */
  waitForSignature: async (sig, { timeoutMs = 60_000, everyMs = 1500 } = {}) => {
    const t0 = Date.now();
    for (;;) {
      const [st] = (await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }])).value;
      if (st && st.err) throw new Error(`transaction ${sig} failed on chain: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return st;
      if (Date.now() - t0 > timeoutMs) throw new Error(`transaction ${sig} not confirmed after ${timeoutMs / 1000}s`);
      await new Promise((r) => setTimeout(r, everyMs));
    }
  },
  rpc,
};
