/**
 * server/items.js — what is in the vault, from the CHAIN, through the same reader the
 * proof page uses (`src/reader`). Cached for a few seconds; the age is returned.
 * A market reference per mint is optional (a JSON url → { [mint]: usd }); without it
 * the exit price is the custodian's value, and the API says so.
 */
'use strict';
const { safeImageUrl } = require('./inputs');
const das = require('../src/reader/das');
const { parseCard } = require('../src/reader/backing');

function createItemsReader({ rpcUrl, vaultWallet, marketRefUrl = null, cacheMs = 30_000, now = Date.now, fetchImpl = fetch, fetchAssets = das.fetchAssetsByOwner, manifest = null } = {}) {
  let cache = { at: 0, items: null };

  async function marketRefs() {
    if (!marketRefUrl) return {};
    try { const res = await fetchImpl(marketRefUrl); return res.ok ? await res.json() : {}; } catch { return {}; }
  }

  async function readItems() {
    if (cache.items && now() - cache.at < cacheMs) return cache.items;
    if (!rpcUrl || !vaultWallet) throw new Error('items: RPC_URL / VAULT_WALLET not configured');
    const [all, refs] = await Promise.all([fetchAssets(rpcUrl, vaultWallet), marketRefs()]);
    // a declared vault (its creator's wallet) counts only what was declared; the operator's vaults count the wallet
    const declared = manifest ? new Set(manifest()) : null;
    const assets = declared ? all.filter((a) => declared.has(a.id)) : all;
    const items = assets.map((a) => ({ c: parseCard(a), img: a.content?.links?.image || a.content?.files?.[0]?.uri || null }))
      .filter(({ c }) => c.counts).map(({ c, img }) => ({
      mint: c.mint, custodian: c.custodian, name: c.name, category: c.category,
      imageUrl: safeImageUrl(img),
      custodianValueUsd: c.insuredUsd, custodianValueBasis: 'insured',
      marketRefUsd: Number.isFinite(refs[c.mint]) ? refs[c.mint] : null,
      grade: c.grade, gradingCompany: c.gradingCompany, certNumber: c.certNumber, physicalVault: c.vault,
    }));
    cache = { at: now(), items };
    return items;
  }
  readItems.ageMs = () => (cache.items ? now() - cache.at : null);
  return readItems;
}

module.exports = { createItemsReader };
