const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction, SystemProgram, PublicKey } = require('@solana/web3.js');
const { getTestDb } = require('./db');
const { createVaultCreator, curveParamsFor, checkCreatorPlusMint, instructionsOf, rowToDef, SPLIT } = require('./creation');
const { fromKeypair } = require('./signer');
const { KNOWN_CUSTODIANS } = require('../src/reader/backing');
const sdkReal = require('@meteora-ag/dynamic-bonding-curve-sdk');

// The Create door: a wallet with eligible items opens a vault ON THAT WALLET. Onix pays for
// and signs the curve config (it is the partner); the creator signs ONE transaction, the
// pool creation, pre-signed by the throwaway mint key and simulated before it leaves.
const ownerKp = Keypair.generate(); const OWNER = ownerKp.publicKey.toBase58();
const partnerKp = Keypair.generate();
const CC = KNOWN_CUSTODIANS['Collector Crypt'][0];
const asset = (id, insured = '40', collection = CC) => ({ id, ownership: { owner: OWNER }, burnt: false, interface: 'V1_NFT',
  grouping: [{ group_key: 'collection', group_value: collection }],
  content: { links: { image: 'https://x/' + id + '.jpg' }, metadata: { name: 'Card ' + id, attributes: [{ trait_type: 'Insured Value', value: insured }, { trait_type: 'Category', value: 'Pokemon' }] } } });

describe('curve params for a backing', () => {
  test('opens at 2× realisable, graduates at 2.5× that; 60% of supply locked for the creator (50 + 10 reserve); the SDK validates it', () => {
    const { params, view } = curveParamsFor(100);
    assert.equal(view.openingMcapUsd, 200); assert.equal(view.graduationUsd, 500);
    assert.equal(view.creatorPct, 50); assert.equal(view.reservePct, 10); assert.equal(view.curvePct, 40);
    assert.equal(params.lockedVesting.totalLockedVestingAmount, 6_000_000);
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

function make({ assets = [asset('a'), asset('b', '60')], poolOnChain = true } = {}) {
  const db = getTestDb();
  const sent = [], calls = [];
  const chain = {
    getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(),
    sendRawTransaction: async (b64) => { sent.push(b64); return 'SIG' + sent.length; },
    waitForSignature: async () => ({ confirmationStatus: 'confirmed' }),
    simulateTransaction: async () => chain.sim || { err: null, logs: [] }, sim: null,
    getAccountInfoBase64: async () => (poolOnChain ? { data: ['AA=='] } : null),
  };
  const client = {
    partner: { createConfig: async (a) => { calls.push(['config', a]); const tx = new Transaction(); tx.add(SystemProgram.createAccount({ fromPubkey: a.payer, newAccountPubkey: a.config, lamports: 1, space: 0, programId: SystemProgram.programId })); return tx; } },
    creator: { createPool: async (a) => { calls.push(['pool', a]); const tx = new Transaction(); tx.add(SystemProgram.createAccount({ fromPubkey: a.payer, newAccountPubkey: a.baseMint, lamports: 1, space: 0, programId: SystemProgram.programId })); return tx; } },
  };
  const sdk = { buildCurveWithMarketCap: (p) => ({ curveOf: p.initialMarketCap }), deriveDbcPoolAddress: () => Keypair.generate().publicKey };
  const creator = createVaultCreator({ db, chain, sdk, getClient: async () => client, partner: fromKeypair(partnerKp), quoteMint: Keypair.generate().publicKey.toBase58(),
    fetchAssets: async () => assets, metadataBase: 'https://v.test', now: () => 1_800_000_000_000, existingSymbols: () => ['VEONIX'] });
  return { creator, db, chain, sent, calls };
}
const rejects = async (p, code) => { try { await p; assert.fail('expected rejection'); } catch (e) { assert.equal(e.statusCode, code, e.message); } };

describe('Create door — quote', () => {
  test('what the wallet holds that counts, the curve it implies, and what the creator\'s share is worth on day one', async () => {
    const { creator } = make();
    const q = await creator.quote({ owner: OWNER });
    assert.equal(q.items.length, 2); assert.equal(q.indexUsd, 100); assert.equal(q.realisableUsd, 89);
    assert.equal(q.canCreate, true); assert.equal(q.curve.openingMcapUsd, 178); assert.equal(q.creatorTokensWorthUsd, 89);
  });
  test('an empty wallet cannot create, and says why', async () => {
    const { creator } = make({ assets: [] });
    const q = await creator.quote({ owner: OWNER });
    assert.equal(q.canCreate, false); assert.match(q.why, /eligible item/);
  });
});

describe('Create door — build', () => {
  test('config: Onix pays and signs, is the fee claimer; pool tx: creator pays, mint pre-signed, simulated; symbol/name validated', async () => {
    const { creator, sent, calls } = make();
    const out = await creator.build({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a', 'b'] });
    assert.equal(calls[0][0], 'config'); assert.equal(calls[0][1].feeClaimer.toBase58(), partnerKp.publicKey.toBase58()); assert.equal(calls[0][1].payer.toBase58(), partnerKp.publicKey.toBase58());
    assert.equal(sent.length, 1, 'the config was broadcast by the server');
    assert.ok(Transaction.from(Buffer.from(sent[0], 'base64')).verifySignatures(), 'config tx fully signed (partner + config key)');
    assert.equal(calls[1][0], 'pool'); assert.equal(calls[1][1].poolCreator.toBase58(), OWNER); assert.equal(calls[1][1].symbol, 'MYC'); assert.match(calls[1][1].uri, /^https:\/\/v\.test\/token\/.+\.json$/);
    const tx = Transaction.from(Buffer.from(out.transaction, 'base64'));
    assert.equal(checkCreatorPlusMint(tx, OWNER, out.baseMint), null, 'leaves with NO signature');
    assert.ok(tx.signatures.every((s) => s.signature === null));
    assert.ok(out.creationId && out.pool && out.config && out.message);
    assert.equal(out.curve.graduationUsd, 445); assert.equal(out.backing.realisableUsd, 89);
    await rejects(creator.build({ owner: OWNER, name: 'x', symbol: 'veonix', mints: ['a'] }), 400);   // lower-case
    await rejects(creator.build({ owner: OWNER, name: 'x', symbol: 'VEONIX', mints: ['a'] }), 409);   // taken
    await rejects(creator.build({ owner: 'nope', name: 'x', symbol: 'ABC', mints: ['a'] }), 400);
    await rejects(creator.build({ owner: OWNER, name: 'x', symbol: 'ABC', mints: [] }), 400);
    await rejects(creator.build({ owner: OWNER, name: 'x', symbol: 'ABC', mints: ['zzz'] }), 422);  // not in the wallet
  });
  test('a wallet with nothing eligible is refused before anything is created on chain', async () => {
    const { creator, sent } = make({ assets: [asset('p', '40', KNOWN_CUSTODIANS['Phygitals'][0])] });
    await rejects(creator.build({ owner: OWNER, name: 'x', symbol: 'ABC', mints: ['p'] }), 422);
    assert.equal(sent.length, 0);
  });
  test('a pool tx that fails simulation is refused (409) — the wallet never sees it', async () => {
    const { creator, chain } = make();
    chain.sim = { err: { InstructionError: [0, 'Custom'] }, logs: ['Program log: nope'] };
    await rejects(creator.build({ owner: OWNER, name: 'x', symbol: 'ABC', mints: ['a'] }), 409);
  });
});

describe('Create door — submit (the creator signed; the mint key completes; broadcast)', () => {
  test('the signed tx must be the message we built; mint signs after the creator; broadcast once', async () => {
    const { creator, sent } = make();
    const out = await creator.build({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a'] });
    const tx = Transaction.from(Buffer.from(out.transaction, 'base64'));
    tx.partialSign(ownerKp);
    // what a wallet hands back: the same instructions, possibly recompiled — rebuild from instructions to mimic that
    const re = new Transaction({ feePayer: tx.feePayer, recentBlockhash: tx.recentBlockhash }); tx.instructions.forEach((ix) => re.add(ix)); re.partialSign(ownerKp);
    assert.equal(re.serializeMessage().toString('base64'), tx.serializeMessage().toString('base64'), 'same content serialises the same here');
    const r = await creator.submit({ creationId: out.creationId, signedTransaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') });
    assert.equal(r.signature, 'SIG2'); assert.equal(sent.length, 2);
    assert.ok(Transaction.from(Buffer.from(sent[1], 'base64')).verifySignatures(), 'broadcast fully signed: creator + mint');
  });
  test('what Phantom hands back (2 Oct 2026): ComputeBudget in front, our instruction, Lighthouse at the end → accepted; our instruction changed → refused', async () => {
    const { creator, sent } = make();
    const out = await creator.build({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a'] });
    const built = Transaction.from(Buffer.from(out.transaction, 'base64'));
    const { TransactionInstruction } = require('@solana/web3.js');
    const wrap = (ours) => {
      const t = new Transaction({ feePayer: built.feePayer, recentBlockhash: built.recentBlockhash });
      t.add(new TransactionInstruction({ programId: new PublicKey('ComputeBudget111111111111111111111111111111'), keys: [], data: Buffer.from([2, 1, 0, 0, 0]) }));
      t.add(new TransactionInstruction({ programId: new PublicKey('ComputeBudget111111111111111111111111111111'), keys: [], data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]) }));
      ours.forEach((ix) => t.add(ix));
      t.add(new TransactionInstruction({ programId: new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'), keys: [{ pubkey: ownerKp.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([1]) }));
      t.partialSign(ownerKp); return t;
    };
    assert.equal(instructionsOf(wrap(built.instructions)), instructionsOf(built), 'wrappers are ignored');
    const r = await creator.submit({ creationId: out.creationId, signedTransaction: wrap(built.instructions).serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') });
    assert.ok(r.signature); assert.equal(sent.length, 2);
    // the same wrappers around a DIFFERENT instruction is not ours
    const out2 = await creator.build({ owner: OWNER, name: 'My Cards', symbol: 'MYD', mints: ['a'] });
    const tampered = built.instructions.map((ix) => new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.concat([Buffer.from(ix.data), Buffer.from([9])]) }));
    await rejects(creator.submit({ creationId: out2.creationId, signedTransaction: wrap(tampered).serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') }), 409);
  });
  test('a different message, or one the creator did not sign, is refused and nothing is sent', async () => {
    const { creator, sent } = make();
    const out = await creator.build({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a'] });
    await rejects(creator.submit({ creationId: out.creationId, signedTransaction: out.transaction }), 409);   // unsigned
    const other = new Transaction({ feePayer: ownerKp.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() });
    other.add(SystemProgram.transfer({ fromPubkey: ownerKp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })); other.sign(ownerKp);
    await rejects(creator.submit({ creationId: out.creationId, signedTransaction: other.serialize().toString('base64') }), 409);
    await rejects(creator.submit({ creationId: 'nope', signedTransaction: out.transaction }), 404);
    assert.equal(sent.length, 1, 'only the config was ever sent');
  });
});

describe('Create door — confirm', () => {
  test('the pool on chain → the vault is registered in the DB with the creator\'s wallet as the vault, no key', async () => {
    const { creator, db } = make();
    const out = await creator.build({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['b'] });   // one of the two: only it backs the vault
    assert.equal(out.backing.items, 1); assert.equal(out.backing.realisableUsd, 53.4);
    const def = await creator.confirm({ creationId: out.creationId, signature: 'LAUNCH' });
    assert.deepEqual(def.manifest(), ['b']);
    assert.equal(def.id, 'myc'); assert.equal(def.wallet, OWNER); assert.equal(def.secretEnv, null); assert.equal(def.pool, out.pool); assert.equal(def.baseMint, out.baseMint);
    assert.equal(def.token.symbol, 'MYC'); assert.equal(def.graduationUsd, 267); assert.equal(def.rules, 'vault1');
    assert.equal(db.prepare('SELECT launch_sig FROM vaults WHERE id = ?').get('myc').launch_sig, 'LAUNCH');
    await rejects(creator.confirm({ creationId: out.creationId }), 404);  // consumed
    assert.deepEqual(rowToDef(db.prepare('SELECT * FROM vaults WHERE id = ?').get('myc')).token, { name: 'My Cards', symbol: 'MYC', image: '/token/default.png' });
    assert.equal(db.prepare('SELECT count(*) n FROM vault_items WHERE vault = ?').get(OWNER).n, 1);
  });
  test('not on chain yet → 409, nothing registered', async () => {
    const { creator, db } = make({ poolOnChain: false });
    const out = await creator.build({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a'] });
    await rejects(creator.confirm({ creationId: out.creationId }), 409);
    assert.equal(db.prepare('SELECT count(*) n FROM vaults').get().n, 0);
  });
});
