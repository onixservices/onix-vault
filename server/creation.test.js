const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction, SystemProgram, PublicKey, TransactionInstruction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getTestDb } = require('./db');
const { createVaultCreator, curveParamsFor, checkCreatorPlusMint, instructionsOf, rowToDef, DECIDED, LIMITS } = require('./creation');
const { fromKeypair } = require('./signer');
const keyring = require('./keyring');
const { KNOWN_CUSTODIANS } = require('../src/reader/backing');
const sdkReal = require('@meteora-ag/dynamic-bonding-curve-sdk');

// The Create door, with custody (2 Oct 2026): the creator's items go into a wallet derived for
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
function make({ assets = [asset('a'), asset('b', '60')], poolOnChain = true, lamports = null } = {}) {
  const db = getTestDb();
  const sent = [], calls = [];
  const world = { assets: assets.map((a) => ({ ...a })), sol: {} };
  const chain = {
    getLatestBlockhash: async () => Keypair.generate().publicKey.toBase58(),
    sendRawTransaction: async (b64) => {
      sent.push(b64);
      // a "transfer" moves the card in our world; a SOL transfer credits the custody wallet
      const tx = Transaction.from(Buffer.from(b64, 'base64'));
      for (const ix of tx.instructions) {
        if (ix.programId.equals(SystemProgram.programId) && ix.data.length === 12) { const to = ix.keys[1].pubkey.toBase58(); world.sol[to] = (world.sol[to] || 0) + Number(ix.data.readBigUInt64LE(4)); }
        if (ix.programId.toBase58() === 'Fake1111111111111111111111111111111111111111') { const [mint, toPadded] = Buffer.from(ix.data).toString('utf8').split('>'); const to = toPadded.replace(/#+$/, ''); const a = world.assets.find((x) => x.id === mint); if (a) a.ownership = { owner: to }; }
      }
      return 'SIG' + sent.length;
    },
    waitForSignature: async () => ({ confirmationStatus: 'confirmed' }),
    simulateTransaction: async () => chain.sim || { err: null, logs: [] }, sim: null,
    getAccountInfoBase64: async () => (poolOnChain ? { data: ['AA=='] } : null),
    getBalanceLamports: async (w) => (lamports != null ? lamports : (world.sol[w] || 0)),
  };
  const client = {
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
    fetchAssets: async (rpc, owner) => world.assets.filter((a) => a.ownership.owner === owner), buildTransfer, metadataBase: 'https://v.test', now: () => 1_800_000_000_000, existingSymbols: () => ['VEONIX', 'TAKEN'], reservedIndexes: () => [0] });
  // the creator "signs and sends" the deposit txs in the world
  const deposit = async (txs) => { for (const b64 of txs) { const tx = Transaction.from(Buffer.from(b64, 'base64')); tx.partialSign(ownerKp); await chain.sendRawTransaction(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')); } };
  return { creator, db, chain, sent, calls, world, deposit };
}
const rejects = async (p, code) => { try { await p; assert.fail('expected rejection'); } catch (e) { assert.equal(e.statusCode, code, e.message); } };

describe('Create door — quote', () => {
  test('what the wallet holds that THESE rules take, and the curve it implies; the creator\'s share is worth the items on day one', async () => {
    const { creator } = make();
    const q = await creator.quote({ owner: OWNER });
    assert.equal(q.items.length, 2); assert.equal(q.indexUsd, 100); assert.equal(q.realisableUsd, 89);
    assert.equal(q.canCreate, true); assert.equal(q.curve.openingMcapUsd, 178); assert.equal(q.creatorTokensWorthUsd, 89); assert.equal(q.gasSol, LIMITS.gasSol);
    const q2 = await creator.quote({ owner: OWNER, rules: { minValueUsd: 50 } });
    assert.equal(q2.items.length, 1); assert.equal(q2.ineligible.length, 1);
    await rejects(creator.quote({ owner: OWNER, rules: { category: 'wine' } }), 422);
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
    const { creator } = make({ assets: many });
    for (let i = 0; i < LIMITS.maxOpenPerHour; i++) await creator.open({ owner: many[i].ownership.owner, name: 'v' + i, symbol: 'V' + i, mints: [many[i].id] });
    await rejects(creator.open({ owner: many[10].ownership.owner, name: 'v10', symbol: 'V10', mints: [many[10].id] }), 429);
  });
});

describe('Create door — deposited → config (Onix pays, custody is the fee claimer) → launch tx (unsigned)', () => {
  test('before the items land, 409 and no config; after, the config is created once and the launch tx is built for the creator', async () => {
    const { creator, chain, calls, sent, deposit, db } = make();
    const o = await creator.open({ owner: OWNER, name: 'My Cards', symbol: 'MYC', mints: ['a', 'b'] });
    await rejects(creator.deposited({ creationId: o.creationId }), 409);
    assert.equal(calls.length, 0, 'no config before the deposit');
    await deposit(o.depositTransactions);
    const d = await creator.deposited({ creationId: o.creationId });
    assert.equal(calls[0][0], 'config');
    assert.equal(calls[0][1].feeClaimer.toBase58(), o.custodyWallet, 'the vault treasury is its custody wallet');
    assert.equal(calls[0][1].payer.toBase58(), partnerKp.publicKey.toBase58(), 'Onix pays the config');
    assert.ok(Transaction.from(Buffer.from(sent[sent.length - 1], 'base64')).verifySignatures(), 'config tx fully signed (partner + config key)');
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
    assert.equal(r.returned.length, 2);
    assert.equal(w.world.assets.filter((a) => a.ownership.owner === OWNER).length, 2, 'both cards are back with the creator');
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
    assert.equal(out.length, 1); assert.equal(out[0].returned.length, 1);
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
