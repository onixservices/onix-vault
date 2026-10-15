const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction, SystemProgram, PublicKey, TransactionInstruction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getTestDb } = require('./db');
const { createVaultCreator, curveParamsFor, checkCreatorPlusMint, instructionsOf, rowToDef, DECIDED, LIMITS } = require('./creation');
const { fromKeypair } = require('./signer');
const keyring = require('./keyring');
const { KNOWN_CUSTODIANS } = require('../src/reader/backing');
const sdkReal = require('@meteora-ag/dynamic-bonding-curve-sdk');

// The Create door, with custody: the creator's items go into a wallet derived for
// the vault; the creator is the pool's creator (allocation + on-chain fee); Onix pays for the
// config only AFTER the deposit landed. Nothing is ever pre-signed for the wallet.
const SEED = '101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f';
const ownerKp = Keypair.generate(); const OWNER = ownerKp.publicKey.toBase58();
const partnerKp = Keypair.generate();
const CC = KNOWN_CUSTODIANS['Collector Crypt'][0];
const asset = (id, insured = '40', owner = OWNER, collection = CC) => ({ id, ownership: { owner }, burnt: false, interface: 'V1_NFT',
  grouping: [{ group_key: 'collection', group_value: collection }],
  content: { links: { image: 'https://x/' + id + '.jpg' }, metadata: { name: 'Card ' + id, attributes: [{ trait_type: 'Insured Value', value: insured }, { trait_type: 'Category', value: 'Pokemon' }, { trait_type: 'The Grade', value: '10' }] } } });

describe('curve params for a backing', () => {
  test('opens at 2× realisable, graduates at 2.5× that; 50% of supply vests to the creator; no reserve; the SDK validates it', () => {
    const { params, view } = curveParamsFor(100);
    assert.equal(view.openingMcapUsd, 200); assert.equal(view.graduationUsd, 500);
    assert.equal(view.creatorPct, 50); assert.equal(view.curvePct, 50); assert.equal(DECIDED.creatorPct, 50);
    assert.equal(params.lockedVesting.totalLockedVestingAmount, 5_000_000);
    const cfg = sdkReal.buildCurveWithMarketCap(params);
    assert.doesNotThrow(() => sdkReal.validateConfigParameters({ ...cfg, leftoverReceiver: PublicKey.unique() }));
  });
});

describe('creator + mint assertion', () => {
  test('exactly two signers: creator and mint; nothing signed when it leaves for the wallet', () => {
    const mint = Keypair.generate();
    const tx = new Transaction({ feePayer: ownerKp.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() });
    tx.add(SystemProgram.createAccount({ fromPubkey: ownerKp.publicKey, newAccountPubkey: mint.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId }));
    tx.partialSign(mint);
    assert.equal(checkCreatorPlusMint(tx, Keypair.generate().publicKey.toBase58(), mint.publicKey.toBase58()).assertion, 'signer-mismatch');
    assert.equal(checkCreatorPlusMint(tx, OWNER, mint.publicKey.toBase58(), { mintSigned: true }), null);
    assert.equal(checkCreatorPlusMint(tx, OWNER, mint.publicKey.toBase58()).assertion, 'mint-pre-signed');
    const unsigned = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })); unsigned.signatures.forEach((s) => { s.signature = null; });
    assert.equal(checkCreatorPlusMint(unsigned, OWNER, mint.publicKey.toBase58()), null, 'what leaves for the wallet: nobody signed');
  });
});

/** A world: the creator's wallet holds cards; "the chain" moves them when a deposit tx is "sent". */
function make({ assets = [asset('a'), asset('b', '60')], poolOnChain = true, lamports = null, uploads = null } = {}) {
  const db = getTestDb();
  const sent = [], calls = [];
  const world = { assets: assets.map((a) => ({ ...a })), sol: { [OWNER]: 200_000_000 } };   // the creator holds 0.2 SOL unless a test says otherwise
  const chain = {
    getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(),
    sendRawTransaction: async (b64) => {
      if (chain.failSend) throw new Error('blockhash not found');
      sent.push(b64);
      // a "transfer" moves the card in our world; a SOL transfer credits the custody wallet
      const tx = Transaction.from(Buffer.from(b64, 'base64'));
      for (const ix of tx.instructions) {
        if (ix.programId.equals(SystemProgram.programId) && ix.data.length === 12) { const from = ix.keys[0].pubkey.toBase58(), to = ix.keys[1].pubkey.toBase58(), n = Number(ix.data.readBigUInt64LE(4)); world.sol[to] = (world.sol[to] || 0) + n; world.sol[from] = (world.sol[from] || 0) - n; }
        if (ix.programId.toBase58() === 'Fake1111111111111111111111111111111111111111') { const [mint, toPadded] = Buffer.from(ix.data).toString('utf8').split('>'); const to = toPadded.replace(/#+$/, ''); const a = world.assets.find((x) => x.id === mint); if (a) a.ownership = { owner: to }; }
      }
      return 'SIG' + sent.length;
    },
    waitForSignature: async () => ({ confirmationStatus: 'confirmed' }),
    simulateTransaction: async () => chain.sim || { err: null, logs: [] }, sim: null,
    getAccountInfoBase64: async () => (chain.poolOnChain ? { data: ['AA=='] } : null), poolOnChain,
    getSignatureStatuses: async (sigs) => sigs.map((x) => chain.statuses[x] || null), statuses: {},
    getBalanceLamports: async (w) => (lamports != null ? lamports : (world.sol[w] || 0)),
  };
  let configReads = 0;
  let clock = 1_800_000_000_000;
  const client = {
    state: { getPoolConfig: async () => { configReads++; if (configReads <= 2) throw new Error('Pool config not found for virtual pool'); return { ok: true }; } },
    partner: { createConfig: async (a) => { calls.push(['config', a]); const tx = new Transaction(); tx.add(SystemProgram.createAccount({ fromPubkey: a.payer, newAccountPubkey: a.config, lamports: 1, space: 0, programId: SystemProgram.programId })); return tx; } },
    creator: { createPool: async (a) => { calls.push(['pool', a]); const tx = new Transaction(); tx.add(SystemProgram.createAccount({ fromPubkey: a.payer, newAccountPubkey: a.baseMint, lamports: 1, space: 0, programId: SystemProgram.programId })); return tx; } },
  };
  const sdk = { buildCurveWithMarketCap: (p) => ({ curveOf: p.initialMarketCap }), deriveDbcPoolAddress: () => Keypair.generate().publicKey };
  // a fake transfer builder: one "Fake" instruction per card carrying "mint>to"; 100 bytes of padding so ~5 fit a tx
  const buildTransfer = async ({ mint, fromAddress, toAddress, recentBlockhash }) => {
    const tx = new Transaction({ feePayer: new PublicKey(fromAddress), recentBlockhash });
    tx.add(new TransactionInstruction({ programId: new PublicKey('Fake1111111111111111111111111111111111111111'), keys: [{ pubkey: new PublicKey(fromAddress), isSigner: true, isWritable: true }], data: Buffer.from(mint + '>' + toAddress + '#'.repeat(100)) }));
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  };
  const kr = { custodySigner: (i) => keyring.custodySigner(i, SEED) };
  const creator = createVaultCreator({ db, chain, sdk, getClient: async () => client, partner: fromKeypair(partnerKp), keyring: kr, quoteMint: Keypair.generate().publicKey.toBase58(),
    fetchAssets: async (rpc, owner) => world.assets.filter((a) => a.ownership.owner === owner), buildTransfer, metadataBase: 'https://v.test', now: () => clock, retryMs: 1, existingSymbols: () => ['VEONIX', 'TAKEN'], reservedIndexes: () => [0], uploads });
  // the creator "signs and sends" the deposit txs in the world
  const deposit = async (txs) => { for (const b64 of txs) { const tx = Transaction.from(Buffer.from(b64, 'base64')); tx.partialSign(ownerKp); await chain.sendRawTransaction(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')); } };
  return { creator, db, chain, sent, calls, world, deposit, configReads: () => configReads, tick: (ms) => { clock += ms; } };
}
const rejects = async (p, code) => { try { await p; assert.fail('expected rejection'); } catch (e) { assert.equal(e.statusCode, code, e.message); } };

describe('Create door — quote', () => {
  test('what the wallet holds that THESE rules take, and the curve it implies; the creator\'s share is worth the items on day one', async () => {
    const { creator } = make();
    const q = await creator.quote({ owner: OWNER });
    assert.equal(q.items.length, 2); assert.equal(q.indexUsd, 100); assert.equal(q.realisableUsd, 89);
    assert.equal(q.canCreate, true); assert.equal(q.curve.openingMcapUsd, 178); assert.equal(q.creatorTokensWorthUsd, 89); assert.equal(q.gasSol, LIMITS.gasSol);
    assert.deepEqual(q.sol, { have: 0.2, need: LIMITS.minOwnerSol, short: false }, 'the quote says what the wallet holds against what a launch needs');
    const q2 = await creator.quote({ owner: OWNER, rules: { minValueUsd: 50 } });
    assert.equal(q2.items.length, 1); assert.equal(q2.ineligible.length, 1);
    await rejects(creator.quote({ owner: OWNER, rules: { category: 'wine' } }), 422);
  });
  test('the quote lists what cannot go in with its custodian; a stranger\'s NFT gets no picture', async () => {
    const { creator } = make({ assets: [asset('a'), asset('spam', '40', OWNER, 'Spam111111111111111111111111111111111111111')] });
    const q = await creator.quote({ owner: OWNER });
    assert.deepEqual(q.ineligible.map((x) => [x.mint, x.custodian, x.imageUrl, x.reason]), [['spam', null, null, 'unknown custodian']]);
    assert.equal(q.items[0].imageUrl, 'https://x/a.jpg');
  });
  test('a wallet short of SOL learns it in the quote, before it picks a single card', async () => {
    const { creator, world } = make();
    world.sol[OWNER] = 17_670_667;
    const q = await creator.quote({ owner: OWNER });
    assert.deepEqual(q.sol, { have: 0.018, need: LIMITS.minOwnerSol, short: true });
    assert.equal(q.canCreate, true, 'the cards are fine; only the gas is missing');
  });
  test('an empty wallet cannot create, and says why', async () => {
    const { creator } = make({ assets: [] });
    const q = await creator.quote({ owner: OWNER });
    assert.equal(q.canCreate, false); assert.match(q.why, /eligible item/);
  });
});

describe('Create door — open (custody allocated, deposits built; Onix spends nothing)', () => {
  test('derives the custody wallet from the next free index, builds unsigned single-signer deposit txs (+ gas), persists the creation', async () => {
    const { creator, db, sent } = make();
    const o = await creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a', 'b'], rules: { category: 'pokemon' }, description: 'two cards' });
    assert.equal(o.custodyWallet, keyring.custodySigner(1, SEED).publicKey(), 'index 0 is reserved by the file registry');
    assert.equal(o.items, 2); assert.equal(o.backing.realisableUsd, 89);
    assert.ok(o.depositTransactions.length >= 1);
    for (const b64 of o.depositTransactions) { const tx = Transaction.from(Buffer.from(b64, 'base64')); assert.equal(tx.signatures.length, 1); assert.equal(tx.signatures[0].signature, null); assert.equal(tx.feePayer.toBase58(), OWNER); }
    const first = Transaction.from(Buffer.from(o.depositTransactions[0], 'base64'));
    assert.ok(first.instructions.some((ix) => ix.programId.equals(SystemProgram.programId)), 'gas for the custody wallet rides in the first deposit');
    assert.equal(sent.length, 0, 'nothing of ours was sent');
    const row = db.prepare('SELECT * FROM vault_creations WHERE id = ?').get(o.creationId);
    assert.equal(row.status, 'opened'); assert.equal(row.custody_index, 1); assert.deepEqual(JSON.parse(row.mints_json), ['a', 'b']); assert.equal(JSON.parse(row.rules_json).category, 'pokemon');
  });
  test('a creator wallet without the SOL for the gas → 402 in words, with the numbers, before any deposit is built', async () => {
    const { creator, world } = make();
    world.sol[OWNER] = 17_670_667;   // 0.0177 SOL — what a creator's wallet held on 15 Oct 2026 when the page answered with raw JSON
    try { await creator.open({ owner: OWNER, name: 'Grand Line', symbol: 'GLN', mints: ['a'] }); assert.fail('expected 402'); }
    catch (e) { assert.equal(e.statusCode, 402, e.message); assert.match(e.message, /0\.018 SOL/); assert.match(e.message, /0\.12 SOL/); assert.doesNotMatch(e.message, /[{}]/); }
  });
  test('a deposit the chain refuses without a program log is explained in words, never as raw JSON', async () => {
    const { creator, chain } = make();
    chain.sim = { err: { InstructionError: [0, { Custom: 1 }] }, logs: [] };
    try { await creator.open({ owner: OWNER, name: 'Grand Line', symbol: 'GLN', mints: ['a'] }); assert.fail('expected 409'); }
    catch (e) { assert.equal(e.statusCode, 409, e.message); assert.match(e.message, /gas transfer/); assert.doesNotMatch(e.message, /[{}]/); }
  });
  test('packs many items into several transactions under 1232 bytes', async () => {
    const many = Array.from({ length: 12 }, (_, i) => asset('m' + i));
    const { creator } = make({ assets: many });
    const o = await creator.open({ owner: OWNER, name: 'Dozen', symbol: 'DZN', mints: many.map((a) => a.id) });
    assert.ok(o.depositTransactions.length > 1);
    for (const b64 of o.depositTransactions) assert.ok(Buffer.from(b64, 'base64').length <= 1232);
    const ixCount = o.depositTransactions.reduce((n, b64) => n + Transaction.from(Buffer.from(b64, 'base64')).instructions.filter((ix) => !ix.programId.equals(SystemProgram.programId)).length, 0);
    assert.equal(ixCount, 12);
  });
  test('refuses: a second creation in flight for the wallet (409), reserved or taken symbols, off-list rules, items not held, bad links', async () => {
    const { creator } = make();
    await creator.open({ owner: OWNER, name: 'One', symbol: 'ONE', mints: ['a'] });
    await rejects(creator.open({ owner: OWNER, name: 'Two', symbol: 'TWO', mints: ['b'] }), 409);
    const { creator: c2 } = make();
    await rejects(c2.open({ owner: OWNER, name: 'x', symbol: 'USDC', mints: ['a'] }), 422);
    await rejects(c2.open({ owner: OWNER, name: 'x', symbol: 'TAKEN', mints: ['a'] }), 409);
    await rejects(c2.open({ owner: OWNER, name: 'x', symbol: 'ABC', mints: ['zzz'] }), 422);
    await rejects(c2.open({ owner: OWNER, name: 'x', symbol: 'ABC', mints: ['a'], rules: { gradMult: 9 } }), 422);
    await rejects(c2.open({ owner: OWNER, name: 'x', symbol: 'ABC', mints: ['a'], links: { x: 'javascript:alert(1)' } }), 400);
    await rejects(c2.open({ owner: 'nope', name: 'x', symbol: 'ABC', mints: ['a'] }), 400);
  });
  test('a global cap on creations per hour (every launch costs Onix the config rent)', async () => {
    const many = Array.from({ length: 12 }, (_, i) => asset('m' + i, '40', Keypair.generate().publicKey.toBase58()));
    const { creator, world } = make({ assets: many });
    for (const a of many) world.sol[a.ownership.owner] = 200_000_000;   // each creator holds the SOL a launch needs
    for (let i = 0; i < LIMITS.maxOpenPerHour; i++) await creator.open({ owner: many[i].ownership.owner, name: 'v' + i, symbol: 'V' + i, mints: [many[i].id] });
    await rejects(creator.open({ owner: many[10].ownership.owner, name: 'v10', symbol: 'V10', mints: [many[10].id] }), 429);
  });
});

describe('Create door — deposited → config (Onix pays, custody is the fee claimer) → launch tx (unsigned)', () => {
  test('before the items land, 409 and no config; after, the config is created once and the launch tx is built for the creator', async () => {
    const { creator, chain, calls, sent, deposit, db, configReads } = make();
    const o = await creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a', 'b'] });
    await rejects(creator.deposited({ creationId: o.creationId }), 409);
    assert.equal(calls.length, 0, 'no config before the deposit');
    await deposit(o.depositTransactions);
    const d = await creator.deposited({ creationId: o.creationId });
    assert.equal(calls[0][0], 'config');
    assert.equal(calls[0][1].feeClaimer.toBase58(), o.custodyWallet, 'the vault treasury is its custody wallet');
    assert.equal(calls[0][1].payer.toBase58(), partnerKp.publicKey.toBase58(), 'Onix pays the config');
    assert.ok(Transaction.from(Buffer.from(sent[sent.length - 1], 'base64')).verifySignatures(), 'config tx fully signed (partner + config key)');
    assert.ok(configReads() >= 3, 'the config was read back until the RPC had it (2 Oct 2026 lag)');
    assert.equal(calls[1][0], 'pool'); assert.equal(calls[1][1].poolCreator.toBase58(), OWNER); assert.equal(calls[1][1].payer.toBase58(), OWNER);
    const tx = Transaction.from(Buffer.from(d.transaction, 'base64'));
    assert.equal(checkCreatorPlusMint(tx, OWNER, d.baseMint), null, 'leaves with NO signature');
    assert.equal(d.curve.graduationUsd, 445); assert.equal(d.backing.realisableUsd, 89);
    assert.equal(db.prepare('SELECT status, config FROM vault_creations WHERE id = ?').get(o.creationId).status, 'deposited');
    // calling again (e.g. after a restart lost the mint key) rebuilds the launch tx WITHOUT a second config
    const n = calls.filter((c) => c[0] === 'config').length;
    await creator.deposited({ creationId: o.creationId });
    assert.equal(calls.filter((c) => c[0] === 'config').length, n, 'the config is paid once');
  });
  test("Onix's config transaction carries a priority fee, first in line, so a congested chain does not drop it", async () => {
    const { creator, deposit, sent } = make();
    const o = await creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a'] });
    await deposit(o.depositTransactions);
    const before = sent.length;
    await creator.deposited({ creationId: o.creationId });
    const cfg = Transaction.from(Buffer.from(sent[before], 'base64'));
    assert.equal(cfg.instructions[0].programId.toBase58(), 'ComputeBudget111111111111111111111111111111', 'the first instruction sets the compute-unit price');
  });
  test('a config the chain does not confirm in time: 409 in words, the attempt on record, and no second config while the first may still land', async () => {
    const { creator, chain, deposit, calls, db } = make();
    const o = await creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a'] });
    await deposit(o.depositTransactions);
    const realWait = chain.waitForSignature;
    chain.waitForSignature = async (sig) => { throw new Error(`transaction ${sig} not confirmed after 60s`); };
    try { await creator.deposited({ creationId: o.creationId }); assert.fail('expected 409'); }
    catch (e) { assert.equal(e.statusCode, 409, e.message); assert.match(e.message, /custody/); assert.doesNotMatch(e.message, /[{}]/); }
    const row = db.prepare('SELECT status, config, config_sig FROM vault_creations WHERE id = ?').get(o.creationId);
    assert.equal(row.status, 'opened'); assert.ok(row.config && row.config_sig, 'the attempt is on record before anyone retries');
    assert.equal(calls.filter((c) => c[0] === 'config').length, 1);
    chain.waitForSignature = realWait;
    await rejects(creator.deposited({ creationId: o.creationId }), 409);   // still in flight: wait, do not pay again
    assert.equal(calls.filter((c) => c[0] === 'config').length, 1, 'no second config while the first may still land');
    chain.statuses[row.config_sig] = { confirmationStatus: 'finalized' };   // it landed: the same config serves
    const d = await creator.deposited({ creationId: o.creationId });
    assert.equal(d.config, row.config); assert.equal(calls.filter((c) => c[0] === 'config').length, 1);
  });
  test('a config attempt that can no longer land is replaced, and only then does Onix pay again', async () => {
    const w = make(); const { creator, chain, deposit, calls, db } = w;
    const o = await creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a'] });
    await deposit(o.depositTransactions);
    const realWait = chain.waitForSignature;
    chain.waitForSignature = async (sig) => { throw new Error(`transaction ${sig} not confirmed after 60s`); };
    await rejects(creator.deposited({ creationId: o.creationId }), 409);
    chain.waitForSignature = realWait;
    const first = db.prepare('SELECT config FROM vault_creations WHERE id = ?').get(o.creationId).config;
    w.tick(LIMITS.launchExpiryMs + 1);
    const d = await creator.deposited({ creationId: o.creationId });
    assert.notEqual(d.config, first); assert.equal(calls.filter((c) => c[0] === 'config').length, 2, 'a dead attempt is replaced once');
  });
  test('a config the program would refuse (simulation) → 409 and Onix pays nothing', async () => {
    const { creator, chain, deposit, sent } = make();
    const o = await creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a'] });
    await deposit(o.depositTransactions);
    const before = sent.length;
    chain.sim = { err: { InstructionError: [0, { Custom: 6020 }] }, logs: ['Program log: AnchorError … Error Code: InvalidTokenSupply.'] };
    await rejects(creator.deposited({ creationId: o.creationId }), 409);
    assert.equal(sent.length, before, 'the config was never broadcast');
  });
  test('custody without gas → 409 (no config spent)', async () => {
    const { creator, calls, world } = make();
    const o = await creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a'] });
    world.assets.find((a) => a.id === 'a').ownership = { owner: o.custodyWallet };   // card arrived, gas did not
    await rejects(creator.deposited({ creationId: o.creationId }), 409);
    assert.equal(calls.length, 0);
  });
});

describe('Create door — submit and confirm', () => {
  const launch = async (w) => {
    const o = await w.creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a', 'b'], rules: { gradMult: 3, creatorFeePct: 50 } });
    await w.deposit(o.depositTransactions);
    const d = await w.creator.deposited({ creationId: o.creationId });
    return { o, d };
  };
  test('what Phantom hands back (ComputeBudget + ours + Lighthouse) is accepted; the mint completes it; confirm registers custody + creator + rules and mounts the manifest', async () => {
    const w = make(); const { o, d } = await launch(w);
    const built = Transaction.from(Buffer.from(d.transaction, 'base64'));
    const t = new Transaction({ feePayer: built.feePayer, recentBlockhash: built.recentBlockhash });
    t.add(new TransactionInstruction({ programId: new PublicKey('ComputeBudget111111111111111111111111111111'), keys: [], data: Buffer.from([2, 1, 0, 0, 0]) }));
    built.instructions.forEach((ix) => t.add(ix));
    t.add(new TransactionInstruction({ programId: new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'), keys: [{ pubkey: ownerKp.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([1]) }));
    t.partialSign(ownerKp);
    const r = await w.creator.submit({ creationId: o.creationId, signedTransaction: t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') });
    assert.ok(r.signature);
    assert.ok(Transaction.from(Buffer.from(w.sent[w.sent.length - 1], 'base64')).verifySignatures(), 'broadcast fully signed: creator + mint');
    const def = await w.creator.confirm({ creationId: o.creationId, signature: r.signature });
    assert.equal(def.id, 'myc'); assert.equal(def.wallet, o.custodyWallet); assert.equal(def.creator, OWNER); assert.equal(def.custodyIndex, 1); assert.equal(def.secretEnv, null);
    assert.equal(def.pool, d.pool); assert.equal(def.baseMint, d.baseMint); assert.equal(def.gradMult, 3); assert.equal(def.creatorFeePct, 50);
    assert.equal(def.graduationUsd, 534); assert.equal(def.openingMcapUsd, 178);
    assert.deepEqual(def.manifest().sort(), ['a', 'b']);
    assert.equal(w.db.prepare('SELECT status FROM vault_creations WHERE id = ?').get(o.creationId).status, 'launched');
    const again = await w.creator.confirm({ creationId: o.creationId });
    assert.equal(again.id, 'myc', 'confirm is idempotent');
  });
  test('the coin image and the banner: unknown upload → 422; without an uploads store → 503; a stored one travels open → confirm and lands on the vault row as /token/<mint>.png', async () => {
    const { createUploads } = require('./uploads');
    const fs = require('fs'), os = require('os'), path = require('path');
    const uploads = createUploads({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'vault-up-')) });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 9)]);
    const { uploadId } = uploads.store(png);
    await rejects(make().creator.open({ owner: OWNER, name: 'X', symbol: 'IMGA', mints: ['a'], imageId: uploadId }), 503);
    const w = make({ uploads });
    await rejects(w.creator.open({ owner: OWNER, name: 'X', symbol: 'IMGB', mints: ['a'], imageId: 'f'.repeat(64) + '.png' }), 422);
    await rejects(w.creator.open({ owner: OWNER, name: 'X', symbol: 'IMGB', mints: ['a'], bannerId: '../x.png' }), 422);
    const o = await w.creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a', 'b'], rules: { gradMult: 3, creatorFeePct: 50 }, imageId: uploadId, bannerId: uploadId, description: 'ten slabs' });
    assert.equal(w.db.prepare('SELECT image, banner FROM vault_creations WHERE id = ?').get(o.creationId).image, uploadId);
    await w.deposit(o.depositTransactions);
    const d = await w.creator.deposited({ creationId: o.creationId });
    const built = Transaction.from(Buffer.from(d.transaction, 'base64')); built.partialSign(ownerKp);
    const r = await w.creator.submit({ creationId: o.creationId, signedTransaction: built.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') });
    const def = await w.creator.confirm({ creationId: o.creationId, signature: r.signature });
    assert.equal(def.token.image, '/token/' + d.baseMint + '.png'); assert.equal(def.token.banner, '/token/' + d.baseMint + '-banner.png'); assert.equal(def.description, 'ten slabs');
    assert.deepEqual(w.db.prepare('SELECT image, banner FROM vaults WHERE id = ?').get('myc'), { image: uploadId, banner: uploadId });
  });
  test('a different message, or one the creator did not sign, is refused; the pool not on chain yet → 409', async () => {
    const w = make({ poolOnChain: false }); const { o, d } = await launch(w);
    await rejects(w.creator.submit({ creationId: o.creationId, signedTransaction: d.transaction }), 409);   // unsigned
    const other = new Transaction({ feePayer: ownerKp.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() });
    other.add(SystemProgram.transfer({ fromPubkey: ownerKp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })); other.sign(ownerKp);
    await rejects(w.creator.submit({ creationId: o.creationId, signedTransaction: other.serialize().toString('base64') }), 409);
    const good = Transaction.from(Buffer.from(d.transaction, 'base64')); good.partialSign(ownerKp);
    await w.creator.submit({ creationId: o.creationId, signedTransaction: good.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') });
    await rejects(w.creator.confirm({ creationId: o.creationId }), 409);
    assert.equal(w.db.prepare('SELECT count(*) n FROM vaults').get().n, 0);
  });
});

describe('Create door — abandon and sweep (custody returns the items)', () => {
  test('the creator abandons before launch: every item custody holds goes back, signed by the derived key; strangers cannot', async () => {
    const w = make();
    const o = await w.creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a', 'b'] });
    await w.deposit(o.depositTransactions);
    assert.equal(w.world.assets.filter((a) => a.ownership.owner === o.custodyWallet).length, 2);
    await rejects(w.creator.abandon({ creationId: o.creationId, owner: Keypair.generate().publicKey.toBase58() }), 403);
    const r = await w.creator.abandon({ creationId: o.creationId, owner: OWNER });
    assert.equal(r.returned.filter((x) => x.mint).length, 2); assert.equal(r.returned.filter((x) => x.sol).length, 1);
    assert.equal(w.world.assets.filter((a) => a.ownership.owner === OWNER).length, 2, 'both cards are back with the creator');
    assert.ok(r.solReturned > 0.019, 'the gas goes back too'); assert.ok((w.world.sol[o.custodyWallet] || 0) <= 5000, 'custody is drained but for one fee');
    assert.ok(Transaction.from(Buffer.from(w.sent[w.sent.length - 1], 'base64')).verifySignatures(), 'signed by custody');
    assert.equal(w.db.prepare('SELECT status FROM vault_creations WHERE id = ?').get(o.creationId).status, 'abandoned');
    const o2 = await w.creator.open({ owner: OWNER, name: 'Again', symbol: 'AGN', mints: ['a'] });
    assert.equal(o2.custodyWallet, keyring.custodySigner(2, SEED).publicKey(), 'an abandoned index is never reused');
  });
  test('status: while open, says what custody still lacks and rebuilds the deposit transactions for exactly that', async () => {
    const w = make();
    const o = await w.creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a', 'b'] });
    await w.deposit([o.depositTransactions[0]]);   // suppose only the first deposit went through (it carried both cards in this fake, so move one back)
    w.world.assets.find((a) => a.id === 'b').ownership = { owner: OWNER };
    const st = await w.creator.status({ creationId: o.creationId, owner: OWNER });
    assert.equal(st.status, 'opened'); assert.deepEqual(st.missingMints, ['b']); assert.ok(st.custodySol > 0);
    assert.equal(st.depositTransactions.length, 1);
    const tx = Transaction.from(Buffer.from(st.depositTransactions[0], 'base64'));
    assert.ok(!tx.instructions.some((ix) => ix.programId.equals(SystemProgram.programId)), 'gas already there → no second gas transfer');
    await rejects(w.creator.status({ creationId: o.creationId, owner: Keypair.generate().publicKey.toBase58() }), 403);
  });
  test('an expired creation is abandoned by the sweep', async () => {
    const w = make();
    const o = await w.creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a'] });
    await w.deposit(o.depositTransactions);
    w.db.prepare('UPDATE vault_creations SET expires_at = ? WHERE id = ?').run(1, o.creationId);
    const out = await w.creator.sweep();
    assert.equal(out.length, 1); assert.equal(out[0].returned.filter((x) => x.mint).length, 1);
    assert.equal(w.world.assets.find((a) => a.id === 'a').ownership.owner, OWNER);
  });
});

describe('rowToDef', () => {
  test('a DB row → registry entry with custody index, creator, rules, token image paths', () => {
    const def = rowToDef({ id: 'x', name: 'X', operator: 'o', wallet: 'C', creator: 'K', custody_index: 4, pool: 'P', base_mint: 'M', graduation_usd: 500, grad_mult: 2.5, creator_fee_pct: 40, token_name: 'X', token_symbol: 'X', rules: 'vault1', rules_json: JSON.stringify({ custodians: ['Collector Crypt'], category: 'mixed' }), image: 'abc.png', banner: null, links_json: '{"x":"https://x.com/a"}', created_by: 'K', created_at: 1 });
    assert.equal(def.custodyIndex, 4); assert.equal(def.creator, 'K'); assert.equal(def.rules.category, 'mixed'); assert.equal(def.openingMcapUsd, 200);
    assert.equal(def.token.image, '/token/M.png'); assert.equal(def.token.banner, null); assert.deepEqual(def.links, { x: 'https://x.com/a' });
  });
});

describe('Create door — once a launch is submitted, the items stay with the token', () => {
  // open → deposit → deposited → the creator signs → submit; the pool may or may not be on chain yet
  const launched = async (w) => {
    const o = await w.creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a', 'b'] });
    await w.deposit(o.depositTransactions);
    const d = await w.creator.deposited({ creationId: o.creationId });
    const t = Transaction.from(Buffer.from(d.transaction, 'base64')); t.partialSign(ownerKp);
    const r = await w.creator.submit({ creationId: o.creationId, signedTransaction: t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') });
    return { o, d, r };
  };
  const inCustody = (w, o) => w.world.assets.filter((a) => a.ownership.owner === o.custodyWallet).length;

  test('the pool is on chain → abandon is refused and nothing leaves custody; the sweep registers the vault instead', async () => {
    const w = make(); const { o } = await launched(w);
    const sentBefore = w.sent.length;
    await rejects(w.creator.abandon({ creationId: o.creationId, owner: OWNER }), 409);
    assert.equal(inCustody(w, o), 2); assert.equal(w.sent.length, sentBefore, 'nothing signed by custody');
    w.db.prepare('UPDATE vault_creations SET expires_at = ? WHERE id = ?').run(1, o.creationId);
    const out = await w.creator.sweep();
    assert.equal(out.length, 1); assert.equal(out[0].confirmed.id, 'myc');
    assert.equal(inCustody(w, o), 2, 'the sweep never returns the items of a live token');
    assert.equal(w.db.prepare('SELECT status FROM vault_creations WHERE id = ?').get(o.creationId).status, 'launched');
  });
  test('a launch in flight (no pool yet, recent) → abandon and the sweep wait; once it can no longer land, the items go back', async () => {
    const w = make({ poolOnChain: false }); const { o } = await launched(w);
    await rejects(w.creator.abandon({ creationId: o.creationId, owner: OWNER }), 409);
    w.db.prepare('UPDATE vault_creations SET expires_at = ? WHERE id = ?').run(1, o.creationId);
    assert.equal((await w.creator.sweep()).length, 0, 'in flight: the sweep leaves it');
    assert.equal(inCustody(w, o), 2);
    w.tick(LIMITS.launchExpiryMs + 1);
    const r = await w.creator.abandon({ creationId: o.creationId, owner: OWNER });
    assert.equal(r.returned.filter((x) => x.mint).length, 2); assert.equal(inCustody(w, o), 0);
  });
  test('a launch the chain rejected → the creator may abandon, or build a new launch', async () => {
    const w = make({ poolOnChain: false }); const { o, r } = await launched(w);
    w.chain.statuses[r.signature] = { confirmationStatus: 'confirmed', err: { InstructionError: [0, { Custom: 1 }] } };
    const again = await w.creator.deposited({ creationId: o.creationId });
    assert.ok(again.transaction, 'a dead launch can be rebuilt');
    assert.equal(w.db.prepare('SELECT pool FROM vault_creations WHERE id = ?').get(o.creationId).pool, null, 'the dead launch is cleared');
    const ab = await w.creator.abandon({ creationId: o.creationId, owner: OWNER });
    assert.equal(ab.returned.filter((x) => x.mint).length, 2);
  });
  test('deposited after a submit (live or in flight) builds no second launch', async () => {
    const live = make(); const a = await launched(live);
    const pools = () => live.calls.filter((c) => c[0] === 'pool').length;
    const n = pools();
    await rejects(live.creator.deposited({ creationId: a.o.creationId }), 409);
    assert.equal(pools(), n);
    const flight = make({ poolOnChain: false }); const b = await launched(flight);
    await rejects(flight.creator.deposited({ creationId: b.o.creationId }), 409);
  });
  test('confirm is only for a creation still being launched: after abandon → 409, no vault registered', async () => {
    const w = make({ poolOnChain: false }); const { o } = await launched(w);
    w.tick(LIMITS.launchExpiryMs + 1);
    await w.creator.abandon({ creationId: o.creationId, owner: OWNER });
    w.chain.poolOnChain = true;
    await rejects(w.creator.confirm({ creationId: o.creationId }), 409);
    assert.equal(w.db.prepare('SELECT count(*) n FROM vaults').get().n, 0);
  });
  test('submit records the pool and the signature BEFORE broadcasting: a failed broadcast still counts as a launch in flight', async () => {
    const w = make({ poolOnChain: false });
    const o = await w.creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a', 'b'] });
    await w.deposit(o.depositTransactions);
    const d = await w.creator.deposited({ creationId: o.creationId });
    const t = Transaction.from(Buffer.from(d.transaction, 'base64')); t.partialSign(ownerKp);
    w.chain.failSend = true;
    await assert.rejects(w.creator.submit({ creationId: o.creationId, signedTransaction: t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') }));
    const row = w.db.prepare('SELECT pool, launch_sig, launch_at FROM vault_creations WHERE id = ?').get(o.creationId);
    assert.equal(row.pool, d.pool); assert.ok(row.launch_sig); assert.ok(row.launch_at);
    w.chain.failSend = false;
    await rejects(w.creator.abandon({ creationId: o.creationId, owner: OWNER }), 409);
  });
  test('two deposited calls at once: one pays the config, the other is refused', async () => {
    const w = make();
    const o = await w.creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a'] });
    await w.deposit(o.depositTransactions);
    const both = await Promise.allSettled([w.creator.deposited({ creationId: o.creationId }), w.creator.deposited({ creationId: o.creationId })]);
    assert.equal(both.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(both.find((x) => x.status === 'rejected').reason.statusCode, 409);
    assert.equal(w.calls.filter((c) => c[0] === 'config').length, 1, 'Onix paid one config');
  });
  test('abandon returns the gas only after simulating that transfer; a refused simulation signs nothing for it', async () => {
    const w = make();
    const o = await w.creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a'] });
    await w.deposit(o.depositTransactions);
    const realSim = w.chain.simulateTransaction;
    w.chain.simulateTransaction = async (b64) => { const tx = Transaction.from(Buffer.from(b64, 'base64')); return tx.instructions.some((ix) => ix.programId.equals(SystemProgram.programId)) ? { err: 'nope', logs: [] } : realSim(b64); };
    const r = await w.creator.abandon({ creationId: o.creationId, owner: OWNER });
    assert.equal(r.returned.filter((x) => x.mint).length, 1); assert.equal(r.solReturned, 0);
    assert.ok(w.world.sol[o.custodyWallet] > 0, 'the gas stays until a retry');
  });
});

describe('the gas the creator deposits', () => {
  test('a vault created with the default gas can afford graduation, a delivery and its first purchases above the venue minimum', () => {
    const { RESTOCK } = require('./restock');
    // graduation + a delivery + the fee claims spend ~0.003 SOL from custody (measured); below RESTOCK.minSol the venue hands a
    // sponsored two-signer buy the treasury refuses — a vault born with gasSol === minSol never bought anything
    assert.ok(LIMITS.gasSol >= RESTOCK.minSol + 0.02, `gasSol ${LIMITS.gasSol} leaves no room above the venue minimum ${RESTOCK.minSol}`);
  });
});
