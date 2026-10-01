const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createItemsReader } = require('./items');
const { KNOWN_CUSTODIANS } = require('../src/reader/backing');

// Items come from the chain through the same reader the proof page uses, with the
// custodian registry deciding what counts. A JSON market reference is optional.
const CC = Object.values(KNOWN_CUSTODIANS)[0][0];
const asset = (id, insured, collection = CC) => ({
  id, grouping: [{ group_key: 'collection', group_value: collection }],
  content: { links: { image: `https://img/${id}.jpg` }, metadata: { name: `Card ${id}`, attributes: [
    ...(insured == null ? [] : [{ trait_type: 'Insured Value', value: `$${insured}` }]),
    { trait_type: 'Category', value: 'Pokemon' }, { trait_type: 'The Grade', value: '10' },
  ] } },
});

describe('items reader', () => {
  test('counts only registered custodians with a value; adds the market reference when present; caches', async () => {
    let t = 0;
    const rpcCalls = [];
    const reader = createItemsReader({
      rpcUrl: 'http://rpc', vaultWallet: 'V', marketRefUrl: 'http://refs', cacheMs: 1000, now: () => t,
      fetchImpl: async (url) => { rpcCalls.push(url); return { ok: true, json: async () => ({ A: 26 }) }; },
      fetchAssets: async () => [asset('A', 20), asset('B', null), asset('C', 50, 'UnknownCollection')],
    });
    const items = await reader();
    assert.deepEqual(items.map((i) => i.mint), ['A']);
    assert.equal(items[0].custodianValueUsd, 20); assert.equal(items[0].marketRefUsd, 26);
    assert.equal(items[0].imageUrl, 'https://img/A.jpg', "the photo is the token's own image, served to the page");
    t = 500; await reader(); assert.equal(rpcCalls.length, 1);   // cached
    t = 2000; await reader(); assert.equal(rpcCalls.length, 2);  // refreshed
  });
});
