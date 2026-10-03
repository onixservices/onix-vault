const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUploads, sniff } = require('./uploads');

// The coin image and banner: typed by the bytes, capped in size, named by hash, swept when orphaned.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(200, 3)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' + ' '.repeat(100));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vault-up-'));

describe('uploads — what gets in', () => {
  test('PNG, JPEG and WebP are stored under their sha256 with the right extension; the same bytes twice = the same id', () => {
    const u = createUploads({ dir: tmp() });
    const a = u.store(PNG), b = u.store(JPG), c = u.store(WEBP);
    assert.match(a.uploadId, /^[0-9a-f]{64}\.png$/); assert.equal(a.type, 'image/png'); assert.equal(a.bytes, PNG.length);
    assert.match(b.uploadId, /\.jpg$/); assert.match(c.uploadId, /\.webp$/);
    assert.equal(u.store(PNG).uploadId, a.uploadId);
    assert.ok(u.pathOf(a.uploadId)); assert.equal(u.typeOf(b.uploadId), 'image/jpeg');
  });
  test('SVG, text, a PNG header on a .svg name, and oversized files are refused with the reason', () => {
    const u = createUploads({ dir: tmp(), limits: { maxBytes: 300, minBytes: 64, orphanMs: 1 } });
    assert.throws(() => u.store(SVG), (e) => e.statusCode === 415);
    assert.throws(() => u.store(Buffer.alloc(100, 0x41)), (e) => e.statusCode === 415);
    assert.throws(() => u.store(Buffer.alloc(10)), (e) => e.statusCode === 400);
    assert.throws(() => u.store(Buffer.concat([PNG, Buffer.alloc(200)])), (e) => e.statusCode === 413);
    assert.equal(sniff(SVG), null); assert.equal(sniff(PNG).ext, 'png');
  });
  test('ids are validated before touching the disk (no path tricks)', () => {
    const u = createUploads({ dir: tmp() });
    assert.equal(u.pathOf('../../etc/passwd'), null); assert.equal(u.pathOf('abc.png'), null); assert.equal(u.typeOf('x.svg'), null);
    assert.equal(u.valid('a'.repeat(64) + '.png'), true); assert.equal(u.valid('a'.repeat(64) + '.svg'), false);
  });
  test('sweep removes old files nobody references and keeps the referenced ones', () => {
    let t = 1_000_000;
    const u = createUploads({ dir: tmp(), limits: { maxBytes: 1e6, minBytes: 64, orphanMs: 1000 }, now: () => t });
    const a = u.store(PNG), b = u.store(JPG);
    const old = Date.now() - 10_000; fs.utimesSync(u.pathOf(a.uploadId), old / 1000, old / 1000); fs.utimesSync(u.pathOf(b.uploadId), old / 1000, old / 1000);
    t = Date.now();
    assert.deepEqual(u.sweep({ keep: [b.uploadId] }), { removed: 1 });
    assert.equal(u.pathOf(a.uploadId), null); assert.ok(u.pathOf(b.uploadId));
  });
});
