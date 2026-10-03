/**
 * server/restock.js — the treasury buys the next item.
 *
 * USDC lands in a vault's custody wallet from the migration fee and from USDC plays. This turns it back
 * into items, under the vault's own published rules, with the vault's own key — the same loop the page
 * promises ("the money stays and buys the next item"). Ported in spirit from Onix.Cards' stock agent
 * (Aug 2026): decision pure and separate from I/O; one purchase per run; the transaction is asserted,
 * simulated, signed, PERSISTED, then broadcast; the chain is read back before anything is counted.
 *
 *   plan()          what the treasury would buy now, and why not if nothing (no I/O past the reads)
 *   execute({ go }) buy the pick: dry by default; with go, sign with the custody key and broadcast
 *   confirm()       purchases sent → finalized → the chain shows the item in custody → added to the manifest
 *
 * The buy rule is the creator's rules + a price ceiling: price ≤ maxPriceToIndex × insured value
 * (1.0 by default — "cheap is below the custodian's index", the PO's rule for the Cards agent).
 * The venue: Collector Crypt's public marketplace API (listings + an unsigned buy transaction for any
 * wallet). A sponsored variant for wallets without SOL comes with a second, pre-signed signer; the
 * single-signer assertion refuses it by construction.
 */
'use strict';
const crypto = require('crypto');
const { Transaction } = require('@solana/web3.js');
const { checkSingleSignerUnsigned } = require('./txAssertions');
const { categoryOf, gradeOf } = require('./rules');

function err(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }
const r2 = (n) => Math.round(n * 100) / 100;

const RESTOCK = Object.freeze({
  maxPriceToIndex: 1.0,      // never above the custodian's index
  maxBuyUsd: 150,            // per item
  reserveUsd: 1,             // what stays in the treasury (dust, fees)
  minBuyUsd: 5,              // below this the venue refuses anyway
  pages: 3,                  // listing pages scanned, cheapest first
  minIntervalMs: 60 * 60_000,// one purchase an hour per vault at most
  pendingTtlMs: 30 * 60_000, // a sent purchase that never lands is marked failed after this
  minSol: 0.05,              // below this the venue hands a sponsored, two-signer transaction (measured ~0.02–0.09 SOL, Jul 2026)
});

/** A CC marketplace row → the shape the rules read. Exported for the tests and the script. */
function listingView(raw) {
  const ins = raw.insuredValue == null || raw.insuredValue === '' ? null : Number(raw.insuredValue);
  return {
    mint: raw.nftAddress, name: raw.itemName || null, category: raw.category || null, grade: raw.grade || null,
    gradingCompany: raw.gradingCompany || null, custodian: 'Collector Crypt',
    marketplace: String((raw.listing && raw.listing.marketplace) || 'CC').toUpperCase(),
    priceUsd: raw.listing ? Number(raw.listing.price) : null,
    insuredUsd: Number.isFinite(ins) ? ins : null,
    imageUrl: (raw.images && (raw.images.frontM || raw.images.front)) || raw.frontImage || null,
    seller: raw.owner && raw.owner.wallet ? raw.owner.wallet : null,
  };
}

/** The creator's rules, applied to a listing (same checks as an admission, minus the on-chain read). */
function listingPassesRules(l, rules) {
  if (!rules.custodians.includes(l.custodian)) return { ok: false, reason: 'custodian not accepted' };
  if (l.insuredUsd == null) return { ok: false, reason: 'no insured value' };
  // graded cards only: the cheap end of a marketplace is fillers (pre-orders, mystery packs, sealed) — measured on the
  // Cards agent (Jul 2026: 27% of the cheap band); a vault of graded cards never buys them, whatever the ratio
  if (!l.grade || !l.gradingCompany || gradeOf(l) == null) return { ok: false, reason: 'not a graded card' };
  if (/pre-?order|mystery|sealed|booster|pack|box|bundle|lot/i.test(l.name || '')) return { ok: false, reason: 'not a single graded card (filler)' };
  if (rules.minValueUsd && l.insuredUsd < rules.minValueUsd) return { ok: false, reason: `below the vault's minimum value ($${rules.minValueUsd})` };
  if (rules.category && rules.category !== 'mixed' && categoryOf(l) !== rules.category) return { ok: false, reason: `not ${rules.category}` };
  if (rules.minGrade && rules.minGrade !== 'any') { const g = gradeOf(l); if (g == null || g < rules.minGrade) return { ok: false, reason: `below the vault's minimum grade (${rules.minGrade})` }; }
  return { ok: true, reason: null };
}

/**
 * PURE: what to buy, given the budget, the rules and the listings. The cheapest price-to-index that fits.
 * @returns {{ pick: object|null, why: string, considered: number, rejected: Record<string, number> }}
 */
function decide({ budgetUsd, rules, listings, exclude = new Set(), limits = RESTOCK }) {
  const rejected = {};
  const bump = (k) => { rejected[k] = (rejected[k] || 0) + 1; };
  const fits = [];
  for (const l of listings) {
    if (!l.mint || !(l.priceUsd > 0)) { bump('no price'); continue; }
    if (l.marketplace !== 'CC') { bump('not on the custodian\'s own market'); continue; }
    if (exclude.has(l.mint)) { bump('already in custody or pending'); continue; }
    const r = listingPassesRules(l, rules);
    if (!r.ok) { bump(r.reason); continue; }
    if (l.priceUsd > limits.maxPriceToIndex * l.insuredUsd) { bump(`above ${limits.maxPriceToIndex}× the index`); continue; }
    if (l.priceUsd > limits.maxBuyUsd) { bump(`above the per-item cap ($${limits.maxBuyUsd})`); continue; }
    if (l.priceUsd < limits.minBuyUsd) { bump(`below the venue minimum ($${limits.minBuyUsd})`); continue; }
    if (l.priceUsd > budgetUsd) { bump('above the budget'); continue; }
    fits.push({ ...l, ratio: r2(l.priceUsd / l.insuredUsd) });
  }
  fits.sort((a, b) => a.ratio - b.ratio || a.priceUsd - b.priceUsd);
  const pick = fits[0] || null;
  const why = pick ? `cheapest fit: ${pick.ratio}× the index, $${pick.priceUsd} of a $${r2(budgetUsd)} budget` : budgetUsd < limits.minBuyUsd ? `treasury below the minimum buy ($${r2(budgetUsd)} < $${limits.minBuyUsd})` : `nothing on the market fits (${listings.length} listings looked at)`;
  return { pick, why, considered: listings.length, rejected };
}

/**
 * @param {object} deps
 * @param {function} deps.fetchListings   async ({ page, categories? }) => raw CC rows (filterNFtCard)
 * @param {function} deps.buildBuyTx      async ({ mint, wallet, priceUsd }) => base64 unsigned tx from the venue
 * @param {function} deps.getUsdcBalance  async (wallet) => number (ui)
 * @param {function} deps.ownerOf         async (mint) => owner wallet (DAS) or null
 */
function createRestock({ db, chain, vaultWallet, signer, rules, readItems, fetchListings, buildBuyTx, getUsdcBalance, getSolBalance = null, ownerOf, now = Date.now, limits = RESTOCK, log = console }) {
  const categoriesParam = rules.category && rules.category !== 'mixed' ? { pokemon: 'Pokemon', 'one-piece': 'One Piece', sports: 'Sports' }[rules.category] : undefined;

  async function market() {
    const out = [];
    for (let page = 1; page <= limits.pages; page++) {
      const raw = await fetchListings({ page, orderBy: 'listedPriceAsc', categories: categoriesParam });
      const rows = Array.isArray(raw) ? raw : (raw && raw.filterNFtCard) || [];
      for (const r of rows) { try { out.push(listingView(r)); } catch { /* a row we cannot read is a row we do not buy */ } }
      if (!rows.length) break;
    }
    return out;
  }

  async function plan() {
    const t = now();
    const last = db.prepare("SELECT MAX(created_at) t FROM vault_purchases WHERE vault = ? AND status IN ('sent','landed')").get(vaultWallet).t || 0;
    const treasuryUsd = await getUsdcBalance(vaultWallet);
    const budgetUsd = Math.max(0, r2(treasuryUsd - limits.reserveUsd));
    const sol = getSolBalance ? await getSolBalance(vaultWallet) : null;
    if (sol != null && sol < limits.minSol) return { treasuryUsd, budgetUsd, sol, pick: null, why: `custody has ${sol.toFixed(4)} SOL; the venue needs ≥ ${limits.minSol} SOL in the buyer's wallet (below that it hands a sponsored two-signer transaction we refuse)`, considered: 0, rejected: {} };
    const inCustody = new Set((await readItems()).map((it) => it.mint));
    for (const r of db.prepare("SELECT mint FROM vault_purchases WHERE vault = ? AND status = 'sent'").all(vaultWallet)) inCustody.add(r.mint);
    if (t - last < limits.minIntervalMs) return { treasuryUsd, budgetUsd, pick: null, why: `last purchase ${Math.round((t - last) / 60000)} min ago; one an hour`, considered: 0, rejected: {} };
    if (budgetUsd < limits.minBuyUsd) return { treasuryUsd, budgetUsd, pick: null, why: `treasury below the minimum buy ($${budgetUsd} < $${limits.minBuyUsd})`, considered: 0, rejected: {} };
    const listings = await market();
    return { treasuryUsd, budgetUsd, ...decide({ budgetUsd, rules, listings, exclude: inCustody, limits }) };
  }

  async function execute({ go = false } = {}) {
    const p = await plan();
    if (!p.pick) return { ...p, bought: null };
    const pick = p.pick;
    if (!signer.configured()) throw err(503, 'custody signer not configured');
    if (signer.publicKey() !== vaultWallet) throw err(503, 'signer is not the custody wallet');
    const b64 = await buildBuyTx({ mint: pick.mint, wallet: vaultWallet, priceUsd: pick.priceUsd });
    const tx = Transaction.from(Buffer.from(b64, 'base64'));
    const fail = checkSingleSignerUnsigned(tx, vaultWallet);
    if (fail) throw err(409, `the venue's buy transaction does not pass assertions: ${fail.assertion} (${fail.message})`);
    const sim = await chain.simulateTransaction(b64);
    if (sim && sim.err) throw err(409, `the buy would fail on chain: ${JSON.stringify(sim.err)} · ${(sim.logs || []).filter((l) => /log:/.test(l)).slice(-2).join(' | ')}`);
    if (!go) return { ...p, bought: null, dry: true, simulated: true };
    signer.signTransaction(tx);
    const bs58 = require('bs58'); const encode = bs58.encode || bs58.default.encode;
    const sig = encode(tx.signatures.find((s) => s.publicKey.toBase58() === vaultWallet).signature);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    const id = crypto.randomUUID(), t = now();
    // persist BEFORE broadcasting: a crash between the two never buys twice (a rebroadcast is the same signature)
    db.prepare(`INSERT INTO vault_purchases (id, vault, mint, name, price_usd, insured_usd, venue, seller, tx_b64, sig, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'cc', ?, ?, ?, 'sent', ?, ?)`).run(id, vaultWallet, pick.mint, pick.name, pick.priceUsd, pick.insuredUsd, pick.seller, signedB64, sig, t, t);
    try { await chain.sendRawTransaction(signedB64); }
    catch (e) { log.warn(`[restock ${vaultWallet.slice(0, 6)}] broadcast failed (persisted; rebroadcast on confirm): ${e.message}`); }
    return { ...p, bought: { id, mint: pick.mint, name: pick.name, priceUsd: pick.priceUsd, insuredUsd: pick.insuredUsd, signature: sig } };
  }

  /** Sent purchases: finalized and the chain shows the item in custody → the manifest; failed or lost → failed. */
  async function confirm() {
    const out = { landed: 0, failed: 0, pending: 0 }; const t = now();
    for (const r of db.prepare("SELECT * FROM vault_purchases WHERE vault = ? AND status = 'sent'").all(vaultWallet)) {
      let st = null;
      try { [st] = await chain.getSignatureStatuses([r.sig]); } catch { out.pending += 1; continue; }
      if (!st) {
        if (t - r.created_at > limits.pendingTtlMs) { db.prepare("UPDATE vault_purchases SET status = 'failed', fail_reason = 'never landed', updated_at = ? WHERE id = ?").run(t, r.id); out.failed += 1; }
        else { try { await chain.sendRawTransaction(r.tx_b64); } catch { /* same signature; nothing lost */ } out.pending += 1; }
        continue;
      }
      if (st.err) { db.prepare("UPDATE vault_purchases SET status = 'failed', fail_reason = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(st.err).slice(0, 200), t, r.id); out.failed += 1; continue; }
      if (st.confirmationStatus !== 'finalized') { out.pending += 1; continue; }
      const owner = await ownerOf(r.mint).catch(() => null);
      if (owner !== vaultWallet) { out.pending += 1; continue; }   // finalized but the index is behind; next tick
      db.prepare('INSERT OR IGNORE INTO vault_items (vault, mint, source, added_at) VALUES (?, ?, ?, ?)').run(vaultWallet, r.mint, 'restock', t);
      db.prepare("UPDATE vault_purchases SET status = 'landed', landed_at = ?, updated_at = ? WHERE id = ?").run(t, t, r.id);
      out.landed += 1;
    }
    return out;
  }

  function list({ limit = 50 } = {}) {
    return db.prepare('SELECT * FROM vault_purchases WHERE vault = ? ORDER BY created_at DESC LIMIT ?').all(vaultWallet, limit)
      .map((r) => ({ id: r.id, mint: r.mint, name: r.name, priceUsd: r.price_usd, insuredUsd: r.insured_usd, venue: r.venue, status: r.status, signature: r.sig, failReason: r.fail_reason, at: r.created_at, landedAt: r.landed_at }));
  }

  return { plan, execute, confirm, list, RESTOCK: limits };
}

/** Production venue deps: Collector Crypt's public marketplace API. */
function productionRestockDeps({ ccApiBase = 'https://api.collectorcrypt.com', rpcUrl, chain, fetchImpl = fetch }) {
  const das = require('../src/reader/das');
  return {
    fetchListings: async ({ page = 1, orderBy = 'listedPriceAsc', categories } = {}) => {
      const q = new URLSearchParams({ page: String(page), orderBy }); if (categories) q.set('categories', categories);
      const r = await fetchImpl(`${ccApiBase}/marketplace?${q}`, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`CC marketplace ${r.status}`);
      return r.json();
    },
    buildBuyTx: async ({ mint, wallet, priceUsd }) => {
      const r = await fetchImpl(`${ccApiBase}/marketplace/buy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nftAddress: mint, wallet, price: priceUsd, currency: 'USDC' }) });
      if (!r.ok) throw new Error(`CC buy ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return (await r.text()).trim().replace(/^"|"$/g, '');
    },
    getSolBalance: async (wallet) => (await chain.getBalanceLamports(wallet)) / 1e9,
    getUsdcBalance: async (wallet) => {
      const r = await chain.rpc('getTokenAccountsByOwner', [wallet, { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, { encoding: 'jsonParsed' }]);
      return (r.value || []).reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
    },
    ownerOf: async (mint) => { const a = await das.fetchAsset(rpcUrl, mint); return a && a.ownership ? a.ownership.owner : null; },
  };
}

module.exports = { createRestock, decide, listingView, listingPassesRules, productionRestockDeps, RESTOCK };
