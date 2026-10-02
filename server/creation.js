/**
 * server/creation.js — the Create door: anyone with eligible items in their wallet opens
 * a vault on them. The items never move: the creator's wallet IS the vault.
 *
 *   quote({ owner })                 what the wallet holds that counts, and the curve it implies
 *   build({ owner, name, symbol, mints })  create the curve config (Onix is the partner: it pays for
 *                                    and signs the config, and claims the trading fee), then the
 *                                    ONE transaction the creator signs: createPool, UNSIGNED (a
 *                                    pre-signature makes Phantom refuse it), simulated before it leaves
 *   submit({ creationId, signedTransaction })  the creator's signed tx: same message we built →
 *                                    the mint key adds its signature → broadcast
 *   confirm({ creationId })          the chain says the pool exists → the vault is registered
 *
 * Supply split (src/curve/params.js, decided 2 Oct 2026): 50% to the creator in the DBC's
 * lockedVesting (released at graduation, linear over 6 months), 50% on the curve. The curve
 * opens at 2× realisable backing, so the creator's half is worth the items on day one, and
 * graduates at gradMult × the opening cap. Only the creator adds items; there is no reserve.
 */
'use strict';
const crypto = require('crypto');
const { PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { parseCard, REALISABLE_MULTIPLIER } = require('../src/reader/backing');
const { paramsFor, DECIDED } = require('../src/curve/params');
const { itemPassesRules, VAULT_RULES } = require('./admissions');

function err(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }
const bs58 = (() => { const b = require('bs58'); return b.encode ? b : b.default; })();
const r2 = (n) => Math.round(n * 100) / 100;

const LIMITS = Object.freeze({ nameMax: 32, symbolMax: 10, minItems: 1, minBackingUsd: 5 });

/** The curve for a backing — the decided shape (src/curve/params.js) with the creator's two choices. */
function curveParamsFor(backingUsd, { gradMult, creatorFeePct } = {}) {
  return paramsFor({ backingUsd, ...(gradMult ? { gradMult } : {}), ...(creatorFeePct ? { creatorFeePct } : {}) });
}

/**
 * A pool-creation transaction has two signers: the creator (signs in the wallet) and the new
 * mint (throwaway key, signs here AFTER the creator). What leaves for the wallet carries no
 * signature at all — Phantom refuses a transaction with a foreign pre-signature. The options
 * say what each slot must look like at each stage.
 */
function checkCreatorPlusMint(tx, creator, mint, { creatorSigned = false, mintSigned = false } = {}) {
  const sigs = tx.signatures.map((s) => ({ key: s.publicKey.toBase58(), signed: s.signature !== null }));
  if (sigs.length !== 2) return { assertion: 'two-signers', message: `${sigs.length} signers (expected creator + mint)` };
  const c = sigs.find((s) => s.key === creator), m = sigs.find((s) => s.key === mint);
  if (!c || !m) return { assertion: 'signer-mismatch', message: `signers=${sigs.map((s) => s.key).join(',')}` };
  if (c.signed !== creatorSigned) return { assertion: creatorSigned ? 'creator-unsigned' : 'pre-signed', message: creatorSigned ? 'the creator did not sign' : 'the creator slot already carries a signature' };
  if (m.signed !== mintSigned) return { assertion: mintSigned ? 'mint-unsigned' : 'mint-pre-signed', message: 'mint slot' };
  if (tx.feePayer?.toBase58() !== creator) return { assertion: 'fee-payer', message: `feePayer=${tx.feePayer} expected=${creator}` };
  return null;
}

/**
 * Programs a wallet is allowed to ADD around our instruction when it hands the signed tx back.
 * Measured on 2 Oct 2026: Phantom prepends two ComputeBudget instructions (priority fee) and
 * appends a Lighthouse assertion (its own guard). Neither can change what our instruction does.
 */
const WALLET_WRAPPER_PROGRAMS = new Set(['ComputeBudget111111111111111111111111111111', 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95']);

/** The content of a transaction — fee payer + OUR instructions — independent of account-table order and of wallet wrappers. */
function instructionsOf(tx) {
  return JSON.stringify({ feePayer: tx.feePayer?.toBase58(), ixs: tx.instructions.filter((ix) => !WALLET_WRAPPER_PROGRAMS.has(ix.programId.toBase58())).map((ix) => ({ p: ix.programId.toBase58(), k: ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), d: Buffer.from(ix.data).toString('base64') })) });
}

function createVaultCreator({ db, chain, sdk, getClient, partner, quoteMint, fetchAssets, rpcUrl = null, metadataBase, rules = VAULT_RULES.vault1, haircut = REALISABLE_MULTIPLIER, now = Date.now, existingSymbols = () => [] }) {
  const pending = new Map(); // creationId → { owner, name, symbol, config, baseMintKp, pool, at }

  async function backingOf(owner) {
    const assets = await fetchAssets(rpcUrl, owner);
    const items = [];
    for (const a of assets) { const v = itemPassesRules(a, rules); if (v.ok) { const c = parseCard(a); items.push({ mint: c.mint, name: c.name, custodianValueUsd: c.insuredUsd, imageUrl: a.content?.links?.image || null }); } }
    const indexUsd = items.reduce((s, it) => s + it.custodianValueUsd, 0);
    return { items, indexUsd, realisableUsd: r2(indexUsd * haircut) };
  }

  function checkInputs({ owner, name, symbol, mints }) {
    if (!Array.isArray(mints) || !mints.length || !mints.every((m) => typeof m === 'string')) throw err(400, 'mints: pick at least one item');
    try { new PublicKey(owner); } catch { throw err(400, 'owner must be a wallet address'); }
    if (typeof name !== 'string' || !name.trim() || name.trim().length > LIMITS.nameMax) throw err(400, `name: 1–${LIMITS.nameMax} characters`);
    if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,10}$/.test(symbol)) throw err(400, `symbol: 2–${LIMITS.symbolMax} characters, A–Z and digits`);
    if (existingSymbols().map((s) => s.toUpperCase()).includes(symbol)) throw err(409, `the symbol ${symbol} is taken`);
    return { owner, name: name.trim(), symbol, mints: [...new Set(mints)] };
  }

  async function quote({ owner }) {
    try { new PublicKey(owner); } catch { throw err(400, 'owner must be a wallet address'); }
    const b = await backingOf(owner);
    const can = b.items.length >= LIMITS.minItems && b.realisableUsd >= LIMITS.minBackingUsd;
    // an empty wallet still gets a quote (nothing to open on); the curve preview needs a positive backing
    const { view } = curveParamsFor(Math.max(b.realisableUsd, LIMITS.minBackingUsd));
    return { wallet: owner, ...b, canCreate: can, why: can ? null : `needs at least ${LIMITS.minItems} eligible item worth $${LIMITS.minBackingUsd}+`, curve: view, creatorTokensWorthUsd: r2(view.openingMcapUsd * view.creatorPct / 100) };
  }

  async function build(input) {
    const { owner, name, symbol, mints } = checkInputs(input);
    const all = await backingOf(owner);
    const missing = mints.filter((m) => !all.items.some((it) => it.mint === m));
    if (missing.length) throw err(422, `not eligible or not in this wallet: ${missing.map((m) => m.slice(0, 6) + '…').join(', ')}`);
    const picked = all.items.filter((it) => mints.includes(it.mint));
    const b = { items: picked, indexUsd: picked.reduce((s, it) => s + it.custodianValueUsd, 0) };
    b.realisableUsd = r2(b.indexUsd * haircut);
    if (b.items.length < LIMITS.minItems || b.realisableUsd < LIMITS.minBackingUsd) throw err(422, `nothing to open a vault on: needs at least ${LIMITS.minItems} eligible item worth $${LIMITS.minBackingUsd}+`);
    const { params, view } = curveParamsFor(b.realisableUsd);
    const curve = sdk.buildCurveWithMarketCap(params);
    const client = await getClient();
    const partnerPk = new PublicKey(partner.publicKey()), quotePk = new PublicKey(quoteMint), ownerPk = new PublicKey(owner);

    // 1. the config — Onix's side: it pays, it signs, it is the fee claimer. Inert until a pool uses it.
    const configKp = Keypair.generate();
    const ctx = await client.partner.createConfig({ ...curve, config: configKp.publicKey, feeClaimer: partnerPk, leftoverReceiver: partnerPk, quoteMint: quotePk, payer: partnerPk });
    ctx.feePayer = partnerPk; ctx.recentBlockhash = await chain.getLatestBlockhash();
    ctx.partialSign(configKp); partner.signTransaction(ctx);
    const configSig = await chain.sendRawTransaction(ctx.serialize().toString('base64'));
    await chain.waitForSignature(configSig);

    // 2. the pool — the creator's transaction: creator pays and creates, the mint key pre-signs
    const baseMintKp = Keypair.generate();
    const id = crypto.randomUUID();
    const uri = `${metadataBase}/token/${baseMintKp.publicKey.toBase58()}.json`;
    const ptx = await client.creator.createPool({ name, symbol, uri, payer: ownerPk, poolCreator: ownerPk, config: configKp.publicKey, baseMint: baseMintKp.publicKey });
    ptx.feePayer = ownerPk; ptx.recentBlockhash = await chain.getLatestBlockhash();
    const bytes = ptx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const compiled = Transaction.from(bytes);
    const fail = checkCreatorPlusMint(compiled, owner, baseMintKp.publicKey.toBase58());
    if (fail) throw new Error(`createPool tx does not pass assertions: ${fail.assertion} (${fail.message})`);
    const sim = await chain.simulateTransaction(bytes.toString('base64'));
    if (sim && sim.err) throw err(409, `the launch would fail on chain: ${JSON.stringify(sim.err)} · ${(sim.logs || []).filter((l) => /log:/.test(l)).slice(-2).join(' | ')}`);
    const pool = sdk.deriveDbcPoolAddress(quotePk, baseMintKp.publicKey, configKp.publicKey).toBase58();
    pending.set(id, { owner, name, symbol, mints, config: configKp.publicKey.toBase58(), baseMint: baseMintKp.publicKey.toBase58(), baseMintKp, content: instructionsOf(compiled), pool, graduationUsd: view.graduationUsd, items: b.items.length, backingUsd: b.realisableUsd, at: now() });
    return { creationId: id, pool, baseMint: baseMintKp.publicKey.toBase58(), config: configKp.publicKey.toBase58(), configSignature: configSig, curve: view, backing: { items: b.items.length, indexUsd: b.indexUsd, realisableUsd: b.realisableUsd }, transaction: bytes.toString('base64'), message: bs58.encode(compiled.serializeMessage()) };
  }

  /**
   * The creator signed in the wallet; the server completes with the mint key and broadcasts.
   * Only the exact message built in `build` is completed — anything else is refused.
   */
  async function submit({ creationId, signedTransaction }) {
    const p = pending.get(creationId);
    if (!p) throw err(404, 'unknown or expired creation — build again');
    let tx; try { tx = Transaction.from(Buffer.from(String(signedTransaction || ''), 'base64')); } catch { throw err(400, 'signedTransaction must be a base64 transaction'); }
    // the wallet's library may re-order the account table when it hands the signed tx back; what must match is the content
    if (instructionsOf(tx) !== p.content) { console.warn('[create] signed tx differs from the built one · built:', p.content, '· got:', instructionsOf(tx)); throw err(409, 'the signed transaction is not the one that was built'); }
    const fail = checkCreatorPlusMint(tx, p.owner, p.baseMint, { creatorSigned: true, mintSigned: false });
    if (fail) throw err(409, `signed transaction does not pass assertions: ${fail.assertion} (${fail.message})`);
    tx.partialSign(p.baseMintKp);
    if (!tx.verifySignatures()) throw err(409, 'the creator signature does not verify');
    const sig = await chain.sendRawTransaction(tx.serialize().toString('base64'));
    p.launchSig = sig;
    return { creationId, signature: sig, pool: p.pool, baseMint: p.baseMint };
  }

  /** The chain is the witness: the pool account exists → the vault is registered. */
  async function confirm({ creationId, signature = null }) {
    const p = pending.get(creationId);
    if (!p) throw err(404, 'unknown or expired creation — build again');
    const acct = await chain.getAccountInfoBase64(p.pool);
    if (!acct) throw err(409, 'the pool is not on chain yet — try again in a few seconds');
    const t = now();
    const vaultId = p.symbol.toLowerCase();
    db.prepare(`INSERT INTO vaults (id, name, operator, wallet, pool, base_mint, config, graduation_usd, token_name, token_symbol, rules, created_by, created_at, launch_sig)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'vault1', ?, ?, ?)`)
      .run(vaultId, p.name, p.owner.slice(0, 4) + '…' + p.owner.slice(-4), p.owner, p.pool, p.baseMint, p.config, p.graduationUsd, p.name, p.symbol, p.owner, t, signature || p.launchSig || null);
    const ins = db.prepare('INSERT OR IGNORE INTO vault_items (vault, mint, source, added_at) VALUES (?, ?, ?, ?)');
    for (const m of p.mints) ins.run(p.owner, m, 'creation', t);
    pending.delete(creationId);
    return rowToDef(db.prepare('SELECT * FROM vaults WHERE id = ?').get(vaultId), db);
  }

  return { quote, build, submit, confirm, DECIDED, LIMITS, _pending: pending };
}

/** A DB row → a registry entry (the same shape vaults.json uses). `manifest` reads the declared items live. */
function rowToDef(r, db = null) {
  const manifest = db ? () => db.prepare('SELECT mint FROM vault_items WHERE vault = ?').all(r.wallet).map((x) => x.mint) : null;
  return { id: r.id, manifest, name: r.name, operator: r.operator, description: `${r.token_name} · created by ${r.operator}`, wallet: r.wallet, secretEnv: null,
    pool: r.pool, baseMint: r.base_mint, graduationUsd: r.graduation_usd, creatorPct: DECIDED.creatorPct, openingMcapUsd: Math.round(r.graduation_usd / (r.grad_mult || DECIDED.gradMultDefault) * 100) / 100, token: { name: r.token_name, symbol: r.token_symbol, image: '/token/default.png' }, rules: r.rules, createdBy: r.created_by, createdAt: r.created_at };
}

module.exports = { createVaultCreator, curveParamsFor, checkCreatorPlusMint, instructionsOf, rowToDef, DECIDED, LIMITS, WALLET_WRAPPER_PROGRAMS };
