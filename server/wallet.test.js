const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createWalletReader } = require('./wallet');
const { Keypair } = require('@solana/web3.js');
const W = Keypair.generate().publicKey.toBase58();

// "Create a vault" step 1: what in a wallet can back a token. The rule is the
// custodian's, not ours: registered custodian + a value written into the token.
const CC = 'CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac'; // a registered Collector Crypt collection (see src/reader/backing.js)

const asset = (id, { collection = CC, insured = '35', name = 'Card' } = {}) => ({
  id, content: { metadata: { name, attributes: insured == null ? [] : [{ trait_type: 'Insured Value', value: insured }] }, links: { image: 'https://x/y.jpg' } },
  grouping: collection ? [{ group_key: 'collection', group_value: collection }] : [],
});

describe('wallet — eligible items', () => {
  test('splits a wallet into eligible (counted) and ineligible with the reason; never silently drops', async () => {
    const fetchAssets = async (rpc, owner) => { assert.equal(owner, W); return [asset('ok'), asset('no-cust', { collection: 'SomeOtherCollection11111111111111111111111' }), asset('no-val', { insured: null })]; };
    const read = createWalletReader({ rpcUrl: 'x', fetchAssets });
    const out = await read(W);
    assert.deepEqual(out.eligible.map((i) => i.mint), ['ok']);
    assert.equal(out.eligible[0].custodianValueUsd, 35);
    assert.equal(out.eligible[0].imageUrl, 'https://x/y.jpg');
    assert.deepEqual(out.ineligible.map((i) => [i.mint, i.reason]), [['no-cust', 'unknown custodian'], ['no-val', 'no insured value']]);
    assert.equal(out.total, 3);
  });
  test('a wallet that is not a public key is refused with 400', async () => {
    const read = createWalletReader({ rpcUrl: 'x', fetchAssets: async () => [] });
    await assert.rejects(read('not-a-key'), (e) => e.statusCode === 400);
  });
});
