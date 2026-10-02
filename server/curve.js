/**
 * server/curve.js — the Buy door. Quotes on the live pool state and builds the swap
 * transaction for the USER'S wallet to sign. The server never signs here: the result is
 * an unsigned transaction with a single signer (the user), no pre-signed accounts, and
 * the serialized message Phantom's `signAndSendTransaction` takes — so the wallet
 * simulates and sends it itself (the only shape that never trips its warnings).
 *
 * Quote and swap come from Meteora's own SDK (`@meteora-ag/dynamic-bonding-curve-sdk`);
 * this file only converts units and asserts the shape.
 */
'use strict';
const { PublicKey, Transaction } = require('@solana/web3.js');
const BN = require('bn.js');
const { checkSingleSignerUnsigned } = require('./txAssertions');

function err(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }
const bs58 = (() => { const b = require('bs58'); return b.encode ? b : b.default; })();

/**
 * @param {object} deps
 * @param {string|null} deps.pool            the DBC pool address (null until launch)
 * @param {function} deps.getClient          async () => DynamicBondingCurveClient (or a fake)
 * @param {function} deps.getCurrentPoint    async () => BN (slot or timestamp, per the config's activationType)
 * @param {function} deps.getLatestBlockhash async () => string
 */
function createCurveTrader({ pool, baseDecimals = 6, quoteDecimals = 6, getClient, getCurrentPoint, getLatestBlockhash, simulate = null, getBalanceUi = null, quoteMint = null, baseMint = null }) {
  const toUnits = (n, d) => new BN(Math.round(n * 10 ** d).toString());
  const fromUnits = (bn, d) => Number(bn.toString()) / 10 ** d;

  function check({ side, amount }) {
    if (!pool) throw err(409, 'token not launched — there is no pool to trade on yet');
    if (side !== 'buy' && side !== 'sell') throw err(400, 'side must be buy or sell');
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw err(400, 'amount must be a positive number');
  }

  async function _quote({ side, amount, slippageBps = 100 }) {
    const client = await getClient();
    const poolPk = new PublicKey(pool);
    const vp = await client.state.getPool(poolPk);
    const cfg = await client.state.getPoolConfig(vp.poolState ? vp.poolState.config : vp.config);
    const sell = side === 'sell';
    const amountIn = toUnits(amount, sell ? baseDecimals : quoteDecimals);
    const common = { virtualPool: vp, config: cfg, swapBaseForQuote: sell, slippageBps, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: await getCurrentPoint(cfg) };
    // a BUY fills partially: whatever the curve still takes before graduation is taken, the rest stays with the
    // buyer (nobody has to guess the room left — measured 2 Oct 2026: $0.23 refused with $0.20 to go)
    const partial = !sell && typeof client.pool.swapQuote2 === 'function';
    const q = partial ? client.pool.swapQuote2({ ...common, swapMode: 1 /* PartialFill */, amountIn }) : client.pool.swapQuote({ ...common, amountIn });
    const outDec = sell ? quoteDecimals : baseDecimals;
    const used = partial && q.includedFeeInputAmount ? q.includedFeeInputAmount : amountIn;
    const left = partial && q.amountLeft ? q.amountLeft : new BN(0);
    return {
      raw: { amountIn, minimumAmountOut: q.minimumAmountOut, poolPk, partial },
      view: {
        side, amountIn: amount, amountInUsed: fromUnits(used, sell ? baseDecimals : quoteDecimals), amountInLeft: fromUnits(left, sell ? baseDecimals : quoteDecimals), partial: !left.isZero(),
        amountOut: fromUnits(q.outputAmount, outDec), minimumAmountOut: fromUnits(q.minimumAmountOut, outDec),
        tradingFeeUsd: fromUnits(q.tradingFee, quoteDecimals), protocolFeeUsd: fromUnits(q.protocolFee, quoteDecimals),
        slippageBps, unitIn: sell ? 'token' : 'USDC', unitOut: sell ? 'USDC' : 'token',
      },
    };
  }

  async function quote(args) { check(args); return (await _quote(args)).view; }

  async function build({ owner, side, amount, slippageBps = 100 }) {
    check({ side, amount });
    let ownerPk; try { ownerPk = new PublicKey(owner); } catch { throw err(400, 'owner must be a wallet address'); }
    const { raw, view } = await _quote({ side, amount, slippageBps });
    const client = await getClient();
    const tx = raw.partial
      ? await client.pool.swap2({ owner: ownerPk, pool: raw.poolPk, swapMode: 1 /* PartialFill */, amountIn: raw.amountIn, minimumAmountOut: raw.minimumAmountOut, swapBaseForQuote: false, referralTokenAccount: null })
      : await client.pool.swap({ owner: ownerPk, pool: raw.poolPk, amountIn: raw.amountIn, minimumAmountOut: raw.minimumAmountOut, swapBaseForQuote: side === 'sell', referralTokenAccount: null });
    tx.feePayer = ownerPk;
    tx.recentBlockhash = await getLatestBlockhash();
    // compile first (signatures are derived at compile time), then assert on what we send
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const compiled = Transaction.from(bytes);
    const fail = checkSingleSignerUnsigned(compiled, owner);
    if (fail) throw new Error(`swap tx does not pass assertions: ${fail.assertion} (${fail.message})`);
    // PRE-FLIGHT, before the wallet ever sees it: a swap that fails simulation makes Phantom
    // block the dApp as "possibly malicious" (1 Oct 2026: the buyer had 0 USDC → 0x1). The
    // honest answer is the two numbers, here, as a 402 — never a red screen in the wallet.
    if (simulate) {
      const sim = await simulate(bytes.toString('base64'));
      if (sim && sim.err) {
        const logs = (sim.logs || []).join(' | ');
        if (/insufficient funds/i.test(logs) || /"Custom":1/.test(JSON.stringify(sim.err))) {
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

  /** What a wallet holds of the pair — so the panel can show a balance and a Max, and say "you hold X" instead of the curve's raw error. */
  async function balances(owner) {
    try { new PublicKey(owner); } catch { throw err(400, 'owner must be a wallet address'); }
    if (!getBalanceUi) return { usdc: null, token: null };
    const [usdc, token] = await Promise.all([getBalanceUi(owner, quoteMint).catch(() => null), getBalanceUi(owner, baseMint).catch(() => null)]);
    return { usdc, token };
  }

  return { quote, build, balances };
}

/** Production deps: the SDK over our RPC. */
function productionCurveDeps({ rpcUrl, chain }) {
  let client = null, conn = null, sdk = null;
  const load = () => { if (!sdk) { sdk = require('@meteora-ag/dynamic-bonding-curve-sdk'); const { Connection } = require('@solana/web3.js'); conn = new Connection(rpcUrl, 'confirmed'); client = sdk.DynamicBondingCurveClient.create(conn, 'confirmed'); } };
  return {
    getClient: async () => { load(); return client; },
    // The SDK asks the block time of the newest slot; the RPC sometimes does not have it yet
    // ("Block not available for slot N"). For a timestamp-activated curve the wall clock is
    // the same number; for a slot-activated one the slot itself is.
    getCurrentPoint: async (cfg) => {
      load();
      try { return await sdk.getCurrentPoint(conn, cfg.activationType); }
      catch (e) {
        const BN = require('bn.js');
        if (Number(cfg.activationType) === 1) return new BN(Math.floor(Date.now() / 1000));
        return new BN(await conn.getSlot('confirmed'));
      }
    },
    getLatestBlockhash: () => chain.getLatestBlockhash(),
    simulate: (b64) => chain.simulateTransaction(b64),
    getBalanceUi: async (owner, mint) => {
      if (!mint) return null;
      const r = await chain.rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]);
      return (r.value || []).reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
    },
  };
}

module.exports = { createCurveTrader, productionCurveDeps };
