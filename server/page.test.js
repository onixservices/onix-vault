const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// 12 Oct 2026: a visitor on a lossy network saw the HTML, clicked Create and nothing happened — the script had not
// arrived yet, and a 1.4 MB placeholder image was sharing the pipe with it. And a visitor without a wallet reached the
// Create step and found it empty. The page must stay light, and the step must ask for the wallet.
const web = (f) => fs.readFileSync(path.join(__dirname, '..', 'web', f), 'utf8');

describe('the page on a bad network and without a wallet', () => {
  test('the placeholder coin is small and loads lazily: every first visit fetches it, so it must not compete with the script', () => {
    assert.ok(fs.statSync(path.join(__dirname, '..', 'web', 'token', 'default.png')).size < 150_000, 'default.png under 150 KB');
    assert.match(web('index.html'), /<img id="tk-img" src="\/token\/default\.png" alt="" loading="lazy">/);
  });
  test('Create without a wallet asks for one inside step 1, with a button that connects, and the block follows the wallet state', () => {
    const html = web('index.html'), js = web('app.js');
    const step1 = html.slice(html.indexOf('id="c1"'), html.indexOf('id="c2"'));
    assert.ok(step1.length > 0 && /id="c-nowallet"/.test(step1) && /id="c-connect"/.test(step1), 'the connect block and its button live in step 1');
    assert.ok(/\$\('c-connect'\)\.addEventListener\('click'/.test(js), 'the button is wired');
    assert.ok(/\$\('c-nowallet'\)\.style\.display = a \? 'none' : ''/.test(js), 'the block hides when a wallet connects and returns when it disconnects');
    assert.ok(/connectWallet\(\{ quiet: true \}\)/.test(js), 'the step reports a missing wallet in its own text, not with an alert');
  });
});
