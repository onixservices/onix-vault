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

const MONTH_MS = 30.4375 * 86_400_000;
const bs58enc = (bytes) => bs58.encode(bytes);

function createAdmissions({ db, chain, vaultWallet, rules, fetchAssets, buildTransfer, now = Date.now, haircut = REALISABLE_MULTIPLIER, admission = rules.admission ?? 0.8, rpcUrl = null, trader = null, signer = null, getUsdcBalance = null, onAdmitted = null }) {
  const owed = (valueUsd) => r2(valueUsd * haircut * admission);
  const self = { _trader: trader };

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
    // pre-flight: a transfer that fails simulation makes the wallet block the dApp; say why here instead
    if (chain.simulateTransaction) {
      const sim = await chain.simulateTransaction(b64);
      if (sim && sim.err) throw err(409, `this card cannot be sent right now: ${(sim.logs || []).filter((l) => /log:/.test(l)).slice(-2).join(' | ') || JSON.stringify(sim.err)}`);
    }
    return { mint, valueUsd: c.insuredUsd, realisableUsd: r2(c.insuredUsd * haircut), owedUsd: owed(c.insuredUsd), lockMonths: rules.lockMonths, transaction: b64, message: bs58.encode(tx.serializeMessage()) };
  }

  function record({ mint, owner, signature, valueUsd }) {
    if (!mint || !owner || !signature || !(valueUsd > 0)) throw err(400, 'mint, owner, signature and valueUsd are required');
    if (db.prepare('SELECT id FROM vault_admissions WHERE signature = ?').get(signature)) throw err(409, 'this admission was already recorded');
    const id = crypto.randomUUID(); const t = now();
    db.prepare(`INSERT INTO vault_admissions (id, vault, mint, owner, signature, value_usd, owed_usd, lock_months, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, vaultWallet, mint, owner, signature, valueUsd, owed(valueUsd), rules.lockMonths, t, t);
    return view(db.prepare('SELECT * FROM vault_admissions WHERE id = ?').get(id));
  }

  /** The chain is the witness: pending → admitted when the vault owns the item. */
  async function verifyPending() {
    const rows = db.prepare("SELECT * FROM vault_admissions WHERE status = 'pending' AND vault = ?").all(vaultWallet);
    let verified = 0;
    for (const r of rows) {
      let a; try { a = await chain.getAsset(r.mint); } catch { continue; }
      if (a && a.ownership && a.ownership.owner === vaultWallet && !a.burnt) {
        db.prepare("UPDATE vault_admissions SET status = 'admitted', updated_at = ? WHERE id = ? AND status = 'pending'").run(now(), r.id);
        if (onAdmitted) onAdmitted(r.mint);
        verified += 1;
      }
    }
    return { checked: rows.length, verified };
  }

  /**
   * The tokens the sender is owed: bought ON THE CURVE by the vault (never minted), with the
   * vault's own USDC, once the chain says the item is in. Build (the trader pre-flights and
   * simulates) → sign as the vault → persist the signature → broadcast. When the vault has
   * less USDC than owed, the row says so and waits; nothing is signed.
   */
  async function settleTokens() {
    const rows = db.prepare("SELECT * FROM vault_admissions WHERE status = 'admitted' AND tokens_sig IS NULL AND vault = ?").all(vaultWallet);
    let bought = 0;
    const wait = (id, note) => db.prepare('UPDATE vault_admissions SET note = ?, updated_at = ? WHERE id = ?').run(note, now(), id);
    for (const r of rows) {
      if (!self._trader || !signer || !signer.configured()) { wait(r.id, 'waiting: the vault cannot buy yet (no pool or no signer)'); continue; }
      try {
        const has = getUsdcBalance ? await getUsdcBalance() : null;
        if (has != null && has < r.owed_usd) { wait(r.id, `waiting for vault USDC: needs $${r.owed_usd.toFixed(2)} USDC and has $${has.toFixed(2)}`); continue; }
        const built = await self._trader.build({ owner: vaultWallet, side: 'buy', amount: r.owed_usd });
        const tx = Transaction.from(Buffer.from(built.transaction, 'base64'));
        signer.signTransaction(tx);
        const sig = bs58enc(tx.signatures.find((s) => s.publicKey.toBase58() === vaultWallet).signature);
        const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
        const unlockAt = now() + r.lock_months * MONTH_MS;
        db.prepare('UPDATE vault_admissions SET tokens_sig = ?, tokens_amount = ?, unlock_at = ?, note = NULL, updated_at = ? WHERE id = ? AND tokens_sig IS NULL')
          .run(sig, built.quote.amountOut, unlockAt, now(), r.id);
        try { await chain.sendRawTransaction(signedB64); }
        catch (e) { console.warn(`[vault] broadcast of admission tokens ${r.id} failed (persisted; rebroadcast possible): ${e.message}`); }
        bought += 1;
      } catch (e) {
        wait(r.id, `waiting: ${e.message}`);
      }
    }
    return { checked: rows.length, bought };
  }

  function view(r) {
    return { id: r.id, mint: r.mint, owner: r.owner, signature: r.signature, valueUsd: r.value_usd, owedUsd: r.owed_usd, lockMonths: r.lock_months,
      status: r.status, tokens: r.tokens_sig ? 'locked' : (r.note ? 'waiting' : 'pending'), tokensNote: r.note || null, tokensSignature: r.tokens_sig || null, tokensAmount: r.tokens_amount ?? null,
      unlockAt: r.unlock_at ?? null, at: r.created_at, updatedAt: r.updated_at };
  }
  function list({ limit = 100 } = {}) {
    return db.prepare('SELECT * FROM vault_admissions WHERE vault = ? ORDER BY created_at DESC LIMIT ?').all(vaultWallet, limit).map(view);
  }

  return Object.assign(self, { eligible, build, record, verifyPending, settleTokens, list, rules });
}

module.exports = { VAULT_RULES, itemPassesRules, createAdmissions };
