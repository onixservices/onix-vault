const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitOfTrade, PROTOCOL_FEE_PERCENT, PARTNER_SPLIT } = require('./split');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('a 10% fee with the creator at 40%: 2% protocol · 3.2% creator (on chain) · 4.8% partner = 3.2% vault treasury + 1.6% Onix', () => {
  const s = splitOfTrade(1000, 40);
  close(s.feePct, 10);
  close(s.protocolPct, 2);
  close(s.afterProtocolPct, 8);
  close(s.creatorPct, 3.2);
  close(s.partnerPct, 4.8);
  close(s.treasuryPct, 3.2);
  close(s.onixPct, 1.6);
});

test('the destinations add back up to the whole fee — nothing is lost or invented', () => {
  for (const c of [20, 30, 40, 50]) {
    const s = splitOfTrade(1000, c);
    close(s.protocolPct + s.creatorPct + s.treasuryPct + s.onixPct, s.feePct);
  }
});

test('the partner split sums to 100 and bad inputs are refused', () => {
  close(PARTNER_SPLIT.treasury + PARTNER_SPLIT.onix, 100);
  assert.throws(() => splitOfTrade(1000, 40, { treasury: 50, onix: 30 }));
  assert.throws(() => splitOfTrade(1000, 120));
});

test('the page translates every fee-share option with this same arithmetic (web/app.js shareOfTrade)', () => {
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
  const m = src.match(/function shareOfTrade\(creatorPct\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'web/app.js defines shareOfTrade');
  const shareOfTrade = new Function(m[0] + '; return shareOfTrade;')();
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'index.html'), 'utf8');
  const options = [...html.match(/<select id="f-fee">([\s\S]*?)<\/select>/)[1].matchAll(/<option value="(\d+)"[^>]*>([^<]*)<\/option>/g)];
  assert.ok(options.length >= 4, 'the choices are offered');
  for (const [, v, label] of options) {
    const ours = splitOfTrade(1000, Number(v)), page = shareOfTrade(Number(v));
    // every option says what it means per trade, so nobody reads "40%" as a 40% fee: it is 40% of the 8% left after Meteora
    const said = label.trim().match(/^(\d+)% \((\d+(?:\.\d+)?)% per trade\)$/);
    assert.ok(said && said[1] === v, `option "${label.trim()}" carries its per-trade meaning`);
    close(Number(said[2]), Math.round(ours.creatorPct * 100) / 100);
    close(page.creator, ours.creatorPct); close(page.treasury, ours.treasuryPct); close(page.onix, ours.onixPct); close(page.protocol, ours.protocolPct);
  }
});

test('our local PROTOCOL_FEE_PERCENT matches the SDK\'s — so the arithmetic cannot drift from the program', () => {
  const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
  assert.equal(PROTOCOL_FEE_PERCENT, sdk.PROTOCOL_FEE_PERCENT);
});
