const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction } = require('@solana/web3.js');
const { getTestDb } = require('./db');
const { VAULT_RULES, itemPassesRules, createAdmissions } = require('./admissions');
const { KNOWN_CUSTODIANS } = require('../src/reader/backing');

// "Send a card": only what passes THIS vault's rules can be built; the user signs the
// transfer; the admission is recorded, verified on chain (the vault now owns it), and
// carries what the sender is owed — tokens worth 80% of realisable, bought on the curve
// when the vault has USDC, locked 12 months. The operator never mints anything.
const vaultKp = Keypair.generate(); const VAULT = vaultKp.publicKey.toBase58();
const OWNER = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();
const CC = KNOWN_CUSTODIANS['Collector Crypt'][0];
const PHYG = KNOWN_CUSTODIANS['Phygitals'][0];

const asset = (id, { collection = CC, insured = '40', owner = OWNER } = {}) => ({
  id, ownership: { owner, frozen: false }, burnt: false, interface: 'V1_NFT',
  grouping: collection ? [{ group_key: 'collection', group_value: collection }] : [],
  content: { links: { image: 'https://x/' + id + '.jpg' }, metadata: { name: 'Card ' + id, attributes: [
    ...(insured == null ? [] : [{ trait_type: 'Insured Value', value: insured }]), { trait_type: 'Category', value: 'Pokemon' }, { trait_type: 'The Grade', value: '10' },
  ] } },
});

describe('vault rules', () => {
  test('Vault #1: Collector Crypt graded cards with a value on chain; Phygitals and unknowns are listed with the reason', () => {
    const rules = VAULT_RULES.vault1;
    assert.deepEqual(itemPassesRules(asset('a'), rules), { ok: true, reason: null });
    assert.deepEqual(itemPassesRules(asset('b', { collection: PHYG }), rules), { ok: false, reason: 'custodian not accepted by this vault: Phygitals' });
    assert.deepEqual(itemPassesRules(asset('c', { collection: 'Zzz' }), rules), { ok: false, reason: 'unknown custodian' });
    assert.deepEqual(itemPassesRules(asset('d', { insured: null }), rules), { ok: false, reason: 'no insured value' });
    assert.deepEqual(itemPassesRules(asset('e', { insured: '5' }), { ...rules, minValueUsd: 10 }), { ok: false, reason: 'below the vault\'s minimum value ($10)' });
  });
});

function make({ assets = [asset(MINT)], ownerOnChain = null, usdc = 0 } = {}) {
  const db = getTestDb();
  const built = [];
  const swaps = [];
  const sent = [];
  const chain = {
    getAsset: async (id) => { const a = assets.find((x) => x.id === id); if (!a) return null; return ownerOnChain ? { ...a, ownership: { ...a.ownership, owner: ownerOnChain } } : a; },
    getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(),
    getSignatureStatuses: async () => [{ confirmationStatus: 'finalized', err: null }],
    simulateTransaction: async () => chain.sim || { err: null, logs: [] },
    sendRawTransaction: async (b64) => { sent.push(b64); return 'SENT'; },
    sim: null,
  };
  // the curve trader as the vault sees it: build() returns an unsigned tx with the vault as the single signer
  const trader = { build: async ({ owner, side, amount }) => { swaps.push({ owner, side, amount }); const { SystemProgram, PublicKey } = require('@solana/web3.js'); const tx = new Transaction({ feePayer: new PublicKey(owner), recentBlockhash: Keypair.generate().publicKey.toBase58() }); tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(owner), toPubkey: new PublicKey(OWNER), lamports: 1 })); return { quote: { amountOut: amount * 1000 }, transaction: tx.serialize({ requireAllSignatures: false }).toString('base64') }; } };
  const signer = require('./signer').fromKeypair(vaultKp);
  const adm = createAdmissions({
    db, chain, vaultWallet: VAULT, rules: VAULT_RULES.vault1,
    fetchAssets: async (rpc, owner) => assets.filter((a) => a.ownership.owner === owner),
    buildTransfer: async ({ mint, fromAddress, toAddress, recentBlockhash }) => { built.push({ mint, fromAddress, toAddress }); const { SystemProgram, PublicKey } = require('@solana/web3.js'); const tx = new Transaction({ feePayer: new PublicKey(fromAddress), recentBlockhash }); tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(fromAddress), toPubkey: new PublicKey(toAddress), lamports: 1 })); return tx.serialize({ requireAllSignatures: false }).toString('base64'); },
    now: () => 1_800_000_000_000, haircut: 0.89, admission: 0.8,
    trader, signer, getUsdcBalance: async () => usdc,
  });
  return { adm, db, built, chain, swaps, sent };
}
const rejectsWith = async (p, code) => { try { await p; assert.fail('expected rejection'); } catch (e) { assert.equal(e.statusCode, code, e.message); } };

describe('admissions — eligibility for THIS vault', () => {
  test('lists what in the wallet can go in, and what cannot with the reason; owed = value × 0.89 × 0.8', async () => {
    const { adm } = make({ assets: [asset(MINT), asset('p', { collection: PHYG })] });
    const out = await adm.eligible(OWNER);
    assert.equal(out.eligible.length, 1); assert.equal(out.eligible[0].mint, MINT); assert.equal(out.eligible[0].owedUsd, 28.48);
    assert.deepEqual(out.ineligible.map((x) => x.reason), ['custodian not accepted by this vault: Phygitals']);
  });
});

describe('admissions — build the transfer for the owner to sign', () => {
  test('owner → vault, fee payer = owner, single unsigned signer; message for Phantom', async () => {
    const { adm, built } = make();
    const out = await adm.build({ owner: OWNER, mint: MINT });
    assert.deepEqual(built, [{ mint: MINT, fromAddress: OWNER, toAddress: VAULT }]);
    const tx = Transaction.from(Buffer.from(out.transaction, 'base64'));
    assert.equal(tx.feePayer.toBase58(), OWNER); assert.equal(tx.signatures.length, 1); assert.equal(tx.signatures[0].signature, null);
    assert.ok(out.message.length > 40); assert.equal(out.owedUsd, 28.48);
  });
  test('pre-flight: a transfer that would fail on chain (frozen, delegated…) is refused with 409 and the log — the wallet never sees it', async () => {
    const { adm, chain } = make();
    chain.sim = { err: { InstructionError: [0, { Custom: 17 }] }, logs: ['Program log: Account is frozen'] };
    await rejectsWith(adm.build({ owner: OWNER, mint: MINT }), 409);
  });
  test('refuses what the owner does not hold (404), what fails the rules (422), and a bad owner (400)', async () => {
    const { adm } = make({ assets: [asset(MINT), asset('p', { collection: PHYG })] });
    await rejectsWith(adm.build({ owner: OWNER, mint: 'nope' }), 404);
    await rejectsWith(adm.build({ owner: OWNER, mint: 'p' }), 422);
    await rejectsWith(adm.build({ owner: 'bad', mint: MINT }), 400);
  });
});

describe('admissions — record and verify', () => {
  test('recorded as pending with the owed amount; verified when the chain says the vault owns it; then listed as admitted · tokens pending', async () => {
    const { adm, chain } = make();
    const r = adm.record({ mint: MINT, owner: OWNER, signature: 'SIG1', valueUsd: 40 });
    assert.equal(r.status, 'pending'); assert.equal(r.owedUsd, 28.48);
    assert.equal((await adm.verifyPending()).verified, 0);           // still owned by the sender
    chain.getAsset = async (id) => ({ ...asset(id), ownership: { owner: VAULT } });
    assert.equal((await adm.verifyPending()).verified, 1);
    const list = adm.list();
    assert.equal(list[0].status, 'admitted'); assert.equal(list[0].tokens, 'pending'); assert.equal(list[0].signature, 'SIG1'); assert.equal(list[0].owedUsd, 28.48);
  });
  test('tokens: once admitted, the vault buys the owed USDC worth on the curve — only when it has the USDC; signed by the vault, locked 12 months', async () => {
    const { adm, chain, swaps } = make({ usdc: 10 });
    adm.record({ mint: MINT, owner: OWNER, signature: 'SIG1', valueUsd: 40 });
    assert.deepEqual(await adm.settleTokens(), { checked: 0, bought: 0 }, 'nothing to buy while the admission is only pending');
    chain.getAsset = async (id) => ({ ...asset(id), ownership: { owner: VAULT } });
    await adm.verifyPending();
    // $10 in the vault < $28.48 owed → waits, says so, builds nothing
    assert.deepEqual(await adm.settleTokens(), { checked: 1, bought: 0 });
    assert.equal(swaps.length, 0);
    assert.equal(adm.list()[0].tokens, 'waiting');
    assert.match(adm.list()[0].tokensNote, /needs \$28\.48 USDC and has \$10\.00/);
  });
  test('tokens: with the USDC there, the buy is built as the vault, signed, persisted then broadcast; the row carries signature, amount and unlock date', async () => {
    const { adm, chain, swaps, sent } = make({ usdc: 100 });
    adm.record({ mint: MINT, owner: OWNER, signature: 'SIG1', valueUsd: 40 });
    chain.getAsset = async (id) => ({ ...asset(id), ownership: { owner: VAULT } });
    await adm.verifyPending();
    assert.deepEqual(await adm.settleTokens(), { checked: 1, bought: 1 });
    assert.deepEqual(swaps, [{ owner: VAULT, side: 'buy', amount: 28.48 }]);
    assert.equal(sent.length, 1);
    const signed = Transaction.from(Buffer.from(sent[0], 'base64'));
    assert.ok(signed.verifySignatures(), 'the vault signed what was broadcast');
    const row = adm.list()[0];
    assert.equal(row.tokens, 'locked'); assert.ok(row.tokensSignature); assert.equal(row.tokensAmount, 28480);
    assert.equal(row.unlockAt, 1_800_000_000_000 + 12 * 30.4375 * 86_400_000);
    assert.deepEqual(await adm.settleTokens(), { checked: 0, bought: 0 }, 'never bought twice');
  });
  test('tokens: a buy that fails to build (e.g. 402 from the curve pre-flight) leaves the row waiting with the reason, nothing signed', async () => {
    const { adm, chain, sent } = make({ usdc: 100 });
    adm.record({ mint: MINT, owner: OWNER, signature: 'SIG1', valueUsd: 40 });
    chain.getAsset = async (id) => ({ ...asset(id), ownership: { owner: VAULT } });
    await adm.verifyPending();
    adm._trader.build = async () => { const e = new Error('the trade would fail on chain: slippage'); e.statusCode = 409; throw e; };
    assert.deepEqual(await adm.settleTokens(), { checked: 1, bought: 0 });
    assert.equal(sent.length, 0);
    assert.equal(adm.list()[0].tokens, 'waiting'); assert.match(adm.list()[0].tokensNote, /slippage/);
  });
  test('the same signature twice is one admission (409)', () => {
    const { adm } = make();
    adm.record({ mint: MINT, owner: OWNER, signature: 'SIG1', valueUsd: 40 });
    assert.throws(() => adm.record({ mint: MINT, owner: OWNER, signature: 'SIG1', valueUsd: 40 }), (e) => e.statusCode === 409);
  });
});
