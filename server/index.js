#!/usr/bin/env node
/**
 * server/index.js — production wiring. The only place the pieces meet.
 *
 * One server, N vaults (server/registry.js). Each vault is a BUNDLE: its own wallet and
 * signer (an env var named in the registry), items reader, stats, admissions, trader and
 * delivery — over one shared DB where every row carries its vault.
 *
 * Delivery = build the transfer (origin = vault wallet) → assert single unsigned
 * signer → SIMULATE (a delivery that would fail on chain is never signed) → sign →
 * PERSIST the signed tx on the reservation → broadcast. A crash between persist and
 * broadcast never delivers twice: the rebroadcast is the same signature.
 */
'use strict';
const { Transaction } = require('@solana/web3.js');
const C = require('./config');
const defaultChain = require('./chain');
const defaultSigner = require('./signer');
const { getDb } = require('./db');
const { createItemsReader } = require('./items');
const { createStatsReader } = require('./stats');
const { createWalletReader } = require('./wallet');
const { createCurveTrader, productionCurveDeps } = require('./curve');
const { createDammTrader, createRoutedTrader, productionDammDeps } = require('./damm');
const { createAdmissions, VAULT_RULES } = require('./admissions');
const { describeRules } = require('./rules');
const { createVaultCreator } = require('./creation');
const { createPlay } = require('./play');
const { createRestock, productionRestockDeps } = require('./restock');
const { createFeeClaim, productionFeeClaimDeps } = require('./feeclaim');
const { createGraduation, productionGraduationDeps } = require('./graduation');
const { createUploads } = require('./uploads');
const { createRateLimiter } = require('./ratelimit');
const { createPause } = require('./pause');
const path = require('path');
const reservationsRepo = require('./reservationsRepo');
const keyring = require('./keyring');
const { serverSeedFor } = require('./draw');
const { normalize } = require('./registry');
const { loadVaults } = require('./registry');
const das = require('../src/reader/das');
const { createTransferBuilder, productionDeps } = require('./transfer');
const { checkSingleSignerUnsigned } = require('./txAssertions');
const { createVaultService, VaultError } = require('./vaultService');
const { buildApp } = require('./app');

/**
 * Everything one vault needs, from its registry entry. Any piece replaceable (the devnet
 * rehearsal swaps the items reader for a fixture and the signer for a throwaway keypair;
 * the delivery path is the production one).
 */
const noSigner = { configured: () => false, publicKey: () => { throw new VaultError(503, 'this vault has no server-side key: its creator holds the items'); }, signTransaction: () => { throw new VaultError(503, 'this vault has no server-side key'); } };

function createVaultBundle(def, { db, chain, readItems: readItemsOverride = null, signer: signerOverride = null }) {
  const vaultWallet = def.wallet;
  // custody: a derived wallet (keyring) · the operator's env key · or nobody (list only)
  const signer = signerOverride || (def.custodyIndex != null ? keyring.custodySigner(def.custodyIndex) : !def.secretEnv ? noSigner : def.secretEnv === 'VAULT_SECRET_KEY' ? defaultSigner : defaultSigner.fromEnv(def.secretEnv));
  const readItems = readItemsOverride || createItemsReader({ rpcUrl: C.RPC_URL, vaultWallet, marketRefUrl: C.MARKET_REF_URL, cacheMs: C.ITEMS_CACHE_MS, manifest: def.manifest || null });
  const transfer = createTransferBuilder(productionDeps(chain));
  const bs58 = require('bs58');
  const encode = bs58.encode || bs58.default?.encode;

  const deliver = async ({ mint, toAddress, reservationId = null, onSigned = null }) => {
    if (!signer.configured()) throw new VaultError(503, 'vault signer not configured');
    const from = signer.publicKey();
    if (from !== vaultWallet) throw new VaultError(503, `signer ${from} is not the configured vault wallet ${vaultWallet}`);
    const b64 = await transfer.buildTransferTx({ mint, fromAddress: from, toAddress, recentBlockhash: await chain.getLatestBlockhash() });
    const tx = Transaction.from(Buffer.from(b64, 'base64'));
    const fail = checkSingleSignerUnsigned(tx, from);
    if (fail) throw new Error(`delivery tx does not pass assertions: ${fail.assertion}`);
    // The deliverability check the gacha has used since Aug 2026: simulate before signing.
    const sim = await chain.simulateTransaction(b64);
    if (sim?.err) throw new Error(`delivery would fail on chain: ${JSON.stringify(sim.err)} · ${(sim.logs || []).slice(-3).join(' | ')}`);
    signer.signTransaction(tx);
    const sig = encode(tx.signatures.find((s) => s.publicKey.toBase58() === from).signature);
    const signedB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    // persist the signed transaction BEFORE broadcasting: a crash between the two must never lose a delivery
    if (reservationId) db.prepare('UPDATE vault_reservations SET delivery_tx_b64 = ?, updated_at = ? WHERE id = ?').run(signedB64, Date.now(), reservationId);
    if (onSigned) onSigned(signedB64);
    try { await chain.sendRawTransaction(signedB64); }
    catch (e) { console.warn(`[vault ${def.id}] broadcast of delivery ${reservationId} failed (persisted; rebroadcast possible): ${e.message}`); }
    return { sig };
  };

  let play = null;   // assigned below; the two doors share one view of what is busy
  let statsRef = null;   // assigned below; the gacha door opens at graduation, like Play
  const service = createVaultService({
    db, readItems, chain, deliver, isMintBusy: (mint) => Boolean(play && play.busyMints().includes(mint)),
    canSell: async () => { if (!def.pool) return { ok: true }; const st = statsRef ? await statsRef.read() : null; return st && st.poolStatus === 'migrated' ? { ok: true } : { ok: false, reason: 'this vault sells to integrators once it graduates' }; },
    config: { vaultWallet, usdcMint: C.USDC_MINT, memoProgramId: C.MEMO_PROGRAM_ID, reservationTtlMs: C.RESERVATION_TTL_MS, strikesToBlock: C.STRIKES_TO_BLOCK },
  });
  const curveDeps = productionCurveDeps({ rpcUrl: C.RPC_URL, chain });
  const readConfig = async (configPk) => {
    const client = await curveDeps.getClient();
    const { PublicKey } = require('@solana/web3.js');
    const cfg = await client.state.getPoolConfig(new PublicKey(configPk));
    const lv = cfg.lockedVestingConfig;
    const tokens = (Number(lv.cliffUnlockAmount.toString()) + Number(lv.amountPerPeriod.toString()) * Number(lv.numberOfPeriod.toString())) / 10 ** C.BASE_DECIMALS;
    // the creator's vesting lives in Jupiter Lock (Meteora's Locker program): the escrow is derivable from the pool
    const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
    let locker = null;
    if (def.pool && tokens > 0) { try { locker = { program: 'Jupiter Lock', escrow: sdk.deriveEscrow(sdk.deriveBaseKeyForLocker(new PublicKey(def.pool))).toBase58(), url: 'https://lock.jup.ag' }; } catch (e) { locker = null; } }
    return { migrationQuoteThresholdUsd: Number(cfg.migrationQuoteThreshold.toString()) / 10 ** C.QUOTE_DECIMALS, lockedVestingTokens: tokens, migrationFeeOption: Number(cfg.migrationFeeOption), locker };
  };
  // the graduated pool (DAMM v2): derived from the DBC migration fee option, read with the cp-amm SDK
  const readDamm = async ({ baseMint, migrationFeeOption }) => {
    const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
    const { CpAmm, getPriceFromSqrtPrice } = require('@meteora-ag/cp-amm-sdk');
    const { Connection, PublicKey } = require('@solana/web3.js');
    const dammConfig = sdk.DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption];
    if (!dammConfig) return null;
    const address = sdk.deriveDammV2PoolAddress(dammConfig, new PublicKey(baseMint), new PublicKey(C.USDC_MINT));
    const st = await new CpAmm(new Connection(C.RPC_URL, 'confirmed')).fetchPoolState(address);
    return { address: address.toBase58(), priceUsd: Number(getPriceFromSqrtPrice(st.sqrtPrice, C.BASE_DECIMALS, C.QUOTE_DECIMALS).toString()) };
  };
  const stats = createStatsReader({ readItems, chain, config: { vaultWallet, usdcMint: C.USDC_MINT, haircut: C.HAIRCUT, graduationUsd: def.graduationUsd, pool: def.pool, baseMint: def.baseMint, baseDecimals: C.BASE_DECIMALS, quoteDecimals: C.QUOTE_DECIMALS, creatorPct: def.creatorPct ?? null, vestingMonths: def.vestingMonths ?? null, openingMcapUsd: def.openingMcapUsd ?? null }, cacheMs: C.ITEMS_CACHE_MS, readConfig, readDamm });
  // one Buy door for the token's whole life: the curve while live, the graduated DAMM v2 pool once migrated
  const curveTrader = def.pool ? createCurveTrader({ pool: def.pool, baseDecimals: C.BASE_DECIMALS, quoteDecimals: C.QUOTE_DECIMALS, quoteMint: C.USDC_MINT, baseMint: def.baseMint, referralTokenAccount: C.REFERRAL_USDC_ACCOUNT, ...curveDeps }) : null;
  const dammDeps = productionDammDeps({ rpcUrl: C.RPC_URL, chain });
  statsRef = stats;
  const trader = def.pool ? createRoutedTrader({
    curve: curveTrader,
    makeDamm: (pool) => createDammTrader({ pool, baseMint: def.baseMint, quoteMint: C.USDC_MINT, baseDecimals: C.BASE_DECIMALS, quoteDecimals: C.QUOTE_DECIMALS, referralTokenAccount: C.REFERRAL_USDC_ACCOUNT, ...dammDeps }),
    whereToTrade: async () => { const st = await stats.read(); const p = st.pool; return p && p.isMigrated ? { venue: 'pool', pool: p.damm ? p.damm.address : null } : { venue: 'curve', pool: null }; },
  }) : null;
  // only the creator adds items; a file-registry vault names its creator, else nobody can
  const admissions = createAdmissions({ db, chain, vaultWallet, creator: def.creator || null, rules: def.rules, rpcUrl: C.RPC_URL, fetchAssets: das.fetchAssetsByOwner, buildTransfer: (a) => transfer.buildTransferTx(a), haircut: C.HAIRCUT,
    onAdmitted: def.manifest ? (mint) => db.prepare('INSERT OR IGNORE INTO vault_items (vault, mint, source, added_at) VALUES (?, ?, ?, ?)').run(vaultWallet, mint, 'admission', Date.now()) : null });
  const meta = { id: def.id, name: def.name, operator: def.operator, creator: def.creator || null, custodians: def.custodians, description: def.description, token: def.token, links: def.links || {}, graduationUsd: def.graduationUsd,
    rulesText: describeRules(def.rules), gradMult: def.gradMult ?? null, creatorFeePct: def.creatorFeePct ?? null, custody: def.custodyIndex != null ? 'derived' : def.secretEnv ? 'operator' : 'none' };
  play = createPlay({ db, chain, vaultWallet, baseMint: def.baseMint, baseDecimals: C.BASE_DECIMALS, readItems, readStats: () => stats.read(), deliver,
    isMintBusy: (mint) => Boolean(reservationsRepo.liveForMint(db, mint, Date.now())), usdcMint: C.USDC_MINT, memoProgramId: C.MEMO_PROGRAM_ID,
    // the server seed of each play comes from the draw key (derived from the master seed); the database holds only its hash
    seedFor: keyring.configured() ? (playId) => serverSeedFor({ drawKey: keyring.drawKey(), vault: vaultWallet, playId }) : null });
  // the treasury → next item loop: needs the custody key and the vault's rules; runs by sweep only when enabled, by script always
  const restock = createRestock({ db, chain, vaultWallet, signer, rules: def.rules, readItems, ...productionRestockDeps({ ccApiBase: C.CC_API_BASE, rpcUrl: C.RPC_URL, chain }) });
  // the trading fees → the treasury (and Onix's third of the curve's partner fee, in the same transaction)
  const feeclaim = def.pool ? createFeeClaim({ db, chain, vaultWallet, signer, pool: def.pool, usdcMint: C.USDC_MINT, onixUsdcAccount: C.ONIX_REVENUE_USDC_ACCOUNT, ...productionFeeClaimDeps({ rpcUrl: C.RPC_URL }) }) : null;
  // the vault graduating itself: the custody key claims the migration fee, the operator key pays the locker and the migration;
  // runs by the minute check when enabled (no public trigger: only a full curve starts it)
  const graduation = def.pool ? createGraduation({ db, chain, vaultWallet, pool: def.pool, signer, payer: defaultSigner, ...productionGraduationDeps({ getClient: curveDeps.getClient }) }) : null;
  return { wallet: vaultWallet, def, meta, service, stats, admissions, trader, play, restock, feeclaim, graduation, readItems, signer, itemsAge: readItems.ageMs || (() => null), signerConfigured: signer.configured };
}

/**
 * Builds the whole server from the registry (or, for a rehearsal, from the one vault
 * passed in with its pieces).
 */
function createServer({ readItems = null, db: dbOverride = null, signer = null, vaultWallet = null, chain = defaultChain, vaults: defs = null, creator: creatorOverride = null, pause: pauseOverride = null } = {}) {
  const opts = { pause: pauseOverride };
  const db = dbOverride || getDb();
  const list = defs || (vaultWallet
    ? [{ id: '1', name: 'Vault', operator: 'Onix', wallet: vaultWallet, secretEnv: 'VAULT_SECRET_KEY', rules: VAULT_RULES.vault1, custodians: VAULT_RULES.vault1.custodians, pool: C.POOL || null, baseMint: C.BASE_MINT || null, graduationUsd: C.GRADUATION_USD, token: { name: 'Vault token', symbol: 'VAULT', image: '/token/default.png' } }]
    : loadVaults(db));
  const bundles = list.map((def, i) => createVaultBundle(def, { db, chain, readItems: i === 0 ? readItems : null, signer: i === 0 ? signer : null }));
  // rows written before the `vault` column existed belong to the primary vault
  if (bundles.length) for (const t of ['vault_reservations', 'vault_admissions']) db.prepare(`UPDATE ${t} SET vault = ? WHERE vault IS NULL`).run(bundles[0].wallet);
  const readWallet = createWalletReader({ rpcUrl: C.RPC_URL });
  // the Create door: Onix (the operator key) is the curve's partner — it pays for the config and claims the fee
  const partner = signer || defaultSigner;
  const uploads = createUploads({ dir: C.UPLOADS_DIR });
  const uploadLimiter = createRateLimiter({ capacity: 20, perMs: 3_600_000 });
  const fences = { create: createRateLimiter({ capacity: 6, perMs: 3_600_000 }), play: createRateLimiter({ capacity: 30, perMs: 3_600_000 }), build: createRateLimiter({ capacity: 120, perMs: 3_600_000 }), read: createRateLimiter({ capacity: 600, perMs: 3_600_000 }) };
  const limits = Object.fromEntries(Object.entries(fences).map(([k, rl]) => [k, (ip) => rl.take(ip)]));
  const curveDeps = productionCurveDeps({ rpcUrl: C.RPC_URL, chain });
  const transferForCreation = createTransferBuilder(productionDeps(chain));
  const creator = creatorOverride || createVaultCreator({ db, chain, sdk: require('@meteora-ag/dynamic-bonding-curve-sdk'), getClient: curveDeps.getClient, partner, keyring, quoteMint: C.USDC_MINT,
    fetchAssets: das.fetchAssetsByOwner, buildTransfer: (a) => transferForCreation.buildTransferTx(a), rpcUrl: C.RPC_URL, metadataBase: C.PUBLIC_URL, haircut: C.HAIRCUT,
    existingSymbols: () => bundles.map((b) => (b.meta.token && b.meta.token.symbol) || ''), reservedIndexes: () => bundles.map((b) => b.def.custodyIndex).filter((i) => i != null), uploads });
  // a vault created through the door mounts without a restart
  const addVault = (def) => { const b = createVaultBundle(normalize(def), { db, chain }); bundles.push(b); return b; };
  const pause = opts.pause || createPause({ dir: path.dirname(C.DB_PATH) });
  const app = buildApp({ vaults: bundles, readWallet, creator, addVault, db, uploads, uploadLimiter: (ip) => uploadLimiter.take(ip), limits, swapUrl: C.SWAP_URL, publicUrl: C.PUBLIC_URL, keyringConfigured: keyring.configured, pause });
  // zero vaults is a valid state (before the first one is created, or after all are closed)
  const primary = bundles[0] || null;
  return { app, db, vaults: bundles, addVault, creator, uploads, pause, service: primary ? primary.service : null, admissions: primary ? primary.admissions : null };
}

function main() {
  const { app, vaults, creator, uploads, db, pause, addVault } = createServer();
  const paused = (v) => pause.isPaused(v ? { wallet: v.wallet, id: v.meta && v.meta.id } : null);
  app.listen(C.PORT, '127.0.0.1', () => {
    for (const v of vaults) console.log(`[vault] ${v.meta.name} (${v.meta.id}) · ${v.wallet} · pool ${v.def.pool || '—'} · signer ${v.signerConfigured() ? 'configured' : 'NOT configured (list only)'}`);
    console.log(`[vault] Onix.Vault server on 127.0.0.1:${C.PORT} · ${vaults.length} vault(s)`);
  });
  setInterval(() => { for (const v of vaults) { try { v.service.sweepExpired(); } catch (e) { console.warn(`[vault ${v.meta.id}] sweep failed`, e.message); } } }, 60_000).unref();
  setInterval(() => { for (const v of vaults) if (v.play && !paused(v)) v.play.sweep().then((r) => { if (r.delivered || r.failed) console.log(`[vault ${v.meta.id}] plays: ${r.verified} verified · ${r.delivered} delivered · ${r.failed} failed`); }).catch((e) => console.warn(`[vault ${v.meta.id}] play sweep failed`, e.message)); }, 10_000).unref();
  // expired creations: a live token is registered and mounted (its items stay), the rest are abandoned (items returned)
  setInterval(() => { if (paused(null)) return; creator.sweep().then((r) => {
    for (const x of r) if (x.confirmed && !vaults.some((v) => v.wallet === x.confirmed.wallet)) addVault(x.confirmed);
    const n = r.filter((x) => x.confirmed).length;
    if (r.length) console.log(`[create] sweep: ${n} launched creation(s) registered · ${r.length - n} abandoned, items returned`);
  }).catch((e) => console.warn('[create] sweep failed', e.message)); }, 5 * 60_000).unref();
  // images nobody attached to a vault or a live creation within an hour are removed
  setInterval(() => { try { const keep = [...db.prepare('SELECT image, banner FROM vaults').all(), ...db.prepare("SELECT image, banner FROM vault_creations WHERE status IN ('opened','deposited')").all()].flatMap((r) => [r.image, r.banner]).filter(Boolean); const r = uploads.sweep({ keep }); if (r.removed) console.log(`[uploads] ${r.removed} orphan image(s) removed`); } catch (e) { console.warn('[uploads] sweep failed', e.message); } }, 15 * 60_000).unref();
  // purchases sent by the script or the sweep are confirmed against the chain; the buying itself only when enabled
  setInterval(() => { for (const v of vaults) if (v.feeclaim) v.feeclaim.confirm().then((r) => { if (r.landed || r.failed) console.log(`[vault ${v.meta.id}] fee claims: ${r.landed} landed · ${r.failed} failed`); }).catch((e) => console.warn(`[vault ${v.meta.id}] fee claim confirm failed`, e.message)); }, 2 * 60_000).unref();
  setInterval(() => { for (const v of vaults) if (v.restock) v.restock.confirm().then((r) => { if (r.landed || r.failed) console.log(`[vault ${v.meta.id}] restock: ${r.landed} landed · ${r.failed} failed · ${r.pending} pending`); }).catch((e) => console.warn(`[vault ${v.meta.id}] restock confirm failed`, e.message)); }, 2 * 60_000).unref();
  // a round that buys nothing says why once (when the reason changes): a silent loop reads the same as a dead one
  const restockWhy = new Map();
  // the 1st round runs a minute after boot, then every 15 min: a deploy restarts the server, and with only the interval a
  // run of deploys closer than 15 min apart starved the loop (3 Oct 2026: no claim for 40 min)
  const treasuryRound = async () => { for (const v of vaults) { try { if (paused(v)) continue; const st = await v.stats.read(); if (!st.pool || !v.signerConfigured()) continue;
    // 1st the fees reach the treasury (any vault with a curve), then the treasury buys (graduated vaults only)
    if (v.feeclaim) { try { const c = await v.feeclaim.execute({ go: true }); if (c.claimed) console.log(`[vault ${v.meta.id}] fees CLAIMED: treasury +$${c.claimed.treasuryUsd.toFixed(2)} · Onix +$${c.claimed.onixUsd.toFixed(2)} · ${c.claimed.signature}`); } catch (e) { console.warn(`[vault ${v.meta.id}] fee claim failed`, e.message); } }
    if (st.poolStatus !== 'migrated') continue; const r = await v.restock.execute({ go: true }); if (r.bought) console.log(`[vault ${v.meta.id}] restock BOUGHT ${r.bought.name} for $${r.bought.priceUsd} (index $${r.bought.insuredUsd}) · ${r.bought.signature}`); else if (restockWhy.get(v.wallet) !== r.why) console.log(`[vault ${v.meta.id}] restock: no buy — ${r.why} (treasury $${r.treasuryUsd})`); restockWhy.set(v.wallet, r.bought ? null : r.why); } catch (e) { console.warn(`[vault ${v.meta.id}] restock failed`, e.message); } } };
  if (C.RESTOCK_ENABLED) { setTimeout(treasuryRound, 60_000).unref(); setInterval(treasuryRound, 15 * 60_000).unref(); }
  // the vault graduating itself: every minute a full curve that has not migrated is migrated by the server; says why not once
  const graduationWhy = new Map();
  const graduationRound = async () => { for (const v of vaults) { if (!v.graduation || paused(v)) continue; try { const r = await v.graduation.execute({ go: true });
    if (r.graduated) { console.log(`[vault ${v.meta.id}] GRADUATED: raised $${r.graduated.raisedUsd} · migrate ${r.graduated.signatures.migrate} · fee ${r.graduated.signatures.fee || 'skipped'} · leftover ${r.graduated.signatures.leftover || 'skipped'}`); await v.stats.read({ fresh: true }).catch(() => {}); }
    else if (r.failed) console.warn(`[vault ${v.meta.id}] graduation FAILED: ${r.failed}`);
    else if (r.why && graduationWhy.get(v.wallet) !== r.why) console.log(`[vault ${v.meta.id}] graduation: ${r.why}`);
    graduationWhy.set(v.wallet, r.why || null); } catch (e) { console.warn(`[vault ${v.meta.id}] graduation check failed`, e.message); } } };
  if (C.GRADUATION_ENABLED) { setTimeout(graduationRound, 30_000).unref(); setInterval(graduationRound, C.GRADUATION_CHECK_MS).unref(); }
  setInterval(() => { for (const v of vaults) v.admissions.verifyPending().then((r) => { if (r.verified) console.log(`[vault ${v.meta.id}] ${r.verified} admission(s) verified on chain`); }).catch((e) => console.warn(`[vault ${v.meta.id}] admissions sweep failed`, e.message)); }, 45_000).unref();
}

if (require.main === module) main();
module.exports = { main, createServer, createVaultBundle };
