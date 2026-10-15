const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// 12 Oct 2026: a visitor on a lossy network saw the HTML, clicked Create and nothing happened — the script had not
// arrived yet, and a 1.4 MB placeholder image was sharing the pipe with it. And a visitor without a wallet reached the
// Create step and found it empty. The page must stay light, and the step's one button must know the wallet state.
const web = (f) => fs.readFileSync(path.join(__dirname, '..', 'web', f), 'utf8');

describe('the page on a bad network and without a wallet', () => {
  test('the placeholder coin is small and loads lazily: every first visit fetches it, so it must not compete with the script', () => {
    assert.ok(fs.statSync(path.join(__dirname, '..', 'web', 'token', 'default.png')).size < 150_000, 'default.png under 150 KB');
    assert.match(web('index.html'), /<img id="tk-img" src="\/token\/default\.png" alt="" loading="lazy">/);
  });
  test('Create shows the SOL a launch needs against what the wallet holds — green when it is there, the warning colour when it is not, and no launch while it is short', () => {
    const html = web('index.html'), js = web('app.js');
    const step1 = html.slice(html.indexOf('id="c1"'), html.indexOf('id="c2"')), step3 = html.slice(html.indexOf('id="c3"'));
    assert.ok(/id="c-sol"/.test(step1) && /id="c3-sol"/.test(step3), 'the line lives in step 1 and next to the launch button');
    const fn = js.slice(js.indexOf('function solLine('), js.indexOf('function scan('));
    assert.ok(fn.length > 0, 'solLine exists');
    assert.ok(/'var\(--brand\)' : 'var\(--warn\)'/.test(fn), 'green when the SOL is there, the warning colour when it is not');
    assert.ok(/a launch needs about/.test(fn), 'the line says what a launch needs');
    assert.ok(/\$\('c-launch'\)\.disabled = !!\(s && s\.short\)/.test(fn), 'no launch while the wallet is short');
    assert.ok(/CQ = q; solLine\(q\);/.test(js), 'the quote feeds the line');
  });
  test('Create has one button that knows the wallet state: "Connect wallet" without one, then "Next" — no second button', () => {
    const html = web('index.html'), js = web('app.js');
    const step1 = html.slice(html.indexOf('id="c1"'), html.indexOf('id="c2"'));
    assert.ok(step1.length > 0 && !/id="c-connect"|id="c-nowallet"/.test(step1), 'no separate connect button in step 1');
    assert.match(step1, /<button class="cta" id="to2">Connect wallet<\/button>/, 'the step opens asking for the wallet, on the one button');
    const next = js.slice(js.indexOf('function nextButton('), js.indexOf('function scan('));
    assert.ok(next.length > 0, 'nextButton exists');
    assert.ok(/if \(!W\.addr\) \{ b\.textContent = 'Connect wallet'; b\.disabled = false; return; \}/.test(next), 'without a wallet the button is Connect wallet and enabled');
    assert.ok(/b\.textContent = 'Next: name your token'/.test(next), 'with a wallet and cards read, the button is Next');
    const click = js.slice(js.indexOf("$('to2').addEventListener('click'"), js.indexOf("$('to3').addEventListener('click'"));
    assert.ok(/if \(!W\.addr\) \{[^}]*connectWallet\(\{ quiet: true \}\)/.test(click), 'the same button connects when there is no wallet, quietly');
    assert.ok(/if \(!CQ\) \{ scan\(W\.addr\); return; \}/.test(click), 'and re-reads the wallet after a failed read');
    assert.ok(/renderPick\(\);\s*\}\s*else if \(h\.indexOf\('#\/create'\) === 0\)|else renderPick\(\); \}/.test(js), 'routing to Create without a wallet paints the button');
  });
});
