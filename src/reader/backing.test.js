// Pure logic only. Nothing here touches the network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCard, computeBacking, REALISABLE_MULTIPLIER, KNOWN_CUSTODIANS,
} = require('./backing');

// A DAS asset shaped like a real Collector Crypt card (trimmed to what we read).
function ccAsset(over = {}) {
  return {
    id: over.id || 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    grouping: [{ group_key: 'collection', group_value: 'CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac' }],
    content: {
      metadata: {
        name: over.name || 'Meowth',
        attributes: [
          { trait_type: 'The Grade', value: 'GEM-MT 10' },
          { trait_type: 'Grading Company', value: 'PSA' },
          { trait_type: 'Grading ID', value: '106361481' },
          { trait_type: 'Vault', value: 'OmniVault' },
          { trait_type: 'Category', value: 'Pokemon' },
          { trait_type: 'Insured Value', value: over.insured === undefined ? '$135' : over.insured },
        ],
      },
    },
  };
}

test('parseCard reads identity, custody and insured value from on-chain attributes', () => {
  const c = parseCard(ccAsset());
  assert.equal(c.mint, 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(c.name, 'Meowth');
  assert.equal(c.grade, 'GEM-MT 10');
  assert.equal(c.gradingCompany, 'PSA');
  assert.equal(c.certNumber, '106361481');
  assert.equal(c.vault, 'OmniVault');
  assert.equal(c.custodian, 'Collector Crypt');
  assert.equal(c.insuredUsd, 135);
  assert.equal(c.counts, true);
});

test('insured value accepts "$1,250" and rejects garbage', () => {
  assert.equal(parseCard(ccAsset({ insured: '$1,250' })).insuredUsd, 1250);
  assert.equal(parseCard(ccAsset({ insured: 'n/a' })).insuredUsd, null);
  assert.equal(parseCard(ccAsset({ insured: '0' })).insuredUsd, null);
});

test('a card with no insured value is listed but does NOT count toward backing', () => {
  const c = parseCard(ccAsset({ insured: 'n/a' }));
  assert.equal(c.counts, false);
  assert.equal(c.excludedBecause, 'no insured value');
});

test('an asset from an unknown collection is listed but does NOT count — nobody inflates a vault with random NFTs', () => {
  const a = ccAsset();
  a.grouping = [{ group_key: 'collection', group_value: 'SomeRandomCollection1111111111111111111111' }];
  const c = parseCard(a);
  assert.equal(c.custodian, null);
  assert.equal(c.counts, false);
  assert.equal(c.excludedBecause, 'unknown custodian');
});

test('both Collector Crypt collections are recognised (OmniVault and PWCC)', () => {
  for (const col of KNOWN_CUSTODIANS['Collector Crypt']) {
    const a = ccAsset();
    a.grouping = [{ group_key: 'collection', group_value: col }];
    assert.equal(parseCard(a).custodian, 'Collector Crypt', col);
  }
});

test('a Phygitals card is recognised as custodied but excluded for the TRUE reason: no value on chain', () => {
  const a = ccAsset({ insured: 'n/a' });
  a.grouping = [{ group_key: 'collection', group_value: 'phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC' }];
  const c = parseCard(a);
  assert.equal(c.custodian, 'Phygitals');
  assert.equal(c.counts, false);
  assert.equal(c.excludedBecause, 'no insured value');
});

test('computeBacking: index, realisable and per-token — and the two are never the same number', () => {
  const cards = [
    parseCard(ccAsset({ id: 'A', insured: '$100' })),
    parseCard(ccAsset({ id: 'B', insured: '$50' })),
    parseCard(ccAsset({ id: 'C', insured: 'n/a' })),   // excluded
  ];
  const b = computeBacking(cards, { supply: 1000 });
  assert.equal(b.cardsTotal, 3);
  assert.equal(b.cardsCounted, 2);
  assert.equal(b.cardsExcluded, 1);
  assert.equal(b.indexUsd, 150);
  assert.equal(b.realisableUsd, 150 * REALISABLE_MULTIPLIER);
  assert.ok(b.realisableUsd < b.indexUsd, 'realisable must be below index');
  assert.equal(b.realisablePerTokenUsd, (150 * REALISABLE_MULTIPLIER) / 1000);
  assert.equal(b.multiplier, REALISABLE_MULTIPLIER);
});

test('computeBacking without a supply reports per-token as null, never as zero', () => {
  const b = computeBacking([parseCard(ccAsset())]);
  assert.equal(b.realisablePerTokenUsd, null);
  assert.equal(b.indexPerTokenUsd, null);
});

test('computeBacking on an empty vault is an honest zero, not a crash', () => {
  const b = computeBacking([], { supply: 1000 });
  assert.equal(b.indexUsd, 0);
  assert.equal(b.realisableUsd, 0);
  assert.equal(b.medianInsuredUsd, null);
});

test('median is over counted cards only', () => {
  const cards = [10, 20, 30, 1000].map((v, i) => parseCard(ccAsset({ id: String(i), insured: `$${v}` })));
  cards.push(parseCard(ccAsset({ id: 'x', insured: 'n/a' })));
  assert.equal(computeBacking(cards).medianInsuredUsd, 25);
});
