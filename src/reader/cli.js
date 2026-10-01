#!/usr/bin/env node
/**
 * cli.js — `npm run backing -- <VAULT_WALLET> [--mint <TOKEN_MINT>] [--json]`
 *
 * Prints what a vault holds and what it is worth. Anyone can run this against any
 * wallet. It needs an RPC endpoint with DAS support (Helius, Triton, ...) and nothing else.
 *
 * RPC comes from ONIX_VAULT_RPC_URL or from ./config.json ({ "rpcUrl": "..." }).
 * config.json is gitignored: this repository never contains a real endpoint.
 */
const fs = require('node:fs');
const path = require('node:path');
const { fetchAssetsByOwner, fetchTokenSupply } = require('./das');
const { parseCard, computeBacking } = require('./backing');

function loadRpcUrl() {
  if (process.env.ONIX_VAULT_RPC_URL) return process.env.ONIX_VAULT_RPC_URL;
  const p = path.join(__dirname, '..', '..', 'config.json');
  if (fs.existsSync(p)) {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (c.rpcUrl) return c.rpcUrl;
  }
  throw new Error('No RPC endpoint. Set ONIX_VAULT_RPC_URL or copy config.example.json to config.json.');
}

function parseArgs(argv) {
  const out = { wallet: null, mint: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--mint') out.mint = argv[++i];
    else if (!out.wallet) out.wallet = a;
  }
  if (!out.wallet) throw new Error('Usage: backing <VAULT_WALLET> [--mint <TOKEN_MINT>] [--json]');
  return out;
}

const usd = (n) => (n === null ? '—' : '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 }));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl = loadRpcUrl();
  const readAt = new Date().toISOString();

  const assets = await fetchAssetsByOwner(rpcUrl, args.wallet);
  const cards = assets.map(parseCard);
  const supply = args.mint ? await fetchTokenSupply(rpcUrl, args.mint) : null;
  const backing = computeBacking(cards, { supply });

  if (args.json) {
    process.stdout.write(JSON.stringify({ wallet: args.wallet, mint: args.mint, readAt, backing, cards }, null, 2) + '\n');
    return;
  }

  console.log(`vault   ${args.wallet}`);
  console.log(`read at ${readAt}`);
  console.log('');
  console.log(`cards       ${backing.cardsCounted} counted · ${backing.cardsExcluded} excluded · ${backing.cardsTotal} total`);
  console.log(`index       ${usd(backing.indexUsd)}   (custodian's insured value — an index, not a sale price)`);
  console.log(`realisable  ${usd(backing.realisableUsd)}   (× ${backing.multiplier}, measured median of real sales, ${backing.multiplierMeasured.when})`);
  console.log(`median card ${usd(backing.medianInsuredUsd)}`);
  if (supply) {
    console.log(`supply      ${supply.toLocaleString('en-US')}`);
    console.log(`per token   ${usd(backing.realisablePerTokenUsd)} realisable · ${usd(backing.indexPerTokenUsd)} index`);
  }
  console.log('');
  const counted = cards.filter((c) => c.counts).sort((a, b) => b.insuredUsd - a.insuredUsd);
  for (const c of counted) {
    console.log(`  ${usd(c.insuredUsd).padStart(8)}  ${c.name.slice(0, 34).padEnd(34)}  ${(c.gradingCompany || '').padEnd(8)}${(c.grade || '').padEnd(14)}${(c.certNumber || '').padEnd(15)}${c.vault || ''}`);
  }
  const excluded = cards.filter((c) => !c.counts);
  if (excluded.length) {
    console.log('');
    console.log(`excluded (${excluded.length}) — listed, not counted:`);
    for (const c of excluded) console.log(`  ${c.name.slice(0, 40).padEnd(40)}  ${c.excludedBecause}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
