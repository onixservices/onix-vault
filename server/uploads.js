/**
 * server/uploads.js — the coin image and banner a creator gives a vault. Small, content-addressed,
 * typed by the bytes (never by the name or the header the browser sent), served under /token/.
 *
 *   store(buffer)            → { uploadId, type, bytes }   PNG · JPEG · WebP only; ≤ maxBytes; name = sha256
 *   pathOf(uploadId)         → absolute path or null
 *   typeOf(uploadId)         → 'image/png' | 'image/jpeg' | 'image/webp' | null
 *   sweep({ keep })          → removes files older than `orphanMs` that no vault/creation references
 *
 * Why no SVG: it is a document that runs script. Why magic bytes: `Content-Type` is the client's claim.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = Object.freeze({
  png: { mime: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  jpg: { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { mime: 'image/webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
});
const LIMITS = Object.freeze({ maxBytes: 1024 * 1024, minBytes: 64, orphanMs: 60 * 60_000 });

function err(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }

function sniff(buf) { for (const [ext, t] of Object.entries(TYPES)) if (t.test(buf)) return { ext, mime: t.mime }; return null; }

function createUploads({ dir, limits = LIMITS, now = Date.now } = {}) {
  if (!dir) throw new Error('uploads need a directory');
  fs.mkdirSync(dir, { recursive: true });
  const idRe = /^[0-9a-f]{64}\.(png|jpg|webp)$/;

  function store(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < limits.minBytes) throw err(400, 'send the image bytes (PNG, JPEG or WebP)');
    if (buf.length > limits.maxBytes) throw err(413, `the image is ${Math.round(buf.length / 1024)} KB; up to ${Math.round(limits.maxBytes / 1024)} KB`);
    const kind = sniff(buf);
    if (!kind) throw err(415, 'only PNG, JPEG or WebP (read from the bytes, not the file name) — no SVG');
    const uploadId = `${crypto.createHash('sha256').update(buf).digest('hex')}.${kind.ext}`;
    const p = path.join(dir, uploadId);
    if (!fs.existsSync(p)) fs.writeFileSync(p, buf, { mode: 0o640 });
    return { uploadId, type: kind.mime, bytes: buf.length };
  }
  function valid(id) { return typeof id === 'string' && idRe.test(id); }
  function pathOf(id) { if (!valid(id)) return null; const p = path.join(dir, id); return fs.existsSync(p) ? p : null; }
  function typeOf(id) { if (!valid(id)) return null; return TYPES[id.split('.').pop()].mime; }
  /** Files nobody references after `orphanMs` are removed. `keep` = the ids vaults and creations point at. */
  function sweep({ keep = [] } = {}) {
    const k = new Set(keep); let removed = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!idRe.test(f) || k.has(f)) continue;
      const st = fs.statSync(path.join(dir, f));
      if (now() - st.mtimeMs > limits.orphanMs) { fs.unlinkSync(path.join(dir, f)); removed += 1; }
    }
    return { removed };
  }
  return { store, pathOf, typeOf, valid, sweep, LIMITS: limits, dir };
}

module.exports = { createUploads, sniff, LIMITS, TYPES };
