/**
 * server/chain.js — the RPC calls the server makes. Thin, and all read-only except
 * `sendRawTransaction`, which only ever sends a transaction this server built,
 * asserted and signed.
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
  getAsset: (id) => rpc('getAsset', { id }),
  getAccountInfoBase64: async (pubkey) => (await rpc('getAccountInfo', [pubkey, { encoding: 'base64' }])).value,
  rpc,
};
