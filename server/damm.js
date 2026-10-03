/**
 * server/damm.js — the Buy door after graduation. Once the curve migrates, its price freezes
 * and the token trades on the Meteora DAMM v2 pool the migration created. This builds the
 * same shape the curve trader builds — a quote, then an unsigned single-signer swap for the
 * user's wallet — against that pool, with Meteora's own `@meteora-ag/cp-amm-sdk`.
 *
 * Why not Jupiter: a pool a few dollars deep is not routed there (measured 2 Oct 2026 with
 * $OT4). The vault's own pool always is. Jupiter becomes a second route later, not a dependency.
 */
'use strict';
const { PublicKey, Transaction } = require('@solana/web3.js');
const BN = require('bn.js');
const { checkSingleSignerUnsigned } = require('./txAssertions');

function err(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }
const bs58 = (() => { const b = require('bs58'); return b.encode ? b : b.default; })();

/**
 * @param {object} deps
 * @param {string} deps.pool               the DAMM v2 pool address
 * @param {string} deps.baseMint           the vault token
 * @param {string} deps.quoteMint          USDC
 * @param {function} deps.getCpAmm         async () => CpAmm (or a fake with fetchPoolState · getQuote · swap)
 * @param {function} deps.getTokenProgram  (flag) => PublicKey  (the SDK's `getTokenProgram`)
 * @param {function} deps.getCurrent       async () => { time, slot }
 */
function createDammTrader({ pool, baseMint, quoteMint, baseDecimals = 6, quoteDecimals = 6, getCpAmm, getTokenProgram, getCurrent, getLatestBlockhash, simulate = null, getBalanceUi = null, referralTokenAccount = null }) {
  const referralPk = referralTokenAccount ? new PublicKey(referralTokenAccount) : null;
  // the referral account holds USDC, so it is only attached when the pool collects its fee in token B = USDC (OnlyB); otherwise nobody
  const referralFor = (st) => (referralPk && Number(st.collectFeeMode) === 1 && st.tokenBMint.equals(quotePk) ? referralPk : null);
  const toUnits = (n, d) => new BN(Math.round(n * 10 ** d).toString());
  const fromUnits = (bn, d) => Number(bn.toString()) / 10 ** d;
  const basePk = new PublicKey(baseMint), quotePk = new PublicKey(quoteMint), poolPk = new PublicKey(pool);

  function check({ side, amount }) {
    if (side !== 'buy' && side !== 'sell') throw err(400, 'side must be buy or sell');
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw err(400, 'amount must be a positive number');
  }

  async function _quote({ side, amount, slippageBps = 100 }) {
    const cp = await getCpAmm();
    const st = await cp.fetchPoolState(poolPk);
    const sell = side === 'sell';
    const inMint = sell ? basePk : quotePk, outMint = sell ? quotePk : basePk;
    const amountIn = toUnits(amount, sell ? baseDecimals : quoteDecimals);
    const { time, slot } = await getCurrent();
    // decimals in the pool's own A/B order (the mints sort; USDC is not always B)
    const aIsBase = st.tokenAMint.equals(basePk);
    const ref = referralFor(st);
    const q = cp.getQuote({ inAmount: amountIn, inputTokenMint: inMint, slippage: slippageBps, poolState: st, currentTime: time, currentSlot: slot, tokenADecimal: aIsBase ? baseDecimals : quoteDecimals, tokenBDecimal: aIsBase ? quoteDecimals : baseDecimals, hasReferral: Boolean(ref) });
    const outDec = sell ? quoteDecimals : baseDecimals;
    // the fee is charged in the quote token for USDC-paired pools (collectFeeMode 0) — shown in USDC when it is; otherwise in the input unit, said so
    const feeUnits = Number(q.totalFee.toString());
    const feeUsd = sell ? feeUnits / 10 ** quoteDecimals : feeUnits / 10 ** quoteDecimals;
    return {
      raw: { amountIn, minimumAmountOut: q.minSwapOutAmount, st, inMint, outMint, ref },
      view: {
        side, venue: 'pool', amountIn: amount, amountInUsed: amount, amountInLeft: 0, partial: false,
        amountOut: fromUnits(q.swapOutAmount, outDec), minimumAmountOut: fromUnits(q.minSwapOutAmount, outDec),
        tradingFeeUsd: feeUsd, protocolFeeUsd: 0, priceImpactPct: Number(q.priceImpact.toString()),
        slippageBps, unitIn: sell ? 'token' : 'USDC', unitOut: sell ? 'USDC' : 'token', referral: ref ? ref.toBase58() : null,
      },
    };
  }

  async function quote(args) { check(args); return (await _quote(args)).view; }

  async function build({ owner, side, amount, slippageBps = 100 }) {
    check({ side, amount });
    let ownerPk; try { ownerPk = new PublicKey(owner); } catch { throw err(400, 'owner must be a wallet address'); }
    const { raw, view } = await _quote({ side, amount, slippageBps });
    const cp = await getCpAmm();
    const st = raw.st;
    const tx = await cp.swap({
      payer: ownerPk, pool: poolPk, inputTokenMint: raw.inMint, outputTokenMint: raw.outMint, amountIn: raw.amountIn, minimumAmountOut: raw.minimumAmountOut,
      tokenAMint: st.tokenAMint, tokenBMint: st.tokenBMint, tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault,
      tokenAProgram: getTokenProgram(st.tokenAFlag), tokenBProgram: getTokenProgram(st.tokenBFlag), referralTokenAccount: raw.ref, poolState: st,
    });
    tx.feePayer = ownerPk;
    tx.recentBlockhash = await getLatestBlockhash();
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const compiled = Transaction.from(bytes);
    const fail = checkSingleSignerUnsigned(compiled, owner);
    if (fail) throw new Error(`swap tx does not pass assertions: ${fail.assertion} (${fail.message})`);
    if (simulate) {
      const sim = await simulate(bytes.toString('base64'));
      if (sim && sim.err) {
        const logs = (sim.logs || []).join(' | ');
        if (/insufficient funds/i.test(logs) || /"Custom":1/.test(JSON.stringify(sim.err))) {
          const unit = side === 'sell' ? 'tokens' : 'USDC';
          const has = getBalanceUi ? await getBalanceUi(owner, side === 'sell' ? baseMint : quoteMint).catch(() => null) : null;
          const fmt = (n) => (n == null ? 'an unknown amount' : (side === 'sell' ? n.toLocaleString('en-US') : '$' + n.toFixed(2)));
          throw err(402, `this wallet needs ${side === 'sell' ? amount.toLocaleString('en-US') : '$' + amount.toFixed(2)} ${unit} for this trade and has ${fmt(has)}. Nothing was sent.`);
        }
        throw err(409, `the trade would fail on chain: ${JSON.stringify(sim.err)} · ${(sim.logs || []).filter((l) => /log:/.test(l)).slice(-2).join(' | ')}`);
      }
    }
    return { quote: view, transaction: bytes.toString('base64'), message: bs58.encode(compiled.serializeMessage()) };
  }

  async function balances(owner) {
    try { new PublicKey(owner); } catch { throw err(400, 'owner must be a wallet address'); }
    if (!getBalanceUi) return { usdc: null, token: null };
    const [usdc, token] = await Promise.all([getBalanceUi(owner, quoteMint).catch(() => null), getBalanceUi(owner, baseMint).catch(() => null)]);
    return { usdc, token };
  }

  return { quote, build, balances };
}

/**
 * One trader for the whole life of a token: the curve while it is live, the graduated pool
 * once it migrated. `whereToTrade()` answers { venue: 'curve' | 'pool', pool } from the stats
 * (which already read the migration flag and derive the DAMM address).
 */
function createRoutedTrader({ curve, makeDamm, whereToTrade }) {
  let damm = null, dammFor = null;
  async function pick() {
    const w = await whereToTrade();
    if (w.venue === 'pool' && w.pool) {
      if (!damm || dammFor !== w.pool) { damm = makeDamm(w.pool); dammFor = w.pool; }
      return damm;
    }
    if (!curve) throw err(409, 'token not launched — there is no pool to trade on yet');
    return curve;
  }
  return {
    quote: async (a) => (await pick()).quote(a),
    build: async (a) => (await pick()).build(a),
    balances: async (o) => (await pick()).balances(o),
    venue: async () => (await whereToTrade()).venue,
  };
}

/** Production deps: the cp-amm SDK over our RPC. */
function productionDammDeps({ rpcUrl, chain }) {
  let cp = null, sdk = null, conn = null;
  const load = () => { if (!sdk) { sdk = require('@meteora-ag/cp-amm-sdk'); const { Connection } = require('@solana/web3.js'); conn = new Connection(rpcUrl, 'confirmed'); cp = new sdk.CpAmm(conn); } };
  return {
    getCpAmm: async () => { load(); return cp; },
    getTokenProgram: (flag) => { load(); return sdk.getTokenProgram(flag); },
    getCurrent: async () => { load(); const slot = await conn.getSlot('confirmed'); return { time: Math.floor(Date.now() / 1000), slot }; },
    getLatestBlockhash: () => chain.getLatestBlockhash(),
    simulate: (b64) => chain.simulateTransaction(b64),
    getBalanceUi: async (owner, mint) => {
      if (!mint) return null;
      const r = await chain.rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]);
      return (r.value || []).reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
    },
  };
}

module.exports = { createDammTrader, createRoutedTrader, productionDammDeps };
