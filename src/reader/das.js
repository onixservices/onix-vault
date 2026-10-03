/**
 * das.js — the only place this repository talks to the network.
 *
 * Reads assets owned by a wallet through the DAS API (getAssetsByOwner), paginated.
 * Reads a mint's supply. That is all it does. It never signs anything.
 */

async function rpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

/** Every asset the wallet owns, across all pages. Pass a wallet, not a token account. */
async function fetchAssetsByOwner(rpcUrl, owner, { pageSize = 1000 } = {}) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const r = await rpc(rpcUrl, 'getAssetsByOwner', {
      ownerAddress: owner,
      page,
      limit: pageSize,
      displayOptions: { showUnverifiedCollections: false },
    });
    const items = (r && r.items) || [];
    all.push(...items);
    if (items.length < pageSize) break;
  }
  return all;
}

/** Circulating supply of a mint, in whole tokens. */
async function fetchTokenSupply(rpcUrl, mint) {
  const r = await rpc(rpcUrl, 'getTokenSupply', [mint]);
  const ui = r && r.value && r.value.uiAmount;
  return Number.isFinite(ui) ? ui : null;
}

/** One asset by mint (DAS getAsset): null when the index does not know it. */
async function fetchAsset(rpcUrl, mint) {
  try { return await rpc(rpcUrl, 'getAsset', { id: mint }); } catch (e) { if (/not found/i.test(e.message)) return null; throw e; }
}

module.exports = { fetchAssetsByOwner, fetchTokenSupply, fetchAsset };
