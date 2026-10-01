/**
 * backing.js — what a vault holds, and what it is worth. Pure functions.
 *
 * Nothing here touches the network. Give it DAS assets, get back cards and totals.
 * Every number it produces can be recomputed by anyone from the same on-chain data.
 */

/**
 * Collections whose cards count toward backing, keyed by the custodian that
 * physically holds the card. A card from any other collection is LISTED but
 * NEVER COUNTED — otherwise anyone could inflate a vault by airdropping NFTs into it.
 *
 * Collector Crypt runs more than one collection (one per physical vault). Treat
 * every custodian as "N collections until proven otherwise".
 */
const KNOWN_CUSTODIANS = {
  'Collector Crypt': [
    'CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac', // OmniVault (incl. Sealed)
    'CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf', // PWCC
  ],
  // Phygitals writes identity on chain but NOT a value: its cards are recognised as
  // custodied, and are still excluded — for "no insured value", which is the true reason.
  'Phygitals': [
    'BSG6DyEihFFtfvxtL9mKYsvTwiZXB1rq5gARMTJC2xAM',
    'phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC',
  ],
};

/**
 * Cards sell for LESS than the custodian's insured value. This is the measured
 * median of what the market actually paid, over real sales, not listings.
 *
 *   sample: ~1.5k Pokémon sales, catalogue-wide, August 2026 → 0.88×
 *   (One Piece measured ~1.01× on n≈86 — a per-category multiplier is future work)
 *
 * It is a measurement, not an opinion. Re-measure it; do not inherit it.
 */
const REALISABLE_MULTIPLIER = 0.89;
const REALISABLE_MEASURED = { sample: '~1.5k real sales, Pokémon, catalogue-wide', when: '2026-08' };

function attr(asset, traitType) {
  const attrs = (asset.content && asset.content.metadata && asset.content.metadata.attributes) || [];
  const a = attrs.find((x) => x && x.trait_type === traitType);
  return a && a.value !== undefined && a.value !== null ? String(a.value) : null;
}

function parseUsd(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function custodianOf(asset) {
  const groups = asset.grouping || [];
  const col = groups.find((g) => g && g.group_key === 'collection');
  if (!col) return null;
  for (const [name, collections] of Object.entries(KNOWN_CUSTODIANS)) {
    if (collections.includes(col.group_value)) return name;
  }
  return null;
}

/** One DAS asset → one card row. Says explicitly whether it counts, and why not. */
function parseCard(asset) {
  const custodian = custodianOf(asset);
  const insuredUsd = parseUsd(attr(asset, 'Insured Value'));
  const meta = (asset.content && asset.content.metadata) || {};

  let excludedBecause = null;
  if (!custodian) excludedBecause = 'unknown custodian';
  else if (insuredUsd === null) excludedBecause = 'no insured value';

  return {
    mint: asset.id,
    name: meta.name || 'Unknown card',
    category: attr(asset, 'Category'),
    set: attr(asset, 'Set'),
    grade: attr(asset, 'The Grade'),
    gradingCompany: attr(asset, 'Grading Company'),
    certNumber: attr(asset, 'Grading ID'),
    vault: attr(asset, 'Vault'),
    custodian,
    insuredUsd,
    counts: excludedBecause === null,
    excludedBecause,
  };
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Totals over a list of parsed cards.
 *
 * `indexUsd` and `realisableUsd` are DIFFERENT numbers and are both returned so the
 * page can show both, labelled. Per-token figures are null — never zero — when no
 * supply is given: "we don't know" is not the same as "nothing".
 */
function computeBacking(cards, opts = {}) {
  const counted = cards.filter((c) => c.counts);
  const indexUsd = counted.reduce((s, c) => s + c.insuredUsd, 0);
  const realisableUsd = indexUsd * REALISABLE_MULTIPLIER;
  const supply = Number.isFinite(opts.supply) && opts.supply > 0 ? opts.supply : null;

  return {
    cardsTotal: cards.length,
    cardsCounted: counted.length,
    cardsExcluded: cards.length - counted.length,
    indexUsd,
    realisableUsd,
    multiplier: REALISABLE_MULTIPLIER,
    multiplierMeasured: REALISABLE_MEASURED,
    medianInsuredUsd: median(counted.map((c) => c.insuredUsd)),
    supply,
    indexPerTokenUsd: supply ? indexUsd / supply : null,
    realisablePerTokenUsd: supply ? realisableUsd / supply : null,
  };
}

const api = { KNOWN_CUSTODIANS, REALISABLE_MULTIPLIER, parseCard, computeBacking };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else if (typeof window !== 'undefined') window.OnixVaultBacking = api;
