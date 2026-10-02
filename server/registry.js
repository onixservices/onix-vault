/**
 * server/registry.js — the vaults this server serves. One file, N vaults.
 *
 * `<data>/vaults.json` (private, on the server) lists them; without the file the single
 * vault from the environment is served, exactly as before. Each entry carries what a
 * vault IS: a wallet, the env var holding its key, its pool and mint once launched, its
 * rules (a key into VAULT_RULES or an inline rule), and what the page prints.
 *
 *   [{ "id": "1", "name": "Vault #1", "operator": "Onix", "description": "…",
 *      "wallet": "<pubkey>", "secretEnv": "VAULT_SECRET_KEY",
 *      "pool": "<pool>", "baseMint": "<mint>", "graduationUsd": 3500,
 *      "token": { "name": "Veonix", "symbol": "VEONIX", "image": "/token/veonix.png" },
 *      "rules": "vault1" }]
 *
 * A second vault is a second entry. The key never leaves the server's .env. An entry may name
 * `custodyIndex` (its wallet is derived from VAULT_MASTER_SEED — server/keyring.js) instead of
 * `secretEnv`, and `creator` (the wallet allowed to add items; the pool's creator).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./config');
const { VAULT_RULES } = require('./admissions');

function fromEnv() {
  return {
    id: '1', name: 'Vault #1', operator: 'Onix', description: 'Graded trading cards in OmniVault, PWCC and PSA Vault',
    wallet: C.VAULT_WALLET, secretEnv: 'VAULT_SECRET_KEY', pool: C.POOL || null, baseMint: C.BASE_MINT || null, graduationUsd: C.GRADUATION_USD,
    token: { name: 'Veonix', symbol: 'VEONIX', image: '/token/veonix.png' }, rules: 'vault1',
  };
}

function normalize(v) {
  const rules = typeof v.rules === 'string' ? VAULT_RULES[v.rules] : v.rules;
  if (!rules) throw new Error(`vault ${v.id}: unknown rules "${v.rules}"`);
  if (!v.wallet) throw new Error(`vault ${v.id}: no wallet`);
  return { ...v, id: String(v.id), rules, custodians: v.custodians || rules.custodians, graduationUsd: v.graduationUsd ?? C.GRADUATION_USD, pool: v.pool || null, baseMint: v.baseMint || null,
    custodyIndex: v.custodyIndex ?? null, creator: v.creator || null, secretEnv: v.secretEnv || null };
}

function registryPath() { return process.env.ONIX_VAULTS_FILE || path.join(path.dirname(C.DB_PATH), 'vaults.json'); }

/** The operator's vaults: the file, or the single vault from the environment. */
function loadFileVaults() {
  const p = registryPath();
  if (fs.existsSync(p)) {
    const list = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(list)) throw new Error(`${p}: expected an array`);
    // a closed vault stays in the file for the record (pool, mint, dates) and is not served
    return list.filter((v) => !v.closed).map(normalize);
  }
  if (!C.VAULT_WALLET) return [];
  return [normalize(fromEnv())];
}

/** Vaults opened through the Create door live in the DB; the creator's wallet is the vault, no key here. */
function loadDbVaults(db) {
  const { rowToDef } = require('./creation');
  return db.prepare('SELECT * FROM vaults WHERE closed_at IS NULL ORDER BY created_at').all().map((r) => normalize(rowToDef(r, db)));
}

/** @returns {Array<object>} the vaults, operator's first */
function loadVaults(db = null) {
  return [...loadFileVaults(), ...(db ? loadDbVaults(db) : [])];
}

function findVault(id) {
  const vaults = loadVaults();
  const v = id ? vaults.find((x) => x.id === String(id) || x.wallet === id) : vaults[0];
  if (!v) throw new Error(`no vault "${id}" in ${registryPath()}`);
  return v;
}

module.exports = { loadVaults, loadFileVaults, loadDbVaults, findVault, registryPath, normalize };
