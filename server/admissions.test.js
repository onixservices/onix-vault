const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction, SystemProgram, PublicKey } = require('@solana/web3.js');
const { getTestDb } = require('./db');
const { VAULT_RULES, itemPassesRules, createAdmissions } = require('./admissions');
const { validateRules, describeRules, RULE_OPTIONS } = require('./rules');
const { KNOWN_CUSTODIANS } = require('../src/reader/backing');

// "Send a card": only the vault's CREATOR adds items, only items that pass the
// vault's rules; the creator signs the transfer into custody; verified on chain; the item joins
// the manifest. No tokens are owed per item. Anyone else opens their own vault.
const CUSTODY = Keypair.generate().publicKey.toBase58();
const CREATOR = Keypair.generate().publicKey.toBase58();
const STRANGER = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();
const CC = KNOWN_CUSTODIANS['Collector Crypt'][0];
const PHYG = KNOWN_CUSTODIANS['Phygitals'][0];

const asset = (id, { collection = CC, insured = '40', owner = CREATOR, category = 'Pokemon', grade = '10' } = {}) => ({
  id, ownership: { owner, frozen: false }, burnt: false, interface: 'V1_NFT',
  grouping: collection ? [{ group_key: 'collection', group_value: collection }] : [],
  content: { links: { image: 'https://x/' + id + '.jpg' }, metadata: { name: 'Card ' + id, attributes: [
    ...(insured == null ? [] : [{ trait_type: 'Insured Value', value: insured }]), { trait_type: 'Category', value: category }, { trait_type: 'The Grade', value: grade },
  ] } },
});

describe('vault rules', () => {
  test('default rules: Collector Crypt graded cards with a value on chain; Phygitals and unknowns are listed with the reason', () => {
    const rules = VAULT_RULES.vault1;
    assert.deepEqual(itemPassesRules(asset('a'), rules), { ok: true, reason: null });
    // a Phygitals card carries identity on chain but no value: that is the reason it gives, not the vault's list
    assert.deepEqual(itemPassesRules(asset('b', { collection: PHYG, insured: null }), rules), { ok: false, reason: 'no insured value' });
    assert.deepEqual(itemPassesRules(asset('b2', { collection: PHYG }), rules), { ok: false, reason: 'custodian not accepted by this vault: Phygitals' });
    assert.deepEqual(itemPassesRules(asset('c', { collection: 'Zzz' }), rules), { ok: false, reason: 'unknown custodian' });
    assert.deepEqual(itemPassesRules(asset('d', { insured: null }), rules), { ok: false, reason: 'no insured value' });
    assert.deepEqual(itemPassesRules(asset('e', { insured: '5' }), { ...rules, minValueUsd: 10 }), { ok: false, reason: 'below the vault\'s minimum value ($10)' });
  });
  test('creator choices come from lists: category and grade filter; off-list values are 422; the page gets one sentence', () => {
    const r = validateRules({ category: 'pokemon', minGrade: 9, minValueUsd: 25, creatorFeePct: 30, gradMult: 3 });
    assert.equal(r.category, 'pokemon'); assert.equal(r.minGrade, 9); assert.equal(r.creatorFeePct, 30); assert.equal(r.gradMult, 3); assert.equal(r.restock, 'sameAsEntry');
    assert.deepEqual(itemPassesRules(asset('a', { category: 'One Piece', grade: '10', insured: '40' }), r), { ok: false, reason: 'not pokemon (One Piece)' });
    assert.deepEqual(itemPassesRules(asset('a', { category: 'Pokemon', grade: '8', insured: '40' }), r), { ok: false, reason: 'below the vault\'s minimum grade (9)' });
    assert.deepEqual(itemPassesRules(asset('a', { category: 'Pokemon', grade: '9.5', insured: '40' }), r), { ok: true, reason: null });
    assert.throws(() => validateRules({ category: 'wine' }), (e) => e.statusCode === 422);
    assert.throws(() => validateRules({ creatorFeePct: 90 }), (e) => e.statusCode === 422);
    assert.throws(() => validateRules({ restock: 'anything' }), (e) => e.statusCode === 422);
    assert.deepEqual(validateRules({ restock: { category: 'sports', maxValueUsd: 100 } }).restock, { category: 'sports', maxValueUsd: 100 });
    assert.equal(describeRules(r), 'Pokémon cards graded 9+ worth $25+ from Collector Crypt');
    assert.equal(describeRules(validateRules({})), 'Graded cards from Collector Crypt');
    // the creator's own restock rule is part of the published line
    assert.equal(describeRules(validateRules({ restock: { category: 'one-piece', minValueUsd: 25, maxValueUsd: 100, minGrade: 9 } })), 'Graded cards from Collector Crypt · the treasury buys One Piece graded 9+ $25–$100');
    assert.equal(describeRules(validateRules({ restock: { maxValueUsd: 50 } })), 'Graded cards from Collector Crypt · the treasury buys any graded card up to $50');
    assert.ok(RULE_OPTIONS.gradMult.includes(2.5));
  });
});

function make({ assets = [asset(MINT)], creator = CREATOR } = {}) {
  const db = getTestDb();
  const built = [], admitted = [];
  const chain = {
    getAsset: async (id) => assets.find((x) => x.id === id) || null,
    getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(),
    simulateTransaction: async () => chain.sim || { err: null, logs: [] }, sim: null,
    // the admission's transfer, as the chain records it: signed by the creator unless a test says otherwise
    getParsedTransaction: async (sig) => (chain.txs[sig] !== undefined ? chain.txs[sig] : { meta: { err: null }, transaction: { message: { accountKeys: [{ pubkey: CREATOR, signer: true }] } } }), txs: {},
  };
  let clock = 1_800_000_000_000;
  const adm = createAdmissions({
    db, chain, vaultWallet: CUSTODY, creator, rules: VAULT_RULES.vault1,
    fetchAssets: async (rpc, owner) => assets.filter((a) => a.ownership.owner === owner),
    buildTransfer: async ({ mint, fromAddress, toAddress, recentBlockhash }) => { built.push({ mint, fromAddress, toAddress }); const tx = new Transaction({ feePayer: new PublicKey(fromAddress), recentBlockhash }); tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(fromAddress), toPubkey: new PublicKey(toAddress), lamports: 1 })); return tx.serialize({ requireAllSignatures: false }).toString('base64'); },
    now: () => clock, haircut: 0.89, onAdmitted: (m) => admitted.push(m),
  });
  return { adm, db, built, chain, admitted, tick: (ms) => { clock += ms; } };
}
const rejectsWith = async (p, code) => { try { await p; assert.fail('expected rejection'); } catch (e) { assert.equal(e.statusCode, code, e.message); } };

describe('admissions — eligibility for THIS vault', () => {
  test('anyone can look: what passes, what does not with the reason; canSend only for the creator', async () => {
    const { adm } = make({ assets: [asset(MINT), asset('p', { collection: PHYG }), asset('z', { collection: 'Spam111111111111111111111111111111111111111' }), asset('s', { owner: STRANGER })] });
    const out = await adm.eligible(CREATOR);
    assert.equal(out.canSend, true);
    assert.equal(out.eligible.length, 1); assert.equal(out.eligible[0].mint, MINT); assert.equal(out.eligible[0].realisableUsd, 35.6); assert.equal(out.eligible[0].owedUsd, undefined);
    assert.deepEqual(out.ineligible.map((x) => [x.mint, x.reason, x.custodian, x.imageUrl]), [
      ['p', 'custodian not accepted by this vault: Phygitals', 'Phygitals', 'https://x/p.jpg'],
      ['z', 'unknown custodian', null, null], // a stranger's NFT: listed, never pictured
    ]);
    assert.equal((await adm.eligible(STRANGER)).canSend, false);
  });
});

describe('admissions — build the transfer for the creator to sign', () => {
  test('creator → custody, fee payer = creator, single unsigned signer; message for Phantom', async () => {
    const { adm, built } = make();
    const out = await adm.build({ owner: CREATOR, mint: MINT });
    assert.deepEqual(built, [{ mint: MINT, fromAddress: CREATOR, toAddress: CUSTODY }]);
    const tx = Transaction.from(Buffer.from(out.transaction, 'base64'));
    assert.equal(tx.feePayer.toBase58(), CREATOR); assert.equal(tx.signatures.length, 1); assert.equal(tx.signatures[0].signature, null);
    assert.ok(out.message.length > 40); assert.equal(out.valueUsd, 40);
  });
  test('a stranger is refused (403) even with an eligible card; a vault with no creator takes nothing', async () => {
    const { adm } = make({ assets: [asset('s', { owner: STRANGER })] });
    await rejectsWith(adm.build({ owner: STRANGER, mint: 's' }), 403);
    const { adm: none } = make({ creator: null });
    await rejectsWith(none.build({ owner: CREATOR, mint: MINT }), 403);
  });
  test('pre-flight: a transfer that would fail on chain is refused with 409 and the log — the wallet never sees it', async () => {
    const { adm, chain } = make();
    chain.sim = { err: { InstructionError: [0, { Custom: 17 }] }, logs: ['Program log: Account is frozen'] };
    await rejectsWith(adm.build({ owner: CREATOR, mint: MINT }), 409);
  });
  test('refuses what the creator does not hold (404), what fails the rules (422), and a bad owner (400)', async () => {
    const { adm } = make({ assets: [asset(MINT), asset('p', { collection: PHYG })] });
    await rejectsWith(adm.build({ owner: CREATOR, mint: 'nope' }), 404);
    await rejectsWith(adm.build({ owner: CREATOR, mint: 'p' }), 422);
    await rejectsWith(adm.build({ owner: 'bad', mint: MINT }), 400);
  });
});

describe('admissions — record and verify', () => {
  test('recorded as pending; verified when the chain says custody owns it; then it joins the manifest', async () => {
    const { adm, chain, admitted } = make();
    const r = adm.record({ mint: MINT, owner: CREATOR, signature: 'SGA1', valueUsd: 40 });
    assert.equal(r.status, 'pending'); assert.equal(r.owedUsd, undefined);
    assert.equal((await adm.verifyPending()).verified, 0);           // still owned by the creator
    chain.getAsset = async (id) => ({ ...asset(id), ownership: { owner: CUSTODY } });
    assert.equal((await adm.verifyPending()).verified, 1);
    assert.deepEqual(admitted, [MINT]);
    const list = adm.list();
    assert.equal(list[0].status, 'admitted'); assert.equal(list[0].signature, 'SGA1');
  });
  test('the same signature twice is one admission (409); a stranger cannot record (403)', () => {
    const { adm } = make();
    adm.record({ mint: MINT, owner: CREATOR, signature: 'SGA1', valueUsd: 40 });
    assert.throws(() => adm.record({ mint: MINT, owner: CREATOR, signature: 'SGA1', valueUsd: 40 }), (e) => e.statusCode === 409);
    assert.throws(() => adm.record({ mint: MINT, owner: STRANGER, signature: 'SGA2', valueUsd: 40 }), (e) => e.statusCode === 403);
  });
});

describe('admissions — what the public Activity shows is read from the chain', () => {
  const inCustody = (chain) => { chain.getAsset = async (id) => ({ ...asset(id), ownership: { owner: CUSTODY } }); };
  test('pending shows no value; once admitted, the value is the custodian\'s, read from the chain (not the one sent)', async () => {
    const { adm, chain } = make();
    adm.record({ mint: MINT, owner: CREATOR, signature: 'SGA1', valueUsd: 99999 });
    assert.equal(adm.list()[0].valueUsd, null, 'nothing shown while pending');
    inCustody(chain);
    await adm.verifyPending();
    assert.equal(adm.list()[0].status, 'admitted'); assert.equal(adm.list()[0].valueUsd, 40);
  });
  test('a transfer not signed by the creator (or failed on chain) is rejected, not admitted', async () => {
    const { adm, chain, admitted, db } = make();
    adm.record({ mint: MINT, owner: CREATOR, signature: 'SGA9', valueUsd: 40 });
    chain.txs.SGA9 = { meta: { err: null }, transaction: { message: { accountKeys: [{ pubkey: STRANGER, signer: true }] } } };
    inCustody(chain);
    await adm.verifyPending();
    assert.equal(db.prepare('SELECT status FROM vault_admissions').get().status, 'rejected'); assert.deepEqual(admitted, []);
    assert.deepEqual(adm.list(), [], 'a rejected admission is not in the public Activity');
  });
  test('mint must be an address and the signature base58 (400); a pending admission that never lands expires', async () => {
    const { adm, tick, db } = make();
    assert.throws(() => adm.record({ mint: '<b>x</b>', owner: CREATOR, signature: 'SGA1', valueUsd: 40 }), (e) => e.statusCode === 400);
    assert.throws(() => adm.record({ mint: MINT, owner: CREATOR, signature: '"><a>', valueUsd: 40 }), (e) => e.statusCode === 400);
    adm.record({ mint: MINT, owner: CREATOR, signature: 'SGA1', valueUsd: 40 });
    tick(60 * 60_000 + 1);
    await adm.verifyPending();
    assert.equal(db.prepare('SELECT status FROM vault_admissions').get().status, 'expired');
    assert.deepEqual(adm.list(), [], 'an expired admission is not in the public Activity');
  });
});
