/**
 * server/admissions.js — the Admit door ("Send a card"), and the rules that gate it.
 *
 * A vault is a RULE, not a wallet that accepts anything: a registered custodian (or
 * several), a category, a minimum value. Only what passes can be built; the user signs
 * the transfer; the admission is recorded, verified on chain (the vault now owns it),
 * and carries what the sender is owed: tokens worth 80% of realisable value, bought on
 * the curve when the vault has USDC, locked 12 months. Nobody mints anything.
 *
 * Stray transfers (anything sent outside this flow) never count and are returned by
 * the operator. The on-chain program (roadmap) makes the rule a failing transaction.
 */
'use strict';
const crypto = require('crypto');
const { PublicKey, Transaction } = require('@solana/web3.js');
const { parseCard, REALISABLE_MULTIPLIER } = require('../src/reader/backing');
const { checkSingleSignerUnsigned } = require('./txAssertions');

function err(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }
const bs58 = (() => { const b = require('bs58'); return b.encode ? b : b.default; })();

/** The registry of vault rules. One vault today; a second one is a second entry, never new code. */
const VAULT_RULES = Object.freeze({
  vault1: Object.freeze({ custodians: ['Collector Crypt'], category: 'graded-cards', minValueUsd: 0, lockMonths: 12, admission: 0.80 }),
});

/** Does this asset pass this vault's rules? Says why not. */
function itemPassesRules(asset, rules) {
  const c = parseCard(asset);
  if (!c.custodian) return { ok: false, reason: 'unknown custodian' };
  if (!rules.custodians.includes(c.custodian)) return { ok: false, reason: `custodian not accepted by this vault: ${c.custodian}` };
  if (c.insuredUsd == null) return { ok: false, reason: 'no insured value' };
  if (rules.minValueUsd && c.insuredUsd < rules.minValueUsd) return { ok: false, reason: `below the vault's minimum value ($${rules.minValueUsd})` };
  return { ok: true, reason: null };
}

const r2 = (n) => Math.round(n * 100) / 100;

function createAdmissions({ db, chain, vaultWallet, rules, fetchAssets, buildTransfer, now = Date.now, haircut = REALISABLE_MULTIPLIER, admission = rules.admission ?? 0.8, rpcUrl = null }) {
  const owed = (valueUsd) => r2(valueUsd * haircut * admission);

  async function eligible(owner) {
    try { new PublicKey(owner); } catch { throw err(400, 'not a wallet address'); }
    const assets = await fetchAssets(rpcUrl, owner);
    const out = { wallet: owner, total: assets.length, eligible: [], ineligible: [], rules };
    for (const a of assets) {
      const c = parseCard(a); const v = itemPassesRules(a, rules);
      const row = { mint: c.mint, name: c.name, category: c.category, imageUrl: a.content?.links?.image || null };
      if (v.ok) out.eligible.push({ ...row, custodian: c.custodian, custodianValueUsd: c.insuredUsd, grade: c.grade, gradingCompany: c.gradingCompany, certNumber: c.certNumber, physicalVault: c.vault, realisableUsd: r2(c.insuredUsd * haircut), owedUsd: owed(c.insuredUsd) });
      else out.ineligible.push({ ...row, reason: v.reason });
    }
    return out;
  }

  async function build({ owner, mint }) {
    try { new PublicKey(owner); } catch { throw err(400, 'not a wallet address'); }
    if (!mint) throw err(400, 'mint is required');
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
    return { mint, valueUsd: c.insuredUsd, realisableUsd: r2(c.insuredUsd * haircut), owedUsd: owed(c.insuredUsd), lockMonths: rules.lockMonths, transaction: b64, message: bs58.encode(tx.serializeMessage()) };
  }

  function record({ mint, owner, signature, valueUsd }) {
    if (!mint || !owner || !signature || !(valueUsd > 0)) throw err(400, 'mint, owner, signature and valueUsd are required');
    if (db.prepare('SELECT id FROM vault_admissions WHERE signature = ?').get(signature)) throw err(409, 'this admission was already recorded');
    const id = crypto.randomUUID(); const t = now();
    db.prepare(`INSERT INTO vault_admissions (id, mint, owner, signature, value_usd, owed_usd, lock_months, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, mint, owner, signature, valueUsd, owed(valueUsd), rules.lockMonths, t, t);
    return view(db.prepare('SELECT * FROM vault_admissions WHERE id = ?').get(id));
  }

  /** The chain is the witness: pending → admitted when the vault owns the item. */
  async function verifyPending() {
    const rows = db.prepare("SELECT * FROM vault_admissions WHERE status = 'pending'").all();
    let verified = 0;
    for (const r of rows) {
      let a; try { a = await chain.getAsset(r.mint); } catch { continue; }
      if (a && a.ownership && a.ownership.owner === vaultWallet && !a.burnt) {
        db.prepare("UPDATE vault_admissions SET status = 'admitted', updated_at = ? WHERE id = ? AND status = 'pending'").run(now(), r.id);
        verified += 1;
      }
    }
    return { checked: rows.length, verified };
  }

  function view(r) {
    return { id: r.id, mint: r.mint, owner: r.owner, signature: r.signature, valueUsd: r.value_usd, owedUsd: r.owed_usd, lockMonths: r.lock_months,
      status: r.status, tokens: r.tokens_sig ? 'locked' : 'pending', tokensSignature: r.tokens_sig || null, tokensAmount: r.tokens_amount ?? null, at: r.created_at, updatedAt: r.updated_at };
  }
  function list({ limit = 100 } = {}) {
    return db.prepare('SELECT * FROM vault_admissions ORDER BY created_at DESC LIMIT ?').all(limit).map(view);
  }

  return { eligible, build, record, verifyPending, list, rules };
}

module.exports = { VAULT_RULES, itemPassesRules, createAdmissions };
