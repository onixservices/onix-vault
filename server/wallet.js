/**
 * server/wallet.js — "what in this wallet could back a token": the first step of
 * creating a vault, read on the server with the same reader the vault page uses.
 * Every asset is either eligible (registered custodian + a value written into the
 * token) or listed with the reason it is not. Nothing is dropped silently.
 */
'use strict';
const { PublicKey } = require('@solana/web3.js');
const das = require('../src/reader/das');
const { parseCard } = require('../src/reader/backing');

function createWalletReader({ rpcUrl, fetchAssets = das.fetchAssetsByOwner }) {
  return async function readWalletItems(wallet) {
    try { new PublicKey(wallet); } catch { const e = new Error('not a wallet address'); e.statusCode = 400; throw e; }
    const assets = await fetchAssets(rpcUrl, wallet);
    const eligible = [], ineligible = [];
    for (const a of assets) {
      const c = parseCard(a);
      const row = { mint: c.mint, name: c.name, category: c.category, imageUrl: a.content?.links?.image || null };
      if (c.counts) eligible.push({ ...row, custodian: c.custodian, custodianValueUsd: c.insuredUsd, grade: c.grade, gradingCompany: c.gradingCompany, certNumber: c.certNumber, physicalVault: c.vault });
      else ineligible.push({ ...row, reason: c.excludedBecause });
    }
    return { wallet, total: assets.length, eligible, ineligible };
  };
}

module.exports = { createWalletReader };
