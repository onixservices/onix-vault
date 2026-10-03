const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction, SystemProgram, PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');
const { createDammTrader, createRoutedTrader } = require('./damm');

// After graduation the same door (quote → unsigned single-signer swap) is built against the
// DAMM v2 pool with the cp-amm SDK. The fake mirrors the SDK's shapes: pool state with A/B
// mints in the pool's own order, getQuote with min out after slippage, swap → Transaction.
const OWNER = Keypair.generate().publicKey.toBase58();
const POOL = Keypair.generate().publicKey.toBase58();
const BASE = Keypair.generate().publicKey.toBase58();
const USDC = Keypair.generate().publicKey.toBase58();
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

function fakeCp({ aIsBase = true } = {}) {
  const calls = [];
  const st = {
    tokenAMint: new PublicKey(aIsBase ? BASE : USDC), tokenBMint: new PublicKey(aIsBase ? USDC : BASE),
    tokenAVault: Keypair.generate().publicKey, tokenBVault: Keypair.generate().publicKey, tokenAFlag: 0, tokenBFlag: 0, activationType: 1,
  };
  const cp = {
    fetchPoolState: async (p) => { calls.push(['state', p.toBase58()]); return st; },
    // $1 buys 1,000 tokens; 1,000 tokens sell for $0.90 (a 10% spread stands in for price impact)
    getQuote: (a) => {
      calls.push(['quote', a]);
      const inAmt = BigInt(a.inAmount.toString());
      const toBase = a.inputTokenMint.toBase58() === USDC;
      const out = toBase ? inAmt * 1000n : inAmt * 9n / 10000n;
      return { swapInAmount: a.inAmount, consumedInAmount: a.inAmount, swapOutAmount: new BN(out.toString()), minSwapOutAmount: new BN((out * BigInt(10000 - a.slippage) / 10000n).toString()), totalFee: new BN(10_000), priceImpact: { toString: () => '0.42' } };
    },
    swap: async (a) => { calls.push(['swap', a]); const tx = new Transaction(); tx.add(SystemProgram.transfer({ fromPubkey: a.payer, toPubkey: new PublicKey(POOL), lamports: 1 })); return tx; },
  };
  return { cp, calls, st };
}
const deps = (f, extra = {}) => ({ pool: POOL, baseMint: BASE, quoteMint: USDC, getCpAmm: async () => f.cp, getTokenProgram: () => TOKEN_PROGRAM, getCurrent: async () => ({ time: 1_700_000_000, slot: 1 }),
  getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(), simulate: async () => ({ err: null, logs: [] }), getBalanceUi: async () => 100, ...extra });

describe('damm — quote', () => {
  test('buy: USDC in → tokens out, decimals mapped to the pool\'s A/B order, slippage in bps, venue says pool', async () => {
    const f = fakeCp();
    const q = await createDammTrader(deps(f)).quote({ side: 'buy', amount: 10 });
    assert.equal(q.venue, 'pool'); assert.equal(q.amountOut, 10_000); assert.equal(q.minimumAmountOut, 9_900); assert.equal(q.priceImpactPct, 0.42); assert.equal(q.partial, false);
    const a = f.calls.find((c) => c[0] === 'quote')[1];
    assert.equal(a.inputTokenMint.toBase58(), USDC); assert.equal(a.slippage, 100); assert.equal(a.inAmount.toString(), '10000000'); assert.equal(a.tokenADecimal, 6); assert.equal(a.currentTime, 1_700_000_000);
  });
  test('sell: tokens in → USDC out; works when USDC is token A', async () => {
    const f = fakeCp({ aIsBase: false });
    const q = await createDammTrader(deps(f)).quote({ side: 'sell', amount: 1000 });
    assert.equal(q.amountOut, 0.9); assert.equal(q.unitOut, 'USDC');
    assert.equal(f.calls.find((c) => c[0] === 'quote')[1].inputTokenMint.toBase58(), BASE);
  });
  test('bad input is refused with 400', async () => {
    const t = createDammTrader(deps(fakeCp()));
    for (const bad of [{ side: 'buy', amount: 0 }, { side: 'hold', amount: 1 }, { side: 'sell', amount: NaN }]) await assert.rejects(t.quote(bad), (e) => e.statusCode === 400);
  });
});

describe('damm — build', () => {
  test('an unsigned transaction with the user as the only signer, the pool\'s mints/vaults/programs passed to the SDK, simulated first', async () => {
    const f = fakeCp();
    const sims = [];
    const b = await createDammTrader(deps(f, { simulate: async (b64) => { sims.push(b64); return { err: null }; } })).build({ owner: OWNER, side: 'buy', amount: 5 });
    const tx = Transaction.from(Buffer.from(b.transaction, 'base64'));
    assert.equal(tx.feePayer.toBase58(), OWNER);
    assert.equal(tx.signatures.length, 1); assert.equal(tx.signatures[0].publicKey.toBase58(), OWNER); assert.equal(tx.signatures[0].signature, null);
    assert.equal(sims.length, 1); assert.equal(b.quote.venue, 'pool');
    const s = f.calls.find((c) => c[0] === 'swap')[1];
    assert.equal(s.tokenAMint.toBase58(), f.st.tokenAMint.toBase58()); assert.equal(s.tokenAVault.toBase58(), f.st.tokenAVault.toBase58()); assert.equal(s.tokenAProgram.toBase58(), TOKEN_PROGRAM.toBase58());
    assert.equal(s.inputTokenMint.toBase58(), USDC); assert.equal(s.outputTokenMint.toBase58(), BASE); assert.equal(s.referralTokenAccount, null);
  });
  test('a swap that would fail for lack of funds is a 402 with the two numbers, never sent', async () => {
    const f = fakeCp();
    const t = createDammTrader(deps(f, { simulate: async () => ({ err: { InstructionError: [0, { Custom: 1 }] }, logs: ['Program log: Error: insufficient funds'] }), getBalanceUi: async () => 0.5 }));
    await assert.rejects(t.build({ owner: OWNER, side: 'buy', amount: 5 }), (e) => e.statusCode === 402 && /needs \$5\.00 USDC .* has \$0\.50/.test(e.message));
  });
  test('owner must be a wallet address', async () => {
    await assert.rejects(createDammTrader(deps(fakeCp())).build({ owner: 'nope', side: 'buy', amount: 1 }), (e) => e.statusCode === 400);
  });
});

describe('damm — the referral', () => {
  test('attached only when the pool collects its fee in token B = USDC (OnlyB); the quote says hasReferral; otherwise nobody', async () => {
    const REF = Keypair.generate().publicKey.toBase58();
    const f = fakeCp(); f.st.collectFeeMode = 1;
    const b = await createDammTrader(deps(f, { referralTokenAccount: REF })).build({ owner: OWNER, side: 'buy', amount: 1 });
    assert.equal(b.quote.referral, REF); assert.equal(f.calls.find((c) => c[0] === 'quote')[1].hasReferral, true); assert.equal(f.calls.find((c) => c[0] === 'swap')[1].referralTokenAccount.toBase58(), REF);
    const g = fakeCp(); g.st.collectFeeMode = 0;   // BothToken: the fee may be in the vault token → no referral in USDC
    const b2 = await createDammTrader(deps(g, { referralTokenAccount: REF })).build({ owner: OWNER, side: 'buy', amount: 1 });
    assert.equal(b2.quote.referral, null); assert.equal(g.calls.find((c) => c[0] === 'swap')[1].referralTokenAccount, null);
    const h = fakeCp({ aIsBase: false }); h.st.collectFeeMode = 1;   // OnlyB but B is the vault token → no referral
    assert.equal((await createDammTrader(deps(h, { referralTokenAccount: REF })).quote({ side: 'buy', amount: 1 })).referral, null);
  });
});

describe('routed trader — the curve while live, the pool once migrated', () => {
  test('routes by the stats; the pool trader is built once per pool address', async () => {
    let where = { venue: 'curve', pool: null }, made = [];
    const curve = { quote: async () => ({ venue: 'curve' }), build: async () => ({ v: 'curve' }), balances: async () => ({ usdc: 1, token: 2 }) };
    const r = createRoutedTrader({ curve, makeDamm: (p) => { made.push(p); return { quote: async () => ({ venue: 'pool', p }), build: async () => ({ v: 'pool' }), balances: async () => ({ usdc: 3, token: 4 }) }; }, whereToTrade: async () => where });
    assert.equal((await r.quote({})).venue, 'curve'); assert.equal(await r.venue(), 'curve');
    where = { venue: 'pool', pool: 'DAMM1' };
    assert.equal((await r.quote({})).venue, 'pool'); assert.equal((await r.build({})).v, 'pool'); assert.deepEqual(await r.balances('x'), { usdc: 3, token: 4 });
    await r.quote({});
    assert.deepEqual(made, ['DAMM1']);
  });
  test('migrated but the pool address is not readable yet → falls back to the curve (which refuses with its own reason)', async () => {
    const r = createRoutedTrader({ curve: null, makeDamm: () => ({}), whereToTrade: async () => ({ venue: 'pool', pool: null }) });
    await assert.rejects(r.quote({}), (e) => e.statusCode === 409);
  });
});
