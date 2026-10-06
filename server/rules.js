/**
 * server/rules.js — what a vault takes, as data the creator chooses from LISTS (never free text),
 * published on the vault page and enforced by the API.
 *
 *   category      which cards (the custodian's categories) — 'mixed' takes any
 *   minValueUsd   the floor for an item's custodian value
 *   minGrade      the floor for the grade ('any' or a number)
 *   restock       what the vault's treasury buys with fees: the entry rule, or its own
 *   creatorFeePct the creator's share of the partner-side trading fee (on chain)
 *   gradMult      graduation = gradMult × the opening market cap
 *
 * Anything outside the options is refused with 422. Custodians are never a choice: only the
 * registered ones count (src/reader/backing.js).
 */
'use strict';
const { parseCard } = require('../src/reader/backing');
const { DECIDED } = require('../src/curve/params');

const RULE_OPTIONS = Object.freeze({
  custodians: Object.freeze(['Collector Crypt']),
  category: Object.freeze(['mixed', 'pokemon', 'one-piece', 'sports', 'other']),
  minValueUsd: Object.freeze([0, 10, 25, 50, 100]),
  minGrade: Object.freeze(['any', 8, 9, 10]),
  creatorFeePct: DECIDED.creatorFeePctOptions,
  gradMult: DECIDED.gradMultOptions,
});

const DEFAULT_RULES = Object.freeze({
  custodians: RULE_OPTIONS.custodians, category: 'mixed', minValueUsd: 0, minGrade: 'any',
  restock: 'sameAsEntry', creatorFeePct: DECIDED.creatorTradingFeePercentage, gradMult: DECIDED.gradMultDefault,
});

function err(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }

/** The custodian's free-text category → one of ours. */
function categoryOf(card) {
  const c = String(card.category || '').toLowerCase();
  if (/pok[eé]mon/.test(c)) return 'pokemon';
  if (/one piece/.test(c)) return 'one-piece';
  if (/sport|baseball|basketball|football|soccer|hockey/.test(c)) return 'sports';
  return c ? 'other' : null;
}

function gradeOf(card) {
  const g = parseFloat(String(card.grade || '').replace(/[^\d.]/g, ''));
  return Number.isFinite(g) ? g : null;
}

/** A creator's choices → a validated rules object (defaults filled). 422 on anything off-list. */
function validateRules(input = {}) {
  const r = { ...DEFAULT_RULES };
  const pick = (key, allowed, value) => { if (value === undefined) return; if (!allowed.includes(value)) throw err(422, `rules.${key}: must be one of ${allowed.join(', ')}`); r[key] = value; };
  pick('category', RULE_OPTIONS.category, input.category);
  pick('minValueUsd', RULE_OPTIONS.minValueUsd, input.minValueUsd);
  pick('minGrade', RULE_OPTIONS.minGrade, input.minGrade);
  pick('creatorFeePct', RULE_OPTIONS.creatorFeePct, input.creatorFeePct);
  pick('gradMult', RULE_OPTIONS.gradMult, input.gradMult);
  if (input.restock !== undefined) {
    if (input.restock === 'sameAsEntry') r.restock = 'sameAsEntry';
    else if (input.restock && typeof input.restock === 'object') {
      const s = {};
      const p2 = (key, allowed, value) => { if (value === undefined) return; if (!allowed.includes(value)) throw err(422, `rules.restock.${key}: must be one of ${allowed.join(', ')}`); s[key] = value; };
      p2('category', RULE_OPTIONS.category, input.restock.category);
      p2('minValueUsd', RULE_OPTIONS.minValueUsd, input.restock.minValueUsd);
      p2('maxValueUsd', [25, 50, 100, 250, 500], input.restock.maxValueUsd);
      p2('minGrade', RULE_OPTIONS.minGrade, input.restock.minGrade);
      r.restock = s;
    } else throw err(422, 'rules.restock: "sameAsEntry" or an object');
  }
  return r;
}

/** Does this asset pass this vault's rules? Says why not. */
function itemPassesRules(asset, rules) {
  const c = parseCard(asset);
  if (!c.custodian) return { ok: false, reason: 'unknown custodian' };
  // no value on chain comes first: it is why a Phygitals card cannot back anything, whatever the vault accepts
  if (c.insuredUsd == null) return { ok: false, reason: 'no insured value' };
  if (!rules.custodians.includes(c.custodian)) return { ok: false, reason: `custodian not accepted by this vault: ${c.custodian}` };
  if (rules.minValueUsd && c.insuredUsd < rules.minValueUsd) return { ok: false, reason: `below the vault's minimum value ($${rules.minValueUsd})` };
  if (rules.category && rules.category !== 'mixed') {
    const cat = categoryOf(c);
    if (cat !== rules.category) return { ok: false, reason: `not ${rules.category} (${c.category || 'no category'})` };
  }
  if (rules.minGrade && rules.minGrade !== 'any') {
    const g = gradeOf(c);
    if (g == null || g < rules.minGrade) return { ok: false, reason: `below the vault's minimum grade (${rules.minGrade})` };
  }
  return { ok: true, reason: null };
}

/** Human line for the page: "Pokémon cards graded 9+ worth $25+ from Collector Crypt". */
function describeRules(rules) {
  const cat = { mixed: 'Graded cards', pokemon: 'Pokémon cards', 'one-piece': 'One Piece cards', sports: 'Sports cards', other: 'Graded cards' }[rules.category] || 'Graded cards';
  const parts = [cat];
  if (rules.minGrade && rules.minGrade !== 'any') parts.push(`graded ${rules.minGrade}+`);
  if (rules.minValueUsd) parts.push(`worth $${rules.minValueUsd}+`);
  const line = `${parts.join(' ')} from ${rules.custodians.join(', ')}`;
  const rs = rules.restock;
  if (!rs || rs === 'sameAsEntry') return line;
  const rcat = { mixed: 'any graded card', pokemon: 'Pokémon', 'one-piece': 'One Piece', sports: 'sports', other: 'graded cards' }[rs.category || rules.category] || 'graded cards';
  const band = rs.minValueUsd && rs.maxValueUsd ? ` $${rs.minValueUsd}–$${rs.maxValueUsd}` : rs.maxValueUsd ? ` up to $${rs.maxValueUsd}` : rs.minValueUsd ? ` $${rs.minValueUsd}+` : '';
  const g = rs.minGrade && rs.minGrade !== 'any' ? ` graded ${rs.minGrade}+` : '';
  return `${line} · the treasury buys ${rcat}${g}${band}`;
}

module.exports = { RULE_OPTIONS, DEFAULT_RULES, validateRules, itemPassesRules, describeRules, categoryOf, gradeOf };
