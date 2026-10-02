/**
 * split.js — where each dollar of a trade goes. Pure arithmetic, single source of truth.
 *
 * The page, the docs and the dry run all read THIS, so the numbers can never drift apart.
 *
 *   trade ─┬─ protocol (Meteora): PROTOCOL_FEE_PERCENT of the fee, taken by the program
 *          └─ the rest ─┬─ creator: creatorTradingFeePercentage, paid ON CHAIN to the pool creator
 *                       └─ partner (fee claimer = the vault's custody wallet) ─┬─ vault treasury (buys items)
 *                                                                              └─ Onix
 */

/**
 * The program takes this share of every trading fee for the protocol BEFORE anything
 * reaches the partner or creator. Verified in the program source:
 *   state/config.rs::get_fee_on_amount → protocol_fee = trading_fee × PROTOCOL_FEE_PERCENT / 100
 * The SDK exports the same constant; a test asserts they agree.
 */
const PROTOCOL_FEE_PERCENT = 20;

/** Of what the partner claims: the vault's treasury vs Onix. Must sum to 100. */
const PARTNER_SPLIT = { treasury: 2 / 3 * 100, onix: 1 / 3 * 100 };

/**
 * @param {number} feeBps        the pool's base trading fee in basis points (1000 = 10%)
 * @param {number} creatorPct    creatorTradingFeePercentage of the config (0–100)
 * @returns each destination as a percentage OF THE TRADE.
 */
function splitOfTrade(feeBps, creatorPct = 40, partner = PARTNER_SPLIT) {
  if (Math.abs(partner.treasury + partner.onix - 100) > 1e-9) throw new Error('partner split must sum to 100');
  if (!(creatorPct >= 0 && creatorPct <= 100)) throw new Error('creatorPct must be 0–100');
  const feePct = feeBps / 100;
  const protocolPct = feePct * PROTOCOL_FEE_PERCENT / 100;
  const afterProtocolPct = feePct - protocolPct;
  const creatorTradePct = afterProtocolPct * creatorPct / 100;
  const partnerPct = afterProtocolPct - creatorTradePct;
  return {
    feePct, protocolPct, afterProtocolPct,
    creatorPct: creatorTradePct,
    partnerPct,
    treasuryPct: partnerPct * partner.treasury / 100,
    onixPct: partnerPct * partner.onix / 100,
  };
}

const api = { PROTOCOL_FEE_PERCENT, PARTNER_SPLIT, splitOfTrade };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else if (typeof window !== 'undefined') window.OnixVaultSplit = api;
