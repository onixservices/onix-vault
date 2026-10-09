const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const BN = require('bn.js');
const { Keypair, Transaction, SystemProgram, TransactionInstruction } = require('@solana/web3.js');
const { getTestDb } = require('./db');
const { createGraduation, GRADUATION } = require('./graduation');
const { fromKeypair } = require('./signer');

// The vault graduates itself: when the curve is full the server runs the four steps the operator ran by hand
// (locker → migrate → migration fee → leftover), once per vault, each one simulated before it is signed.
const custodyKp = Keypair.generate(), payerKp = Keypair.generate();
const CUSTODY = custodyKp.publicKey.toBase58();
const POOL = Keypair.generate().publicKey.toBase58();
const CONFIG = Keypair.generate().publicKey;
const DAMM_CFG = Keypair.generate().publicKey;
const T0 = 1_800_000_000_000;

function make({ raised = 140_175_247, threshold = 140_175_247, migrated = false, failAt = null, refuseLocker = false } = {}) {
  const db = getTestDb();
  const state = { migrated, calls: [], sent: [], simulated: [], clock: T0 };
  const transfer = (from) => SystemProgram.transfer({ fromPubkey: from, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  const chain = {
    getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(),
    simulateTransaction: async (b64) => { const step = state.calls[state.calls.length - 1]; state.simulated.push(step); return failAt === step ? { err: { InstructionError: [0, { Custom: 6002 }] }, logs: ['Program log: Error Code: NotPermitToDoThisAction'] } : { err: null, logs: [] }; },
    sendRawTransaction: async (b64) => { const step = state.calls[state.calls.length - 1]; state.sent.push({ step, b64 }); if (step === 'migrate') state.migrated = true; return `sig-${step}-${state.sent.length}`; },
    waitForSignature: async () => ({ confirmationStatus: 'finalized' }),
  };
  const client = {
    state: {
      getPool: async () => ({ poolState: { config: CONFIG, quoteReserve: new BN(raised), isMigrated: state.migrated } }),
      getPoolConfig: async () => ({ migrationQuoteThreshold: new BN(threshold), migrationFeeOption: 2, feeClaimer: custodyKp.publicKey }),
    },
    migration: {
      createLocker: async ({ payer }) => { state.calls.push('locker'); if (refuseLocker) throw new Error('locker already exists'); return new Transaction().add(transfer(payer)); },
      migrateToDammV2: async ({ payer, dammConfig }) => {
        state.calls.push('migrate'); assert.equal(dammConfig.toBase58(), DAMM_CFG.toBase58());
        const nft1 = Keypair.generate(), nft2 = Keypair.generate();
        const tx = new Transaction().add(transfer(payer)).add(new TransactionInstruction({ programId: SystemProgram.programId, data: Buffer.alloc(0), keys: [{ pubkey: nft1.publicKey, isSigner: true, isWritable: true }, { pubkey: nft2.publicKey, isSigner: true, isWritable: true }] }));
        return { transaction: tx, firstPositionNftKeypair: nft1, secondPositionNftKeypair: nft2 };
      },
      withdrawLeftover: async ({ payer }) => { state.calls.push('leftover'); return new Transaction().add(transfer(payer)); },
    },
    partner: { partnerWithdrawMigrationFee: async ({ sender }) => { state.calls.push('fee'); return new Transaction().add(transfer(sender)); } },
  };
  const g = createGraduation({
    db, chain, vaultWallet: CUSTODY, pool: POOL, signer: fromKeypair(custodyKp), payer: fromKeypair(payerKp),
    getClient: async () => client, dammConfigFor: (opt) => (opt === 2 ? DAMM_CFG : null), now: () => state.clock, log: { warn: () => {}, log: () => {} },
  });
  const signersOf = (b64) => Transaction.from(Buffer.from(b64, 'base64')).signatures.map((s) => ({ key: s.publicKey.toBase58(), signed: Boolean(s.signature) }));
  return { g, db, state, signersOf };
}

describe('graduation — plan', () => {
  test('a curve short of its threshold is not ready and says how far; a full one is ready; a migrated one is done', async () => {
    const short = await make({ raised: 100_000_000 }).g.plan();
    assert.equal(short.ready, false); assert.match(short.why, /\$100 of \$140\.18/);
    const full = await make().g.plan();
    assert.equal(full.ready, true); assert.equal(full.raisedUsd, 140.175247); assert.equal(full.migrationFeeOption, 2);
    const done = await make({ migrated: true }).g.plan();
    assert.equal(done.ready, false); assert.match(done.why, /already migrated/);
  });
  test('without a pool there is nothing to graduate', async () => {
    const g = createGraduation({ db: getTestDb(), chain: {}, vaultWallet: CUSTODY, pool: null, signer: fromKeypair(custodyKp), payer: fromKeypair(payerKp), getClient: async () => { throw new Error('never'); }, dammConfigFor: () => null });
    assert.deepEqual(await g.plan(), { ready: false, why: 'no pool' });
    assert.equal((await g.execute({ go: true })).graduated, null);
  });
});

describe('graduation — execute', () => {
  test('dry: the locker and the migration are simulated, nothing is signed, sent or written', async () => {
    const { g, db, state } = make();
    const r = await g.execute();
    assert.equal(r.dry, true); assert.deepEqual(r.simulated, ['locker', 'migrate']);
    assert.deepEqual(state.sent, []); assert.equal(db.prepare('SELECT COUNT(*) n FROM vault_graduations').get().n, 0);
  });
  test('go: locker, migrate, fee, leftover in order; the payer signs the first two (the migration with its two position NFTs), the custody the last two; the record is done with four signatures; a second run does nothing', async () => {
    const { g, state, signersOf } = make();
    const r = await g.execute({ go: true });
    assert.deepEqual(state.sent.map((s) => s.step), ['locker', 'migrate', 'fee', 'leftover']);
    assert.deepEqual(state.simulated, ['locker', 'migrate', 'fee', 'leftover']);
    const [locker, migrate, fee, leftover] = state.sent.map((s) => signersOf(s.b64));
    assert.deepEqual(locker.map((s) => s.key), [payerKp.publicKey.toBase58()]); assert.ok(locker.every((s) => s.signed));
    assert.equal(migrate.length, 3); assert.equal(migrate[0].key, payerKp.publicKey.toBase58()); assert.ok(migrate.every((s) => s.signed));
    assert.deepEqual(fee.map((s) => s.key), [CUSTODY]); assert.deepEqual(leftover.map((s) => s.key), [CUSTODY]);
    assert.equal(r.graduated.signatures.migrate, 'sig-migrate-2'); assert.equal(r.graduated.signatures.leftover, 'sig-leftover-4');
    const [rec] = g.list();
    assert.equal(rec.status, 'done'); assert.equal(rec.raisedUsd, 140.175247); assert.equal(rec.signatures.fee, 'sig-fee-3'); assert.equal(rec.attempts, 1);
    const again = await g.execute({ go: true });
    assert.equal(again.graduated, null); assert.match(again.why, /graduated/); assert.equal(state.sent.length, 4);
  });
  test('a locker the program refuses does not stop the migration; the record says the locker step was skipped', async () => {
    const { g, state } = make({ refuseLocker: true });
    const r = await g.execute({ go: true });
    assert.deepEqual(state.sent.map((s) => s.step), ['migrate', 'fee', 'leftover']);
    assert.equal(r.graduated.signatures.locker, null); assert.match(r.graduated.skipped.locker, /already exists/);
    assert.equal(g.list()[0].status, 'done');
  });
  test('a migration that would fail on chain stops the run: the record is failed with the reason, nothing after it is sent, and it is retried only after the cooldown', async () => {
    const { g, state } = make({ failAt: 'migrate' });
    const r = await g.execute({ go: true });
    assert.equal(r.graduated, null); assert.match(r.failed, /migrate would fail on chain/); assert.match(r.failed, /NotPermitToDoThisAction/);
    assert.deepEqual(state.sent.map((s) => s.step), ['locker']);
    let [rec] = g.list(); assert.equal(rec.status, 'failed'); assert.equal(rec.step, 'migrate'); assert.equal(rec.attempts, 1);
    const soon = await g.execute({ go: true });
    assert.equal(soon.graduated, null); assert.match(soon.why, /retry in/); assert.equal(state.sent.length, 1);
    state.clock = T0 + GRADUATION.retryAfterMs + 1;
    const later = await g.execute({ go: true });
    assert.equal(later.graduated, null); [rec] = g.list(); assert.equal(rec.attempts, 2);
  });
  test('after the attempts are spent it waits for a human', async () => {
    const { g, state } = make({ failAt: 'migrate' });
    for (let i = 0; i < GRADUATION.maxAttempts; i++) { await g.execute({ go: true }); state.clock += GRADUATION.retryAfterMs + 1; }
    const r = await g.execute({ go: true });
    assert.match(r.why, /needs a human/); assert.equal(g.list()[0].attempts, GRADUATION.maxAttempts);
  });
  test('a failed record whose pool migrated meanwhile (the script finished it) is marked done', async () => {
    const { g, state } = make({ failAt: 'migrate' });
    await g.execute({ go: true });
    state.migrated = true; state.clock += GRADUATION.retryAfterMs + 1;
    const r = await g.execute({ go: true });
    assert.equal(r.graduated, null); assert.match(r.why, /already migrated/); assert.equal(g.list()[0].status, 'done');
  });
  test('two runs at once: the second is skipped while the first is in flight', async () => {
    const { g, state } = make();
    const [a, b] = await Promise.all([g.execute({ go: true }), g.execute({ go: true })]);
    assert.ok(a.graduated || b.graduated); assert.ok(a.skipped === 'running' || b.skipped === 'running');
    assert.equal(state.sent.length, 4);
  });
  test('list(): what the Activity tab shows', async () => {
    const { g } = make();
    await g.execute({ go: true });
    const [rec] = g.list({ limit: 5 });
    assert.deepEqual(Object.keys(rec).sort(), ['at', 'attempts', 'failReason', 'id', 'landedAt', 'pool', 'raisedUsd', 'signatures', 'skipped', 'status', 'step', 'thresholdUsd'].sort());
    assert.equal(rec.pool, POOL); assert.equal(rec.at, T0);
  });
});
