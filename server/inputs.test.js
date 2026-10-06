const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair } = require('@solana/web3.js');
const { isAddress, isSignatureText, safeImageUrl, shownImageUrl } = require('./inputs');

// What a client sends that ends up stored and shown on the public page is checked at the door:
// an address is a wallet address, a signature is base58, an image is an https URL.
describe('inputs — checked at the door', () => {
  test('an address is a real base58 public key, nothing else', () => {
    assert.equal(isAddress(Keypair.generate().publicKey.toBase58()), true);
    for (const bad of ['', 'M3', 'not a wallet', '"><img src=x>', null, 42, 'O0Il' + 'A'.repeat(40)]) assert.equal(isAddress(bad), false, String(bad));
  });
  test('a signature is base58 text of a sane length', () => {
    assert.equal(isSignatureText('5'.repeat(88)), true);
    assert.equal(isSignatureText('PAY1'), true);
    for (const bad of ['', '"><a href=x>', 'abc def', 'x'.repeat(101), null, {}]) assert.equal(isSignatureText(bad), false, String(bad));
  });
  test('an image is an https URL, normalised; anything else is dropped', () => {
    assert.equal(safeImageUrl('https://arweave.net/abc.png'), 'https://arweave.net/abc.png');
    assert.equal(safeImageUrl('https://x.test/a"><b>.png'), 'https://x.test/a%22%3E%3Cb%3E.png');
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>', 'http://plain.test/a.png', 'ipfs://Qm', '//x.test/a.png', '', null]) assert.equal(safeImageUrl(bad), null, String(bad));
  });
  test('a picture is relayed only for an item from a registered custodian: a stranger\'s NFT (a spam airdrop) never gets one', () => {
    const art = (image) => ({ content: { links: { image } } });
    assert.equal(shownImageUrl({ custodian: 'Collector Crypt' }, art('https://arweave.net/a.png')), 'https://arweave.net/a.png');
    assert.equal(shownImageUrl({ custodian: 'Phygitals' }, art('https://gateway.irys.xyz/b.png')), 'https://gateway.irys.xyz/b.png');
    assert.equal(shownImageUrl({ custodian: null }, art('https://ipfs.io/ipfs/claim-your-airdrop.png')), null);
    assert.equal(shownImageUrl({ custodian: 'Collector Crypt' }, art('javascript:alert(1)')), null);
    assert.equal(shownImageUrl({ custodian: 'Collector Crypt' }, {}), null);
  });
});
