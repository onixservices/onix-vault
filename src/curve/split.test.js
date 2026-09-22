const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitOfTrade, PROTOCOL_FEE_PERCENT, OPERATOR_SPLIT } = require('./split');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('a 10% fee: 2% of the trade is the protocol\'s, 8% is ours, split 4 / 2.4 / 1.6', () => {
  const s = splitOfTrade(1000);
  close(s.feePct, 10);
  close(s.protocolPct, 2);
  close(s.oursPct, 8);
  close(s.buyCardPct, 4);
  close(s.buybackPct, 2.4);
  close(s.operatorPct, 1.6);
});

test('the destinations add back up to the whole fee — nothing is lost or invented', () => {
  const s = splitOfTrade(1000);
  close(s.protocolPct + s.buyCardPct + s.buybackPct + s.operatorPct, s.feePct);
});

test('our published split sums to 100', () => {
  assert.equal(OPERATOR_SPLIT.buyCard + OPERATOR_SPLIT.buyback + OPERATOR_SPLIT.operator, 100);
  assert.throws(() => splitOfTrade(1000, { buyCard: 50, buyback: 30, operator: 30 }));
});

test('our local PROTOCOL_FEE_PERCENT matches the SDK\'s — so the arithmetic cannot drift from the program', () => {
  const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
  assert.equal(PROTOCOL_FEE_PERCENT, sdk.PROTOCOL_FEE_PERCENT);
});
