/**
 * server/play.js — the Play door: pay, draw an item from a band, get it delivered from custody.
 *
 *   bands()                                   the vault's items grouped by value, with prices in both currencies
 *   start({ band, player, currency, clientSeed })
 *                                             commit published, price frozen for 60 s, the payment tx built
 *                                             (USDC → custody, or a BURN of the vault token by the player)
 *   submit({ playId, signature })             the player paid: the signature is recorded (UNIQUE), nothing is
 *                                             believed yet
 *   sweep()                                   finalized + verified → draw → item reserved → delivered from custody
 *   get(id) · list()                           the proof: commit, seed (after delivery), digest, index, snapshot
 *
 * Prices (decided 2 Oct 2026): USDC = band average × 1.15. Token = band average × 1.10 ÷ (realisable
 * backing ÷ supply) — in SHARE OF BACKING, never at the market price, so a pump buys nothing cheaper.
 * A USDC play leaves the money in custody (the treasury buys the next item); a token play burns supply.
 */
'use strict';
const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');
const { generateCommit, draw, validClientSeed, MAX_REDRAWS } = require('./draw');
const { buildPaymentTx, buildBurnTx, readPayment, readBurnPayment } = require('./payment');

function err(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }
const r2 = (n) => Math.round(n * 100) / 100;

const PLAY = Object.freeze({
  usdcPremium: 1.15, tokenPremium: 1.10,
  quoteTtlMs: 60_000, payTtlMs: 10 * 60_000,
  minItemsForDraw: 3,                 // below this a band is a pick, not a draw — said on the page
  perWalletPerHour: 6, unpaidPerWallet: 1,
  split: Object.freeze({ creator: 40, treasury: 40, onix: 20 }),   // of the 15% edge on a USDC play
  bands: Object.freeze([{ id: 'b1', label: 'under $25', min: 0, max: 25 }, { id: 'b2', label: '$25 – $60', min: 25, max: 60 }, { id: 'b3', label: '$60 – $150', min: 60, max: 150 }, { id: 'b4', label: '$150 and up', min: 150, max: Infinity }]),
});

function createPlay({ db, chain, vaultWallet, baseMint, baseDecimals = 6, readItems, readStats, deliver, isMintBusy = () => false, usdcMint, memoProgramId, now = Date.now, limits = PLAY }) {
  const bandOf = (v) => limits.bands.find((b) => v >= b.min && v < b.max) || limits.bands[limits.bands.length - 1];

  /** Items in custody that are free (not reserved for a gacha, not drawn by another play). */
  async function freeItems() {
    const items = (await readItems()).filter((it) => it.custodianValueUsd != null);
    const taken = new Set(db.prepare("SELECT mint FROM vault_plays WHERE vault = ? AND status IN ('drawn','delivering','delivery_failed')").all(vaultWallet).map((r) => r.mint));
    return items.filter((it) => !taken.has(it.mint) && !isMintBusy(it.mint));
  }

  async function bands() {
    const [items, st] = await Promise.all([freeItems(), readStats()]);
    const navPerToken = st.pool && st.pool.supply ? st.backing.realisableUsd / st.pool.supply : null;
    return {
      readAt: now(), currencies: { usdc: true, token: Boolean(baseMint && navPerToken) }, tokenSymbol: null,
      bands: limits.bands.map((b) => {
        const inBand = items.filter((it) => bandOf(it.custodianValueUsd).id === b.id);
        const avg = inBand.length ? inBand.reduce((s, it) => s + it.custodianValueUsd, 0) / inBand.length : 0;
        return {
          id: b.id, label: b.label, items: inBand.length, kind: inBand.length >= limits.minItemsForDraw ? 'draw' : inBand.length ? 'pick' : 'empty',
          avgIndexUsd: r2(avg), priceUsdc: inBand.length ? r2(avg * limits.usdcPremium) : null,
          priceTokens: inBand.length && navPerToken ? Math.ceil(avg * limits.tokenPremium / navPerToken) : null,
          odds: inBand.length ? 1 / inBand.length : 0,
          preview: inBand.slice(0, 6).map((it) => ({ mint: it.mint, name: it.name, imageUrl: it.imageUrl || null, custodianValueUsd: it.custodianValueUsd })),
        };
      }),
      navPerTokenUsd: navPerToken,
    };
  }

  async function start({ band, player, currency, clientSeed }) {
    try { new PublicKey(player); } catch { throw err(400, 'player must be a wallet address'); }
    if (!['usdc', 'token'].includes(currency)) throw err(400, 'currency: usdc or token');
    if (!validClientSeed(clientSeed)) throw err(400, 'clientSeed: 1–32 letters, digits, _ or -');
    const t = now();
    if (db.prepare("SELECT count(*) n FROM vault_plays WHERE vault = ? AND player = ? AND status = 'created' AND expires_at > ?").get(vaultWallet, player, t).n >= limits.unpaidPerWallet) throw err(409, 'you have a play waiting for payment — pay it or let it expire');
    if (db.prepare('SELECT count(*) n FROM vault_plays WHERE vault = ? AND player = ? AND created_at > ?').get(vaultWallet, player, t - 3_600_000).n >= limits.perWalletPerHour) throw err(429, `up to ${limits.perWalletPerHour} plays an hour per wallet`);
    const b = (await bands()).bands.find((x) => x.id === band);
    if (!b || !b.items) throw err(404, 'that band has nothing to draw from');
    if (currency === 'token' && !b.priceTokens) throw err(409, 'token plays open once the token trades');
    const items = (await freeItems()).filter((it) => bandOf(it.custodianValueUsd).id === band);
    const snapshot = items.map((it) => it.mint).sort();
    const { serverSeed, serverSeedHash } = generateCommit();
    const id = crypto.randomUUID();
    const memo = `play:${id}`;
    const blockhash = await chain.getLatestBlockhash();
    const priceUsdc = b.priceUsdc, priceTokens = b.priceTokens;
    const amountUnits = currency === 'token' ? priceTokens * 10 ** baseDecimals : null;
    const paymentTransaction = currency === 'token'
      ? buildBurnTx({ payer: player, mint: baseMint, amountUnits, decimals: baseDecimals, memoProgramId, memo, recentBlockhash: blockhash })
      : buildPaymentTx({ payer: player, vaultWallet, usdcMint, memoProgramId, amountUsd: priceUsdc, memo, recentBlockhash: blockhash });
    // pre-flight, so the wallet never sees a transaction that fails (0 USDC, no token account…)
    if (chain.simulateTransaction) {
      const sim = await chain.simulateTransaction(paymentTransaction);
      if (sim && sim.err) {
        const logs = (sim.logs || []).join(' | ');
        if (/insufficient funds|insufficient lamports|"Custom":1\b/.test(logs + JSON.stringify(sim.err))) throw err(402, currency === 'token' ? `this wallet needs ${priceTokens.toLocaleString('en-US')} tokens for this play. Nothing was sent.` : `this wallet needs $${priceUsdc.toFixed(2)} USDC for this play. Nothing was sent.`);
        throw err(409, `the payment would fail on chain: ${JSON.stringify(sim.err)} · ${(sim.logs || []).filter((l) => /log:/.test(l)).slice(-2).join(' | ')}`);
      }
    }
    db.prepare(`INSERT INTO vault_plays (id, vault, player, band, currency, client_seed, server_seed, server_seed_hash, snapshot_json, price_usdc, price_tokens, avg_index_usd, status, created_at, updated_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)`)
      .run(id, vaultWallet, player, band, currency, clientSeed, serverSeed, serverSeedHash, JSON.stringify(snapshot), priceUsdc, priceTokens, b.avgIndexUsd, t, t, t + limits.payTtlMs);
    return { playId: id, serverSeedHash, band: b.id, items: snapshot.length, odds: 1 / snapshot.length, currency, price: currency === 'token' ? priceTokens : priceUsdc, unit: currency === 'token' ? 'token' : 'USDC', memo, paymentTransaction, quoteValidUntil: t + limits.quoteTtlMs, expiresAt: t + limits.payTtlMs };
  }

  function submit({ playId, signature }) {
    if (!playId || !signature) throw err(400, 'playId and signature are required');
    const p = db.prepare('SELECT * FROM vault_plays WHERE id = ?').get(playId);
    if (!p) throw err(404, 'unknown play');
    if (p.status !== 'created') throw err(409, `this play is ${p.status}`);
    if (p.expires_at <= now()) throw err(410, 'this play expired before it was paid');
    if (db.prepare('SELECT id FROM vault_plays WHERE payment_sig = ?').get(signature)) throw err(409, 'this signature already paid a play');
    db.prepare("UPDATE vault_plays SET payment_sig = ?, status = 'submitted', updated_at = ? WHERE id = ? AND status = 'created'").run(signature, now(), playId);
    return view(db.prepare('SELECT * FROM vault_plays WHERE id = ?').get(playId));
  }

  /** The chain is the witness: finalized + the right payment → draw → deliver. Called every few seconds. */
  async function sweep() {
    const t = now(); const out = { verified: 0, delivered: 0, failed: 0, expired: 0 };
    out.expired = db.prepare("UPDATE vault_plays SET status = 'expired', updated_at = ? WHERE vault = ? AND status = 'created' AND expires_at <= ?").run(t, vaultWallet, t).changes;
    for (const p of db.prepare("SELECT * FROM vault_plays WHERE vault = ? AND status = 'submitted'").all(vaultWallet)) {
      let parsed, st;
      try { [st] = await chain.getSignatureStatuses([p.payment_sig]); parsed = st ? await chain.getParsedTransaction(p.payment_sig) : null; } catch { continue; }
      if (!st || !parsed) { if (p.updated_at + limits.payTtlMs < t) db.prepare("UPDATE vault_plays SET status = 'payment_missing', updated_at = ? WHERE id = ?").run(t, p.id); continue; }
      if (st.confirmationStatus !== 'finalized') continue;
      const v = p.currency === 'token'
        ? readBurnPayment(parsed, { payer: p.player, mint: baseMint, expectedMemo: `play:${p.id}`, minAmountUnits: p.price_tokens * 10 ** baseDecimals })
        : readPayment(parsed, { vaultWallet, usdcMint, expectedMemo: `play:${p.id}`, minAmountUsd: p.price_usdc, payer: p.player });
      if (!v.ok) { db.prepare("UPDATE vault_plays SET status = 'payment_rejected', fail_reason = ?, updated_at = ? WHERE id = ?").run(v.reason, t, p.id); out.failed += 1; continue; }
      out.verified += 1;
      // draw — redraw (nonce + 1) if the drawn item is no longer free; everything recorded
      const snapshot = JSON.parse(p.snapshot_json);
      const free = new Set((await freeItems()).map((it) => it.mint));
      let nonce = 0, result = null;
      for (; nonce <= MAX_REDRAWS; nonce++) { const d = draw({ serverSeed: p.server_seed, playId: p.id, clientSeed: p.client_seed, nonce, snapshot }); if (free.has(d.mint)) { result = d; break; } }
      if (!result) { db.prepare("UPDATE vault_plays SET status = 'delivery_failed', fail_reason = 'no free item left in the band', updated_at = ? WHERE id = ?").run(t, p.id); out.failed += 1; continue; }
      db.prepare("UPDATE vault_plays SET status = 'drawn', mint = ?, digest = ?, draw_index = ?, nonce = ?, updated_at = ? WHERE id = ? AND status = 'submitted'").run(result.mint, result.digest, result.index, nonce, t, p.id);
      try {
        const { sig } = await deliver({ mint: result.mint, toAddress: p.player, onSigned: (b64) => db.prepare("UPDATE vault_plays SET delivery_tx_b64 = ?, status = 'delivering', updated_at = ? WHERE id = ?").run(b64, now(), p.id) });
        db.prepare("UPDATE vault_plays SET status = 'delivered', delivery_sig = ?, updated_at = ? WHERE id = ?").run(sig, now(), p.id);
        out.delivered += 1;
      } catch (e) {
        db.prepare("UPDATE vault_plays SET status = 'delivery_failed', fail_reason = ?, updated_at = ? WHERE id = ?").run(String(e.message).slice(0, 300), now(), p.id);
        out.failed += 1;
      }
    }
    return out;
  }

  function view(p) {
    const done = ['delivered', 'delivery_failed'].includes(p.status);
    return {
      playId: p.id, vault: p.vault, player: p.player, band: p.band, currency: p.currency, status: p.status,
      price: p.currency === 'token' ? p.price_tokens : p.price_usdc, unit: p.currency === 'token' ? 'token' : 'USDC', avgIndexUsd: p.avg_index_usd,
      clientSeed: p.client_seed, serverSeedHash: p.server_seed_hash, serverSeed: done ? p.server_seed : null,
      snapshot: JSON.parse(p.snapshot_json), mint: p.mint || null, digest: p.digest || null, index: p.draw_index ?? null, nonce: p.nonce ?? null,
      paymentSignature: p.payment_sig || null, deliverySignature: p.delivery_sig || null, failReason: p.fail_reason || null,
      at: p.created_at, updatedAt: p.updated_at, expiresAt: p.expires_at,
    };
  }
  function get(playId) { const p = db.prepare('SELECT * FROM vault_plays WHERE id = ?').get(playId); if (!p) throw err(404, 'unknown play'); return view(p); }
  function list({ limit = 50 } = {}) { return db.prepare("SELECT * FROM vault_plays WHERE vault = ? AND status NOT IN ('created','expired') ORDER BY created_at DESC LIMIT ?").all(vaultWallet, limit).map(view); }
  /** Mints a live play has claimed — so reservations never sell them underneath a draw. */
  function busyMints() { return db.prepare("SELECT mint FROM vault_plays WHERE vault = ? AND status IN ('drawn','delivering','delivery_failed')").all(vaultWallet).map((r) => r.mint); }

  return { bands, start, submit, sweep, get, list, busyMints, PLAY: limits };
}

module.exports = { createPlay, PLAY };
