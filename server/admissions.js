/**
 * server/admissions.js — the creator's "Send a card": only the vault's CREATOR adds items,
 * and only items that pass the vault's rules. The creator signs a transfer into the custody
 * wallet; the admission is recorded, verified on chain (the custody wallet now owns it), and
 * the item joins the vault's manifest. No tokens change hands: the creator is paid by the
 * 50% allocation, the on-chain creator fee and the plays — not per item.
 *
 * Anyone else who wants in creates their own vault. Stray transfers (anything sent outside
 * this flow) never count and are returned by the operator.
 */
'use strict';
const crypto = require('crypto');
const { PublicKey, Transaction } = require('@solana/web3.js');
const { parseCard, REALISABLE_MULTIPLIER } = require('../src/reader/backing');
const { checkSingleSignerUnsigned } = require('./txAssertions');
const { itemPassesRules, DEFAULT_RULES } = require('./rules');
const { isAddress, isSignatureText, shownImageUrl } = require('./inputs');
const { firstSigner } = require('./payment');
// an admission that never lands (or was never real) leaves the public Activity after this
const PENDING_TTL_MS = 60 * 60_000;

function err(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }
const bs58 = (() => { const b = require('bs58'); return b.encode ? b : b.default; })();
const r2 = (n) => Math.round(n * 100) / 100;

/** Named rule sets for file-registry vaults. */
const VAULT_RULES = Object.freeze({ vault1: DEFAULT_RULES });

/**
 * @param {string} vaultWallet  the custody wallet (where items live)
 * @param {string|null} creator the only wallet allowed to add items; null = nobody (list only)
 */
function createAdmissions({ db, chain, vaultWallet, creator = null, rules, fetchAssets, buildTransfer, now = Date.now, haircut = REALISABLE_MULTIPLIER, rpcUrl = null, onAdmitted = null }) {
  function isCreator(owner) { return Boolean(creator) && owner === creator; }

  /** What a wallet holds that this vault would take (anyone may look; only the creator may send). */
  async function eligible(owner) {
    try { new PublicKey(owner); } catch { throw err(400, 'not a wallet address'); }
    const assets = await fetchAssets(rpcUrl, owner);
    const out = { wallet: owner, canSend: isCreator(owner), total: assets.length, eligible: [], ineligible: [], rules };
    for (const a of assets) {
      const c = parseCard(a); const v = itemPassesRules(a, rules);
      const row = { mint: c.mint, name: c.name, category: c.category, custodian: c.custodian, imageUrl: shownImageUrl(c, a) };
      if (v.ok) out.eligible.push({ ...row, custodianValueUsd: c.insuredUsd, grade: c.grade, gradingCompany: c.gradingCompany, certNumber: c.certNumber, physicalVault: c.vault, realisableUsd: r2(c.insuredUsd * haircut) });
      else out.ineligible.push({ ...row, reason: v.reason });
    }
    return out;
  }

  async function build({ owner, mint }) {
    try { new PublicKey(owner); } catch { throw err(400, 'not a wallet address'); }
    if (!mint) throw err(400, 'mint is required');
    if (!isCreator(owner)) throw err(403, 'only the creator of this vault can add items — open your own vault instead');
    const assets = await fetchAssets(rpcUrl, owner);
    const a = assets.find((x) => x.id === mint);
    if (!a) throw err(404, 'that item is not in this wallet');
    const v = itemPassesRules(a, rules);
    if (!v.ok) throw err(422, `cannot go into this vault: ${v.reason}`);
    const c = parseCard(a);
    const b64 = await buildTransfer({ mint, fromAddress: owner, toAddress: vaultWallet, recentBlockhash: await chain.getLatestBlockhash() });
    const tx = Transaction.from(Buffer.from(b64, 'base64'));
    const fail = checkSingleSignerUnsigned(tx, owner);
    if (fail) throw new Error(`admission tx does not pass assertions: ${fail.assertion}`);
    // pre-flight: a transfer that fails simulation makes the wallet block the dApp; say why here instead
    if (chain.simulateTransaction) {
      const sim = await chain.simulateTransaction(b64);
      if (sim && sim.err) throw err(409, `this card cannot be sent right now: ${(sim.logs || []).filter((l) => /log:/.test(l)).slice(-2).join(' | ') || JSON.stringify(sim.err)}`);
    }
    return { mint, valueUsd: c.insuredUsd, realisableUsd: r2(c.insuredUsd * haircut), transaction: b64, message: bs58.encode(tx.serializeMessage()) };
  }

  function record({ mint, owner, signature, valueUsd }) {
    if (!mint || !owner || !signature || !(valueUsd > 0)) throw err(400, 'mint, owner, signature and valueUsd are required');
    if (!isAddress(mint) || !isAddress(owner) || !isSignatureText(signature)) throw err(400, 'mint and owner must be addresses, signature a transaction signature');
    if (!isCreator(owner)) throw err(403, 'only the creator of this vault can add items');
    if (db.prepare('SELECT id FROM vault_admissions WHERE signature = ?').get(signature)) throw err(409, 'this admission was already recorded');
    const id = crypto.randomUUID(); const t = now();
    db.prepare(`INSERT INTO vault_admissions (id, vault, mint, owner, signature, value_usd, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, vaultWallet, mint, owner, signature, valueUsd, t, t);
    return view(db.prepare('SELECT * FROM vault_admissions WHERE id = ?').get(id));
  }

  /**
   * The chain is the witness: pending → admitted when the custody wallet owns the item AND the transfer named in the
   * record is the creator's own, landed without error; the value shown is then the custodian's, read from the item.
   * A transfer someone else signed → rejected; nothing after an hour → expired (it leaves the public Activity).
   */
  async function verifyPending() {
    const rows = db.prepare("SELECT * FROM vault_admissions WHERE status = 'pending' AND vault = ?").all(vaultWallet);
    let verified = 0;
    const set = (r, status, valueUsd = r.value_usd) => db.prepare('UPDATE vault_admissions SET status = ?, value_usd = ?, updated_at = ? WHERE id = ? AND status = \'pending\'').run(status, valueUsd, now(), r.id);
    for (const r of rows) {
      let a = null, tx = null;
      try { a = await chain.getAsset(r.mint); } catch { continue; }
      if (a && a.ownership && a.ownership.owner === vaultWallet && !a.burnt) {
        try { tx = await chain.getParsedTransaction(r.signature); } catch { continue; }
        if (tx && (tx.meta?.err || firstSigner(tx) !== r.owner)) { set(r, 'rejected'); continue; }
        if (tx) {
          const c = parseCard(a);
          set(r, 'admitted', Number.isFinite(c.insuredUsd) ? c.insuredUsd : r.value_usd);
          if (onAdmitted) onAdmitted(r.mint);
          verified += 1;
          continue;
        }
      }
      if (now() - r.created_at > PENDING_TTL_MS) set(r, 'expired');
    }
    return { checked: rows.length, verified };
  }

  function view(r) {
    // the value is shown once the chain confirmed it (admitted); what a client sent is never displayed
    return { id: r.id, mint: r.mint, owner: r.owner, signature: r.signature, valueUsd: r.status === 'admitted' ? r.value_usd : null, status: r.status, at: r.created_at, updatedAt: r.updated_at };
  }
  function list({ limit = 100 } = {}) {
    return db.prepare("SELECT * FROM vault_admissions WHERE vault = ? AND status IN ('pending','admitted') ORDER BY created_at DESC LIMIT ?").all(vaultWallet, limit).map(view);
  }

  return { eligible, build, record, verifyPending, list, rules, creator };
}

module.exports = { VAULT_RULES, itemPassesRules, createAdmissions };
