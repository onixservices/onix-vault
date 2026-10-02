/**
 * server/creation.js — the Create door: anyone with eligible items in their wallet opens
 * a vault on them. The items never move: the creator's wallet IS the vault.
 *
 *   quote({ owner })                 what the wallet holds that counts, and the curve it implies
 *   build({ owner, name, symbol })   create the curve config (Onix is the partner: it pays for
 *                                    and signs the config, and claims the trading fee), then the
 *                                    ONE transaction the creator signs: createPool, pre-signed by
 *                                    the throwaway mint key, simulated before it leaves
 *   confirm({ creationId })          the chain says the pool exists → the vault is registered
 *
 * Supply split (see docs/curve-config.md): the creator's allocation and the admission reserve
 * sit in the DBC's lockedVesting (released to the creator at graduation); the rest is the
 * curve. The curve opens at OPEN_MULT × realisable backing, so the creator's share is worth
 * the items on day one, and graduates at GRAD_MULT × the opening cap.
 */
'use strict';
const crypto = require('crypto');
const { PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { parseCard, REALISABLE_MULTIPLIER } = require('../src/reader/backing');
const { buildParams, PENDING } = require('../src/curve/params');
const { itemPassesRules, VAULT_RULES } = require('./admissions');

function err(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }
const bs58 = (() => { const b = require('bs58'); return b.encode ? b : b.default; })();
const r2 = (n) => Math.round(n * 100) / 100;

/** The split every created vault gets. Changing it is a product decision, not a request field. */
const SPLIT = Object.freeze({ creatorPct: 50, reservePct: 10, openMult: 2, gradMult: 2.5, supply: 10_000_000 });
const LIMITS = Object.freeze({ nameMax: 32, symbolMax: 10, minItems: 1, minBackingUsd: 5 });

/** The curve params for a backing. Pure; the SDK validates the result. */
function curveParamsFor(backingUsd, split = SPLIT) {
  const open = r2(backingUsd * split.openMult), grad = r2(open * split.gradMult);
  const locked = Math.round(split.supply * (split.creatorPct + split.reservePct) / 100);
  return {
    params: buildParams({ ...PENDING, initialMarketCapUsd: open, migrationMarketCapUsd: grad, totalTokenSupply: split.supply,
      lockedVesting: { totalLockedVestingAmount: locked, numberOfVestingPeriod: 1, cliffUnlockAmount: 0, totalVestingDuration: 1, cliffDurationFromMigrationTime: 0 } }),
    view: { openingMcapUsd: open, graduationUsd: grad, supply: split.supply, creatorPct: split.creatorPct, reservePct: split.reservePct, curvePct: 100 - split.creatorPct - split.reservePct },
  };
}

/**
 * A pool-creation transaction has two signers: the creator (unsigned, signs in the wallet)
 * and the new mint (signed here, throwaway). Nothing else, and the creator pays.
 */
function checkCreatorPlusMint(tx, creator, mint) {
  const sigs = tx.signatures.map((s) => ({ key: s.publicKey.toBase58(), signed: s.signature !== null }));
  if (sigs.length !== 2) return { assertion: 'two-signers', message: `${sigs.length} signers (expected creator + mint)` };
  const c = sigs.find((s) => s.key === creator), m = sigs.find((s) => s.key === mint);
  if (!c || !m) return { assertion: 'signer-mismatch', message: `signers=${sigs.map((s) => s.key).join(',')}` };
  if (c.signed) return { assertion: 'pre-signed', message: 'the creator slot already carries a signature' };
  if (!m.signed) return { assertion: 'mint-unsigned', message: 'the mint key did not sign' };
  if (tx.feePayer?.toBase58() !== creator) return { assertion: 'fee-payer', message: `feePayer=${tx.feePayer} expected=${creator}` };
  return null;
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

  function checkInputs({ owner, name, symbol }) {
    try { new PublicKey(owner); } catch { throw err(400, 'owner must be a wallet address'); }
    if (typeof name !== 'string' || !name.trim() || name.trim().length > LIMITS.nameMax) throw err(400, `name: 1–${LIMITS.nameMax} characters`);
    if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,10}$/.test(symbol)) throw err(400, `symbol: 2–${LIMITS.symbolMax} characters, A–Z and digits`);
    if (existingSymbols().map((s) => s.toUpperCase()).includes(symbol)) throw err(409, `the symbol ${symbol} is taken`);
    return { owner, name: name.trim(), symbol };
  }

  async function quote({ owner }) {
    try { new PublicKey(owner); } catch { throw err(400, 'owner must be a wallet address'); }
    const b = await backingOf(owner);
    const can = b.items.length >= LIMITS.minItems && b.realisableUsd >= LIMITS.minBackingUsd;
    const { view } = curveParamsFor(b.realisableUsd);
    return { wallet: owner, ...b, canCreate: can, why: can ? null : `needs at least ${LIMITS.minItems} eligible item worth $${LIMITS.minBackingUsd}+`, curve: view, creatorTokensWorthUsd: r2(view.openingMcapUsd * view.creatorPct / 100) };
  }

  async function build(input) {
    const { owner, name, symbol } = checkInputs(input);
    const b = await backingOf(owner);
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
    ptx.partialSign(baseMintKp);
    const bytes = ptx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const compiled = Transaction.from(bytes);
    const fail = checkCreatorPlusMint(compiled, owner, baseMintKp.publicKey.toBase58());
    if (fail) throw new Error(`createPool tx does not pass assertions: ${fail.assertion} (${fail.message})`);
    const sim = await chain.simulateTransaction(bytes.toString('base64'));
    if (sim && sim.err) throw err(409, `the launch would fail on chain: ${JSON.stringify(sim.err)} · ${(sim.logs || []).filter((l) => /log:/.test(l)).slice(-2).join(' | ')}`);
    const pool = sdk.deriveDbcPoolAddress(quotePk, baseMintKp.publicKey, configKp.publicKey).toBase58();
    pending.set(id, { owner, name, symbol, config: configKp.publicKey.toBase58(), baseMint: baseMintKp.publicKey.toBase58(), pool, graduationUsd: view.graduationUsd, items: b.items.length, backingUsd: b.realisableUsd, at: now() });
    return { creationId: id, pool, baseMint: baseMintKp.publicKey.toBase58(), config: configKp.publicKey.toBase58(), configSignature: configSig, curve: view, backing: { items: b.items.length, indexUsd: b.indexUsd, realisableUsd: b.realisableUsd }, transaction: bytes.toString('base64'), message: bs58.encode(compiled.serializeMessage()) };
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
      .run(vaultId, p.name, p.owner.slice(0, 4) + '…' + p.owner.slice(-4), p.owner, p.pool, p.baseMint, p.config, p.graduationUsd, p.name, p.symbol, p.owner, t, signature);
    pending.delete(creationId);
    return rowToDef(db.prepare('SELECT * FROM vaults WHERE id = ?').get(vaultId));
  }

  return { quote, build, confirm, SPLIT, LIMITS, _pending: pending };
}

/** A DB row → a registry entry (the same shape vaults.json uses). */
function rowToDef(r) {
  return { id: r.id, name: r.name, operator: r.operator, description: `${r.token_name} · created by ${r.operator}`, wallet: r.wallet, secretEnv: null,
    pool: r.pool, baseMint: r.base_mint, graduationUsd: r.graduation_usd, token: { name: r.token_name, symbol: r.token_symbol, image: '/token/default.png' }, rules: r.rules, createdBy: r.created_by, createdAt: r.created_at };
}

module.exports = { createVaultCreator, curveParamsFor, checkCreatorPlusMint, rowToDef, SPLIT, LIMITS };
