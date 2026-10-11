const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The pre-commit hook is the last door before a PUBLIC repository: run it against staged files in a throwaway
// git repo and check what it refuses. Values below are fake (repeated bytes), never a real key.
const HOOK = path.join(__dirname, '..', '.githooks', 'pre-commit');
const hasTools = spawnSync('git', ['--version']).status === 0 && spawnSync('bash', ['--version']).status === 0;

function hookOn(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-hook-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  for (const [name, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), body); git('add', name); }
  const r = spawnSync('bash', [HOOK], { cwd: dir, encoding: 'utf8' });
  return { blocked: r.status !== 0, out: r.stdout + r.stderr };
}

const HEX64 = 'ab'.repeat(32);

describe('pre-commit — what never reaches the public repository', { skip: !hasTools && 'git/bash not available' }, () => {
  test('a master seed or draw key assigned a hex value is refused', () => {
    assert.ok(hookOn({ 'scripts/x.sh': `VAULT_MASTER_SEED=${HEX64}\n` }).blocked);
    assert.ok(hookOn({ 'scripts/y.js': `const DRAW_KEY = '${HEX64}';\n` }).blocked);
  });
  test('32 bytes of hex on their own, outside a test file, are refused', () => {
    assert.ok(hookOn({ 'server/z.js': `module.exports = '${HEX64}';\n` }).blocked);
  });
  test('a key in a URL is refused on any host, and in a doc or an example file too', () => {
    // the fake values are assembled at run time so this file never carries the shape the hook refuses
    const KEY = 'abcdef0123456789'.repeat(2);
    assert.ok(hookOn({ 'docs/x.md': `rpc: https://mainnet.some-rpc.io/?api-key=${KEY}\n` }).blocked);
    assert.ok(hookOn({ 'server/env.example': `ONIX_VAULT_RPC_URL=https://rpc.other-host.com/v1?token=${KEY}\n` }).blocked);
  });
  test('a GitHub token is refused', () => {
    assert.ok(hookOn({ 'scripts/x.sh': `TOKEN=ghp_${'a'.repeat(36)}\n` }).blocked);
  });
  test('an example file that only names the variables passes', () => {
    // the variable names are assembled at run time: written out, this test file would itself trip the code patterns
    const names = ['ONIX_VAULT_RPC_URL', ['VAULT_SECRET', 'KEY'].join('_'), ['VAULT_MASTER', 'SEED'].join('_')];
    const r = hookOn({ 'server/env.example': names.map((n) => `${n}=\n`).join('') });
    assert.equal(r.blocked, false, r.out);
  });
  test('reading the seed from the environment, and throwaway seeds in tests, pass', () => {
    const r = hookOn({ 'server/config.js': "module.exports = { KEYRING_SEED: env('VAULT_MASTER_SEED') };\n", 'server/k.test.js': `const SEED = '${HEX64}';\n` });
    assert.equal(r.blocked, false, r.out);
  });
});
