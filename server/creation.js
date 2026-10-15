/**
 * server/creation.js — the Create door: anyone with eligible items opens a vault on them.
 * The items go into a CUSTODY wallet derived for this vault (server/keyring.js), so every
 * door works for every vault; the creator keeps the token economics (50% allocation, the
 * on-chain creator fee) through their own wallet, which is the pool's creator.
 *
 * Four steps, two kinds of signature from the creator, nothing pre-signed by us:
 *   quote({ owner, rules })          what the wallet holds that this vault would take, and the curve it implies
 *   open({ owner, name, symbol, mints, rules, … })
 *                                    allocates the custody wallet and returns the DEPOSIT transactions
 *                                    (items → custody, + gas), each single-signer = creator, unsigned
 *   deposited({ creationId })        the chain says custody holds the items → Onix creates the curve
 *                                    config (pays its rent; the custody wallet is the fee claimer) →
 *                                    returns the ONE launch transaction (createPool), unsigned, simulated
 *   submit({ creationId, signedTransaction })  the creator signed it: same content we built → the
 *                                    throwaway mint key completes it → broadcast
 *   confirm({ creationId })          the pool exists → the vault is registered and served
 *   abandon({ creationId, owner })   before launch: custody returns the items to the creator
 *
 * Once a launch is submitted the items belong to the token: abandon, the sweep and a second launch are refused
 * while the pool is on chain or the launch can still land. Only a launch the chain rejected, or one whose
 * blockhash can no longer land, frees them (launchState, read from the chain each time).
 *
 * Supply split (src/curve/params.js): 50% creator in lockedVesting (released at
 * graduation, linear 6 months), 50% curve. Opens at 2× realisable backing. Only the creator adds items.
 */
'use strict';
const crypto = require('crypto');
const { PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, ComputeBudgetProgram } = require('@solana/web3.js');
const { parseCard, REALISABLE_MULTIPLIER } = require('../src/reader/backing');
const { paramsFor, DECIDED } = require('../src/curve/params');
const { validateRules, itemPassesRules } = require('./rules');
const { checkSingleSignerUnsigned } = require('./txAssertions');
const { shownImageUrl } = require('./inputs');

function err(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }

/** A refused deposit, in words: the program's own log when there is one; otherwise which instruction and what it was. Never raw JSON. */
function explainDepositFailure(sim, tx) {
  const logs = (sim.logs || []).filter((l) => /log:/.test(l)).slice(-2);
  if (logs.length) return `a deposit would fail on chain: ${logs.join(' | ')}`;
  const ie = sim.err && sim.err.InstructionError;
  if (Array.isArray(ie)) {
    const [i, detail] = ie; const ix = tx.instructions[i];
    const code = detail && typeof detail === 'object' ? Object.entries(detail).map(([k, v]) => `${k} ${v}`).join(' ') : String(detail);
    if (ix && ix.programId.equals(SystemProgram.programId)) return `the chain refused the gas transfer in a deposit (${code}): the wallet cannot cover the SOL it sends the vault. Top it up and try again.`;
    return `the chain refused a deposit at instruction ${i + 1} (${code}). Nothing was sent; try again in a moment.`;
  }
  return `the chain refused a deposit (${typeof sim.err === 'string' ? sim.err : 'simulation error'}). Nothing was sent; try again in a moment.`;
}
const bs58 = (() => { const b = require('bs58'); return b.encode ? b : b.default; })();
const r2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIMITS = Object.freeze({
  nameMax: 32, symbolMax: 10, descriptionMax: 200, minItems: 1, minBackingUsd: 5,
  // what the creator sends the custody wallet for its future transactions (deliveries, fee claims, the treasury's purchases).
  // Collector Crypt hands a buyer with less than ~0.05 SOL a sponsored, two-signer purchase the treasury refuses (RESTOCK.minSol),
  // and graduation, a delivery and the fee claims spend ~0.003 SOL from custody (measured: 0.047 left after graduating) — so the
  // gas sits well above that minimum, or a vault born with exactly 0.05 would never buy its first item.
  gasSol: 0.08,
  // what the creator's wallet must hold to launch: the gas above, the deposit transactions and the launch (≈0.03). Checked
  // before any deposit is built, so a wallet that cannot pay hears it in words, with the numbers, not as a simulation error.
  minOwnerSol: 0.12,
  txMaxBytes: 1232,
  creationTtlMs: 2 * 60 * 60 * 1000,
  // a launch transaction's blockhash lives ~60–90 s; past this, a launch with no pool on chain can no longer land
  launchExpiryMs: 5 * 60_000,
  // the compute-unit price on the transactions Onix signs (the config): ~0.00002 SOL for 200k CU, so a congested chain
  // does not drop them (15 Oct 2026: a config sent without it expired unconfirmed and a creator's launch stopped)
  priorityMicroLamports: 100_000,
  maxOpenPerHour: 10,           // global: every launch costs Onix the config rent
  // symbols nobody may take: money, the chain, the big names a buyer could be fooled by
  reservedSymbols: Object.freeze(['USDC', 'USDT', 'SOL', 'WSOL', 'JUP', 'MET', 'BONK', 'VEONIX', 'ONIX', 'CARDS', 'BTC', 'ETH']),
});

/** The curve for a backing — the decided shape with the creator's two choices. */
function curveParamsFor(backingUsd, { gradMult, creatorFeePct } = {}) {
  return paramsFor({ backingUsd, ...(gradMult ? { gradMult } : {}), ...(creatorFeePct ? { creatorFeePct } : {}) });
}

/**
 * A pool-creation transaction has two signers: the creator (signs in the wallet) and the new
 * mint (throwaway key, signs here AFTER the creator). What leaves for the wallet carries no
 * signature at all — Phantom refuses a transaction with a foreign pre-signature.
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

function createVaultCreator({ db, chain, sdk, getClient, partner, keyring, quoteMint, fetchAssets, buildTransfer, rpcUrl = null, metadataBase, haircut = REALISABLE_MULTIPLIER, now = Date.now, existingSymbols = () => [], reservedIndexes = () => [], gasSol = LIMITS.gasSol, limits = LIMITS, retryMs = 2000, uploads = null }) {
  const pending = new Map(); // creationId → { baseMintKp, baseMint, pool, content } (the mint key lives only here, only until submit)
  // one step at a time per creation: two `deposited` at once would pay the config twice; abandon during a submit would race it
  const busy = new Set();
  async function exclusive(creationId, fn) {
    if (busy.has(creationId)) throw err(409, 'another step of this creation is running — try again in a moment');
    busy.add(creationId);
    try { return await fn(); } finally { busy.delete(creationId); }
  }

  // ── reading ──
  async function itemsOf(owner, rules) {
    const assets = await fetchAssets(rpcUrl, owner);
    const items = [], ineligible = [];
    for (const a of assets) {
      const v = itemPassesRules(a, rules); const c = parseCard(a);
      const row = { mint: c.mint, name: c.name, category: c.category, grade: c.grade, custodian: c.custodian, imageUrl: shownImageUrl(c, a) };
      if (v.ok) items.push({ ...row, custodianValueUsd: c.insuredUsd }); else ineligible.push({ ...row, reason: v.reason });
    }
    const indexUsd = items.reduce((s, it) => s + it.custodianValueUsd, 0);
    return { items, ineligible, indexUsd, realisableUsd: r2(indexUsd * haircut), total: assets.length };
  }
  const backingOfMints = (items, mints) => { const picked = items.filter((it) => mints.includes(it.mint)); const indexUsd = picked.reduce((s, it) => s + it.custodianValueUsd, 0); return { items: picked, indexUsd, realisableUsd: r2(indexUsd * haircut) }; };

  // an upload id is accepted only if that file is here (uploads are content-addressed; see server/uploads.js)
  function checkUpload(id, what) {
    if (id == null || id === '') return null;
    if (!uploads) throw err(503, 'image uploads are not configured');
    if (!uploads.valid(id) || !uploads.pathOf(id)) throw err(422, `${what}: unknown upload — upload the image first`);
    return id;
  }
  function checkInputs({ owner, name, symbol, mints, description, links, imageId, bannerId }) {
    try { new PublicKey(owner); } catch { throw err(400, 'owner must be a wallet address'); }
    if (typeof name !== 'string' || !name.trim() || name.trim().length > limits.nameMax) throw err(400, `name: 1–${limits.nameMax} characters`);
    if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,10}$/.test(symbol)) throw err(400, `symbol: 2–${limits.symbolMax} characters, A–Z and digits`);
    if (limits.reservedSymbols.includes(symbol)) throw err(422, `the symbol ${symbol} is reserved`);
    const taken = [...existingSymbols(), ...db.prepare('SELECT token_symbol s FROM vaults').all().map((r) => r.s), ...db.prepare("SELECT symbol s FROM vault_creations WHERE status IN ('opened','deposited')").all().map((r) => r.s)];
    if (taken.map((s) => String(s).toUpperCase()).includes(symbol)) throw err(409, `the symbol ${symbol} is taken`);
    if (!Array.isArray(mints) || !mints.length || !mints.every((m) => typeof m === 'string')) throw err(400, 'mints: pick at least one item');
    if (description != null && (typeof description !== 'string' || description.length > limits.descriptionMax)) throw err(400, `description: up to ${limits.descriptionMax} characters`);
    const lk = {};
    if (links && typeof links === 'object') for (const k of ['x', 'site']) if (links[k]) { const u = String(links[k]); if (!/^https:\/\/[^\s]{3,200}$/.test(u)) throw err(400, `links.${k}: an https URL`); lk[k] = u; }
    return { owner, name: name.trim(), symbol, mints: [...new Set(mints)], description: description ? String(description).trim() : null, links: lk, image: checkUpload(imageId, 'imageId'), banner: checkUpload(bannerId, 'bannerId') };
  }

  async function quote({ owner, rules: rulesIn }) {
    try { new PublicKey(owner); } catch { throw err(400, 'owner must be a wallet address'); }
    const rules = validateRules(rulesIn || {});
    const b = await itemsOf(owner, rules);
    const can = b.items.length >= limits.minItems && b.realisableUsd >= limits.minBackingUsd;
    const { view } = curveParamsFor(Math.max(b.realisableUsd, limits.minBackingUsd), { gradMult: rules.gradMult, creatorFeePct: rules.creatorFeePct });
    // the SOL a launch needs against what the wallet holds, so the page says it before a single card is picked
    const have = Math.round((await chain.getBalanceLamports(owner)) / 1e6) / 1000;
    return { wallet: owner, rules, ...b, canCreate: can, sol: { have, need: limits.minOwnerSol, short: have < limits.minOwnerSol }, why: can ? null : `needs at least ${limits.minItems} eligible item worth $${limits.minBackingUsd}+`, curve: view, creatorTokensWorthUsd: r2(view.openingMcapUsd * view.creatorPct / 100), gasSol };
  }

  // ── step 1: open — custody allocated, deposit transactions built; nothing of ours is spent ──
  function nextCustodyIndex() {
    const used = new Set([...reservedIndexes(), ...db.prepare('SELECT custody_index i FROM vaults WHERE custody_index IS NOT NULL').all().map((r) => r.i), ...db.prepare('SELECT custody_index i FROM vault_creations').all().map((r) => r.i)]);
    let i = 0; while (used.has(i)) i += 1; return i;
  }
  async function packTransfers({ owner, custody, mints, withGas }) {
    if (withGas) {
      const have = (await chain.getBalanceLamports(owner)) / 1e9;
      if (have < limits.minOwnerSol) throw err(402, `this wallet holds ${have.toFixed(3)} SOL; a launch needs about ${limits.minOwnerSol} SOL — ${gasSol} of gas for the vault's future transactions, plus the deposits and the launch. Top it up and try again.`);
    }
    const ownerPk = new PublicKey(owner), custodyPk = new PublicKey(custody);
    const blockhash = await chain.getLatestBlockhash();
    const txs = []; let cur = null;
    const fresh = () => { const t = new Transaction({ feePayer: ownerPk, recentBlockhash: blockhash }); if (withGas && !txs.length && !cur) t.add(SystemProgram.transfer({ fromPubkey: ownerPk, toPubkey: custodyPk, lamports: Math.round(gasSol * LAMPORTS_PER_SOL) })); return t; };
    // web3.js throws on a transaction over the packet limit — that IS the overflow signal
    const size = (t) => { try { return t.serialize({ requireAllSignatures: false, verifySignatures: false }).length; } catch { return Infinity; } };
    for (const mint of mints) {
      const b64 = await buildTransfer({ mint, fromAddress: owner, toAddress: custody, recentBlockhash: blockhash });
      const ixs = Transaction.from(Buffer.from(b64, 'base64')).instructions;
      if (!cur) cur = fresh();
      const trial = new Transaction({ feePayer: ownerPk, recentBlockhash: blockhash }); cur.instructions.forEach((ix) => trial.add(ix)); ixs.forEach((ix) => trial.add(ix));
      if (size(trial) > limits.txMaxBytes && cur.instructions.length) { txs.push(cur); cur = fresh(); ixs.forEach((ix) => cur.add(ix)); }
      else ixs.forEach((ix) => cur.add(ix));
      if (size(cur) > limits.txMaxBytes) throw err(422, `item ${mint.slice(0, 6)}… does not fit in one transaction`);
    }
    if (cur && cur.instructions.length) txs.push(cur);
    const out = [];
    for (const t of txs) {
      const bytes = t.serialize({ requireAllSignatures: false, verifySignatures: false });
      const fail = checkSingleSignerUnsigned(Transaction.from(bytes), owner);
      if (fail) throw new Error(`deposit tx does not pass assertions: ${fail.assertion} (${fail.message})`);
      const sim = await chain.simulateTransaction(bytes.toString('base64'));
      if (sim && sim.err) throw err(409, explainDepositFailure(sim, t));
      out.push(bytes.toString('base64'));
    }
    return out;
  }

  async function open(input) {
    const { owner, name, symbol, mints, description, links, image, banner } = checkInputs(input);
    const rules = validateRules(input.rules || {});
    const t = now();
    if (db.prepare("SELECT id FROM vault_creations WHERE owner = ? AND status IN ('opened','deposited') AND expires_at > ?").get(owner, t)) throw err(409, 'this wallet already has a vault being created — finish or abandon it first');
    if (db.prepare("SELECT count(*) n FROM vault_creations WHERE created_at > ?").get(t - 3_600_000).n >= limits.maxOpenPerHour) throw err(429, 'too many vaults being created right now — try again in a while');
    const all = await itemsOf(owner, rules);
    const missing = mints.filter((m) => !all.items.some((it) => it.mint === m));
    if (missing.length) throw err(422, `not eligible or not in this wallet: ${missing.map((m) => m.slice(0, 6) + '…').join(', ')}`);
    const b = backingOfMints(all.items, mints);
    if (b.items.length < limits.minItems || b.realisableUsd < limits.minBackingUsd) throw err(422, `nothing to open a vault on: needs at least ${limits.minItems} eligible item worth $${limits.minBackingUsd}+`);
    const index = nextCustodyIndex();
    const custody = keyring.custodySigner(index).publicKey();
    const depositTransactions = await packTransfers({ owner, custody, mints, withGas: gasSol > 0 });
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO vault_creations (id, owner, custody_index, custody_wallet, name, symbol, mints_json, rules_json, description, links_json, image, banner, status, created_at, updated_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'opened', ?, ?, ?)`)
      .run(id, owner, index, custody, name, symbol, JSON.stringify(mints), JSON.stringify(rules), description, JSON.stringify(links), image, banner, t, t, t + limits.creationTtlMs);
    return { creationId: id, custodyWallet: custody, depositTransactions, gasSol, items: b.items.length, backing: { indexUsd: b.indexUsd, realisableUsd: b.realisableUsd }, expiresAt: t + limits.creationTtlMs };
  }

  // ── step 2: deposited — the chain says custody holds the items → config (Onix pays) → launch tx ──
  function creation(creationId) { const c = db.prepare('SELECT * FROM vault_creations WHERE id = ?').get(creationId); if (!c) throw err(404, 'unknown creation'); return c; }

  /**
   * Where the creator's launch stands, read from the chain: 'none' (never submitted) · 'live' (the pool exists) ·
   * 'in flight' (it may still land) · 'dead' (the chain rejected it, or its blockhash can no longer land).
   */
  async function launchState(c) {
    if (!c.pool) return 'none';
    if (await chain.getAccountInfoBase64(c.pool)) return 'live';
    let st = null;
    try { [st] = c.launch_sig ? await chain.getSignatureStatuses([c.launch_sig]) : [null]; } catch { return 'in flight'; }
    if (st && st.err) return 'dead';
    if (st) return 'in flight';   // landed, and the node we read the pool from has not caught up
    return now() - (c.launch_at || c.updated_at) > limits.launchExpiryMs ? 'dead' : 'in flight';
  }
  const LAUNCH_HELD = { live: 'the token is live — its items back it and stay in custody', 'in flight': 'a launch is in flight — the items stay until it lands or can no longer land' };

  const CONFIG_IN_FLIGHT = "Onix's curve setup is on the chain but not confirmed yet — your items and gas are safe in the vault's custody; this retries by itself, and the Continue button on Create picks it up later";
  /** An attempt on record but never seen confirmed: 'live' (landed) · 'in flight' (may still land) · 'dead' (rejected, or its blockhash can no longer land). */
  async function configAttemptState(c) {
    let st = null;
    try { [st] = await chain.getSignatureStatuses([c.config_sig]); } catch { return 'in flight'; }
    if (st && st.err) return 'dead';
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return 'live';
    if (st) return 'in flight';
    return now() - c.updated_at > limits.launchExpiryMs ? 'dead' : 'in flight';
  }
  const deposited = ({ creationId }) => exclusive(creationId, () => depositedStep(creationId));
  async function depositedStep(creationId) {
    const c = creation(creationId);
    if (c.pool) {
      const s = await launchState(c);
      if (LAUNCH_HELD[s]) throw err(409, LAUNCH_HELD[s]);
      // the earlier launch is dead: the creator may sign a new one
      db.prepare('UPDATE vault_creations SET base_mint = NULL, pool = NULL, launch_sig = NULL, launch_at = NULL, updated_at = ? WHERE id = ?').run(now(), c.id);
    }
    if (!['opened', 'deposited'].includes(c.status)) throw err(409, `this creation is ${c.status}`);
    if (c.expires_at <= now()) throw err(410, 'this creation expired — open again');
    const mints = JSON.parse(c.mints_json), rules = JSON.parse(c.rules_json);
    const held = await itemsOf(c.custody_wallet, rules);
    const notThere = mints.filter((m) => !held.items.some((it) => it.mint === m));
    if (notThere.length) throw err(409, `custody does not hold ${notThere.length} of ${mints.length} items yet (${notThere.map((m) => m.slice(0, 6) + '…').join(', ')})`);
    const lamports = await chain.getBalanceLamports(c.custody_wallet);
    if (lamports < Math.round(gasSol * LAMPORTS_PER_SOL * 0.9)) throw err(409, `custody wallet has ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL; needs ${gasSol}`);
    const b = backingOfMints(held.items, mints);
    const { params, view } = curveParamsFor(b.realisableUsd, { gradMult: rules.gradMult, creatorFeePct: rules.creatorFeePct });
    const client = await getClient();
    const partnerPk = new PublicKey(partner.publicKey()), quotePk = new PublicKey(quoteMint), ownerPk = new PublicKey(c.owner), custodyPk = new PublicKey(c.custody_wallet);

    // the config — paid by Onix, once per creation; the custody wallet claims the partner fee and the leftover
    let config = c.config;
    if (config && c.status === 'opened') {
      // an attempt is on record but was never seen confirmed: landed → it serves; dead → replaced; in flight → wait
      const s = await configAttemptState(c);
      if (s === 'live') db.prepare("UPDATE vault_creations SET status = 'deposited', updated_at = ? WHERE id = ?").run(now(), c.id);
      else if (s === 'dead') { db.prepare('UPDATE vault_creations SET config = NULL, config_sig = NULL, updated_at = ? WHERE id = ?').run(now(), c.id); config = null; }
      else throw err(409, CONFIG_IN_FLIGHT);
    }
    if (!config) {
      const curve = sdk.buildCurveWithMarketCap(params);
      const configKp = Keypair.generate();
      const ctx = await client.partner.createConfig({ ...curve, config: configKp.publicKey, feeClaimer: custodyPk, leftoverReceiver: custodyPk, quoteMint: quotePk, payer: partnerPk });
      ctx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: limits.priorityMicroLamports }));
      ctx.feePayer = partnerPk; ctx.recentBlockhash = await chain.getLatestBlockhash();
      // the program's own checks run here, before Onix pays anything (2 Oct 2026: InvalidTokenSupply cost a launch)
      const csim = await chain.simulateTransaction(ctx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'));
      if (csim && csim.err) throw err(409, `the curve config would be refused by the program: ${JSON.stringify(csim.err)} · ${(csim.logs || []).filter((l) => /Error Code|log:/.test(l)).slice(-2).join(' | ')}`);
      ctx.partialSign(configKp); partner.signTransaction(ctx);
      const configSig = bs58.encode(ctx.signature);
      config = configKp.publicKey.toBase58();
      // on record BEFORE the broadcast: a retry after a timeout finds the attempt and pays no second config while this one may still land
      db.prepare('UPDATE vault_creations SET config = ?, config_sig = ?, backing_usd = ?, graduation_usd = ?, updated_at = ? WHERE id = ?').run(config, configSig, b.realisableUsd, view.graduationUsd, now(), c.id);
      await chain.sendRawTransaction(ctx.serialize().toString('base64'));
      try { await chain.waitForSignature(configSig); }
      catch (e) { if (/not confirmed after/.test(e.message)) throw err(409, CONFIG_IN_FLIGHT); throw e; }
      db.prepare("UPDATE vault_creations SET status = 'deposited', updated_at = ? WHERE id = ?").run(now(), c.id);
    }
    // the RPC node the SDK reads from may lag the one that confirmed the signature (2 Oct 2026: "Pool config not
    // found for virtual pool" right after a finalized createConfig) — read it back until it is there
    for (let t = 0; ; t++) {
      try { await client.state.getPoolConfig(new PublicKey(config)); break; }
      catch (e) { if (t >= 10) throw err(503, `the curve config ${config} is not readable yet — try again in a moment`); await sleep(retryMs); }
    }

    // the launch — the creator's transaction: creator pays and creates; the mint key signs AFTER the creator
    const baseMintKp = Keypair.generate();
    const uri = `${metadataBase}/token/${baseMintKp.publicKey.toBase58()}.json`;
    const ptx = await client.creator.createPool({ name: c.name, symbol: c.symbol, uri, payer: ownerPk, poolCreator: ownerPk, config: new PublicKey(config), baseMint: baseMintKp.publicKey });
    ptx.feePayer = ownerPk; ptx.recentBlockhash = await chain.getLatestBlockhash();
    const bytes = ptx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const compiled = Transaction.from(bytes);
    const fail = checkCreatorPlusMint(compiled, c.owner, baseMintKp.publicKey.toBase58());
    if (fail) throw new Error(`createPool tx does not pass assertions: ${fail.assertion} (${fail.message})`);
    const sim = await chain.simulateTransaction(bytes.toString('base64'));
    if (sim && sim.err) throw err(409, `the launch would fail on chain: ${JSON.stringify(sim.err)} · ${(sim.logs || []).filter((l) => /log:/.test(l)).slice(-2).join(' | ')}`);
    const pool = sdk.deriveDbcPoolAddress(quotePk, baseMintKp.publicKey, new PublicKey(config)).toBase58();
    pending.set(c.id, { baseMintKp, baseMint: baseMintKp.publicKey.toBase58(), pool, content: instructionsOf(compiled) });
    return { creationId: c.id, custodyWallet: c.custody_wallet, pool, baseMint: baseMintKp.publicKey.toBase58(), config, curve: view, backing: { items: b.items.length, indexUsd: b.indexUsd, realisableUsd: b.realisableUsd }, transaction: bytes.toString('base64'), message: bs58.encode(compiled.serializeMessage()) };
  }

  // ── step 3: submit — the creator signed; the mint key completes; broadcast ──
  const submit = ({ creationId, signedTransaction }) => exclusive(creationId, () => submitStep({ creationId, signedTransaction }));
  async function submitStep({ creationId, signedTransaction }) {
    const c = creation(creationId);
    if (c.status !== 'deposited') throw err(409, `this creation is ${c.status}`);
    if (c.expires_at <= now()) throw err(410, 'this creation expired — open again');
    const p = pending.get(creationId);
    if (!p) throw err(409, 'the launch transaction is no longer held — call deposited again to rebuild it');
    if (c.pool && c.pool !== p.pool) throw err(409, 'another launch was already submitted for this creation');
    let tx; try { tx = Transaction.from(Buffer.from(String(signedTransaction || ''), 'base64')); } catch { throw err(400, 'signedTransaction must be a base64 transaction'); }
    if (instructionsOf(tx) !== p.content) { console.warn('[create] signed tx differs from the built one · built:', p.content, '· got:', instructionsOf(tx)); throw err(409, 'the signed transaction is not the one that was built'); }
    const fail = checkCreatorPlusMint(tx, c.owner, p.baseMint, { creatorSigned: true, mintSigned: false });
    if (fail) throw err(409, `signed transaction does not pass assertions: ${fail.assertion} (${fail.message})`);
    tx.partialSign(p.baseMintKp);
    if (!tx.verifySignatures()) throw err(409, 'the creator signature does not verify');
    // recorded BEFORE the broadcast: from here on the items belong to this launch until the chain says it is dead
    const sig = bs58.encode(tx.signature);
    db.prepare('UPDATE vault_creations SET base_mint = ?, pool = ?, launch_sig = ?, launch_at = ?, updated_at = ? WHERE id = ?').run(p.baseMint, p.pool, sig, now(), now(), c.id);
    await chain.sendRawTransaction(tx.serialize().toString('base64'));
    return { creationId, signature: sig, pool: p.pool, baseMint: p.baseMint };
  }

  // ── step 4: confirm — the chain is the witness: the pool exists → the vault is registered ──
  async function confirm({ creationId, signature = null }) {
    const c = creation(creationId);
    if (c.status === 'launched') return rowToDef(db.prepare('SELECT * FROM vaults WHERE id = ?').get(c.symbol.toLowerCase()), db);
    if (c.status !== 'deposited') throw err(409, `this creation is ${c.status}`);
    if (!c.pool) throw err(409, 'the launch has not been submitted');
    const acct = await chain.getAccountInfoBase64(c.pool);
    if (!acct) throw err(409, 'the pool is not on chain yet — try again in a few seconds');
    const t = now(), rules = JSON.parse(c.rules_json), vaultId = c.symbol.toLowerCase();
    db.prepare(`INSERT INTO vaults (id, name, operator, wallet, creator, custody_index, pool, base_mint, config, graduation_usd, grad_mult, creator_fee_pct, token_name, token_symbol, rules, rules_json, description, links_json, image, banner, created_by, created_at, launch_sig)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'custom', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(vaultId, c.name, c.owner.slice(0, 4) + '…' + c.owner.slice(-4), c.custody_wallet, c.owner, c.custody_index, c.pool, c.base_mint, c.config, c.graduation_usd, rules.gradMult, rules.creatorFeePct, c.name, c.symbol, c.rules_json, c.description, c.links_json, c.image || null, c.banner || null, c.owner, t, signature || c.launch_sig || null);
    const ins = db.prepare('INSERT OR IGNORE INTO vault_items (vault, mint, source, added_at) VALUES (?, ?, ?, ?)');
    for (const m of JSON.parse(c.mints_json)) ins.run(c.custody_wallet, m, 'creation', t);
    db.prepare("UPDATE vault_creations SET status = 'launched', updated_at = ? WHERE id = ?").run(t, c.id);
    pending.delete(creationId);
    return rowToDef(db.prepare('SELECT * FROM vaults WHERE id = ?').get(vaultId), db);
  }

  // ── before launch: custody returns the items to the creator (build → assert → simulate → sign → broadcast) ──
  // 'abandoned' may run again: it retries whatever custody still holds of this creation (its index is never reused)
  const abandon = ({ creationId, owner = null }) => exclusive(creationId, () => abandonStep({ creationId, owner }));
  async function abandonStep({ creationId, owner }) {
    const c = creation(creationId);
    if (owner && owner !== c.owner) throw err(403, 'only the creator can abandon this creation');
    if (!['opened', 'deposited', 'abandoned'].includes(c.status)) throw err(409, `this creation is ${c.status}`);
    const s = await launchState(c);
    if (LAUNCH_HELD[s]) throw err(409, LAUNCH_HELD[s]);
    const signer = keyring.custodySigner(c.custody_index);
    const held = await fetchAssets(rpcUrl, c.custody_wallet);
    const returned = [];
    for (const a of held) {
      if (!JSON.parse(c.mints_json).includes(a.id)) continue;
      const b64 = await buildTransfer({ mint: a.id, fromAddress: c.custody_wallet, toAddress: c.owner, recentBlockhash: await chain.getLatestBlockhash() });
      const tx = Transaction.from(Buffer.from(b64, 'base64'));
      const fail = checkSingleSignerUnsigned(tx, c.custody_wallet);
      if (fail) throw new Error(`return tx does not pass assertions: ${fail.assertion}`);
      const sim = await chain.simulateTransaction(b64);
      if (sim && sim.err) throw err(409, `returning ${a.id.slice(0, 6)}… would fail on chain: ${JSON.stringify(sim.err)}`);
      signer.signTransaction(tx);
      const sig = await chain.sendRawTransaction(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'));
      returned.push({ mint: a.id, signature: sig });
    }
    // and the gas the creator sent: everything the custody wallet holds, minus one fee, goes back too
    let solReturned = 0;
    try {
      const bal = await chain.getBalanceLamports(c.custody_wallet);
      const amount = bal - 5000;
      if (amount > 0) {
        const tx = new Transaction({ feePayer: new PublicKey(c.custody_wallet), recentBlockhash: await chain.getLatestBlockhash() });
        tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(c.custody_wallet), toPubkey: new PublicKey(c.owner), lamports: amount }));
        const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
        const fail = checkSingleSignerUnsigned(Transaction.from(Buffer.from(unsigned, 'base64')), c.custody_wallet);
        if (fail) throw new Error(`gas return does not pass assertions: ${fail.assertion}`);
        const sim = await chain.simulateTransaction(unsigned);
        if (sim && sim.err) throw new Error(`gas return would fail on chain: ${JSON.stringify(sim.err)}`);
        signer.signTransaction(tx);
        returned.push({ sol: amount / LAMPORTS_PER_SOL, signature: await chain.sendRawTransaction(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')) });
        solReturned = amount / LAMPORTS_PER_SOL;
      }
    } catch (e) { console.warn(`[create] abandon ${c.id}: could not return the gas: ${e.message}`); }
    db.prepare("UPDATE vault_creations SET status = 'abandoned', updated_at = ? WHERE id = ?").run(now(), c.id);
    pending.delete(creationId);
    return { creationId, returned, solReturned };
  }

  /**
   * Expired creations: a live token is registered (its items stay), a launch in flight is left for the next round,
   * anything else is abandoned (items returned). Called by the server's sweep.
   */
  async function sweep() {
    const rows = db.prepare("SELECT id FROM vault_creations WHERE status IN ('opened','deposited') AND expires_at <= ?").all(now());
    const out = [];
    for (const r of rows) {
      try {
        const s = await launchState(creation(r.id));
        if (s === 'live') out.push({ creationId: r.id, confirmed: await confirm({ creationId: r.id }) });
        else if (s !== 'in flight') out.push(await abandon({ creationId: r.id }));
      } catch (e) { console.warn(`[create] sweep could not settle ${r.id}: ${e.message}`); }
    }
    return out;
  }

  /** Where a creation stands — and, while it is open, fresh deposit transactions for whatever custody does not hold yet. */
  async function status({ creationId, owner = null }) {
    const c = creation(creationId);
    if (owner && owner !== c.owner) throw err(403, 'not your creation');
    const out = { creationId: c.id, status: c.status, owner: c.owner, custodyWallet: c.custody_wallet, symbol: c.symbol, name: c.name, mints: JSON.parse(c.mints_json), rules: JSON.parse(c.rules_json), backingUsd: c.backing_usd, graduationUsd: c.graduation_usd, pool: c.pool, baseMint: c.base_mint, config: c.config, expiresAt: c.expires_at };
    if (c.status === 'opened' || c.status === 'deposited') {
      const held = await fetchAssets(rpcUrl, c.custody_wallet);
      const missing = out.mints.filter((m) => !held.some((a) => a.id === m));
      const lamports = await chain.getBalanceLamports(c.custody_wallet);
      out.missingMints = missing; out.custodySol = lamports / LAMPORTS_PER_SOL;
      if (missing.length) out.depositTransactions = await packTransfers({ owner: c.owner, custody: c.custody_wallet, mints: missing, withGas: lamports < Math.round(gasSol * LAMPORTS_PER_SOL * 0.9) });
    }
    return out;
  }

  return { quote, open, deposited, submit, confirm, abandon, sweep, status, DECIDED, LIMITS: limits, _pending: pending };
}

/** A DB row → a registry entry (the same shape vaults.json uses). `manifest` reads the declared items live. */
function rowToDef(r, db = null) {
  const manifest = db ? () => db.prepare('SELECT mint FROM vault_items WHERE vault = ?').all(r.wallet).map((x) => x.mint) : null;
  let rules = r.rules; try { if (r.rules_json) rules = JSON.parse(r.rules_json); } catch { /* fall back to the named rule set */ }
  const gradMult = r.grad_mult || DECIDED.gradMultDefault;
  return {
    id: r.id, manifest, name: r.name, operator: r.operator, creator: r.creator || null, custodyIndex: r.custody_index ?? null, secretEnv: null,
    description: r.description || `${r.token_name} · created by ${r.operator}`, wallet: r.wallet,
    pool: r.pool, baseMint: r.base_mint, graduationUsd: r.graduation_usd, gradMult, creatorFeePct: r.creator_fee_pct || DECIDED.creatorTradingFeePercentage,
    creatorPct: DECIDED.creatorPct, vestingMonths: DECIDED.vestingMonths, openingMcapUsd: Math.round(r.graduation_usd / gradMult * 100) / 100,
    token: { name: r.token_name, symbol: r.token_symbol, image: r.image ? `/token/${r.base_mint}.png` : '/token/default.png', banner: r.banner ? `/token/${r.base_mint}-banner.png` : null },
    links: (() => { try { return r.links_json ? JSON.parse(r.links_json) : {}; } catch { return {}; } })(),
    rules, createdBy: r.created_by, createdAt: r.created_at,
  };
}

module.exports = { createVaultCreator, curveParamsFor, checkCreatorPlusMint, instructionsOf, rowToDef, DECIDED, LIMITS, WALLET_WRAPPER_PROGRAMS };
