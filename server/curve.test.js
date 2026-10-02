const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction, SystemProgram, PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');
const { createCurveTrader } = require('./curve');

// The Buy door: the server QUOTES on the pool state and BUILDS the swap for the user's
// wallet to sign; it never signs. Single unsigned signer = the user. Nothing else.
const OWNER = Keypair.generate().publicKey.toBase58();
const POOL = Keypair.generate().publicKey.toBase58();

function fakeClient({ outBase = 1_000_000n, outQuote = 4_000_000n } = {}) {
  const calls = [];
  const client = {
    state: { getPool: async () => ({ poolState: { tag: 'pool' } }), getPoolConfig: async () => ({ activationType: 0 }) },
    pool: {
      swapQuote: (args) => { calls.push(['quote', args]); const out = args.swapBaseForQuote ? outQuote : outBase; return { outputAmount: new BN(out.toString()), minimumAmountOut: new BN((out * 99n / 100n).toString()), tradingFee: new BN(400_000), protocolFee: new BN(100_000) }; },
      swap: async (args) => {
        calls.push(['swap', args]);
        const tx = new Transaction();
        tx.add(SystemProgram.transfer({ fromPubkey: args.owner, toPubkey: new PublicKey(POOL), lamports: 1 }));
        return tx;
      },
    },
  };
  return { client, calls };
}
const deps = (fc, extra = {}) => ({ pool: POOL, baseDecimals: 6, quoteDecimals: 6, getClient: async () => fc.client, getCurrentPoint: async () => new BN(1), getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(),
  simulate: async () => ({ err: null, logs: [] }), getBalanceUi: async () => 100, ...extra });

describe('curve — quote', () => {
  test('buy: USDC in → tokens out, fees in USDC, both legs in human units', async () => {
    const fc = fakeClient();
    const t = createCurveTrader(deps(fc));
    const q = await t.quote({ side: 'buy', amount: 10 });
    assert.equal(q.side, 'buy'); assert.equal(q.amountIn, 10); assert.equal(q.amountOut, 1); assert.equal(q.minimumAmountOut, 0.99);
    assert.equal(q.tradingFeeUsd, 0.4); assert.equal(q.protocolFeeUsd, 0.1);
    assert.equal(fc.calls[0][1].swapBaseForQuote, false); assert.equal(fc.calls[0][1].amountIn.toString(), '10000000');
  });
  test('sell: tokens in → USDC out', async () => {
    const fc = fakeClient();
    const t = createCurveTrader(deps(fc));
    const q = await t.quote({ side: 'sell', amount: 2.5 });
    assert.equal(q.amountOut, 4); assert.equal(fc.calls[0][1].swapBaseForQuote, true); assert.equal(fc.calls[0][1].amountIn.toString(), '2500000');
  });
  test('bad input is refused with 400; no pool → 409 "not launched"', async () => {
    const fc = fakeClient();
    const t = createCurveTrader(deps(fc));
    for (const bad of [{ side: 'buy', amount: 0 }, { side: 'buy', amount: -1 }, { side: 'hold', amount: 1 }, { side: 'buy', amount: 'x' }]) {
      await assert.rejects(t.quote(bad), (e) => e.statusCode === 400);
    }
    const none = createCurveTrader({ ...deps(fc), pool: null });
    await assert.rejects(none.quote({ side: 'buy', amount: 1 }), (e) => e.statusCode === 409 && /not launched/.test(e.message));
  });
});

describe('curve — build', () => {
  test('returns the unsigned swap for the owner: fee payer = owner, single signer, nothing pre-signed, blockhash set; plus the message for Phantom', async () => {
    const fc = fakeClient();
    const t = createCurveTrader(deps(fc));
    const out = await t.build({ owner: OWNER, side: 'buy', amount: 10, slippageBps: 100 });
    const tx = Transaction.from(Buffer.from(out.transaction, 'base64'));
    assert.equal(tx.feePayer.toBase58(), OWNER);
    assert.equal(tx.signatures.length, 1); assert.equal(tx.signatures[0].publicKey.toBase58(), OWNER); assert.equal(tx.signatures[0].signature, null);
    assert.ok(tx.recentBlockhash);
    assert.equal(typeof out.message, 'string'); assert.ok(out.message.length > 40);
    assert.equal(out.quote.amountOut, 1);
    assert.equal(fc.calls.find((c) => c[0] === 'swap')[1].minimumAmountOut.toString(), '990000');
  });
  test('pre-flight: a swap that would fail (no USDC) is refused with 402 and BOTH numbers — the wallet never sees it', async () => {
    const t = createCurveTrader(deps(fakeClient(), { simulate: async () => ({ err: { InstructionError: [1, { Custom: 1 }] }, logs: ['Program log: Error: insufficient funds'] }), getBalanceUi: async () => 0 }));
    await assert.rejects(t.build({ owner: OWNER, side: 'buy', amount: 10 }), (e) => e.statusCode === 402 && /needs \$10\.00 USDC/.test(e.message) && /has \$0\.00/.test(e.message));
  });
  test('pre-flight: any other simulation failure is refused with 409 and the program log, never handed to the wallet', async () => {
    const t = createCurveTrader(deps(fakeClient(), { simulate: async () => ({ err: { InstructionError: [1, { Custom: 6001 }] }, logs: ['Program log: slippage'] }) }));
    await assert.rejects(t.build({ owner: OWNER, side: 'buy', amount: 10 }), (e) => e.statusCode === 409 && /slippage/.test(e.message));
  });
  test('owner must be a public key', async () => {
    const t = createCurveTrader(deps(fakeClient()));
    await assert.rejects(t.build({ owner: 'nope', side: 'buy', amount: 1 }), (e) => e.statusCode === 400);
  });
});
