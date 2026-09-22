/**
 * split.js — where each dollar of a trade goes. Pure arithmetic, single source of truth.
 *
 * The page, the docs and the dry run all read THIS, so the numbers can never drift apart.
 */

/**
 * The program takes this share of every trading fee for the protocol BEFORE anything
 * reaches the partner or creator. Verified in the program source:
 *   state/config.rs::get_fee_on_amount → protocol_fee = trading_fee × PROTOCOL_FEE_PERCENT / 100
 * The SDK exports the same constant; a test asserts they agree.
 */
const PROTOCOL_FEE_PERCENT = 20;

/** Our published split of what reaches us. Must sum to 100. */
const OPERATOR_SPLIT = { buyCard: 50, buyback: 30, operator: 20 };

/**
 * @param {number} feeBps  the pool's trading fee in basis points (1000 = 10%)
 * @returns each destination as a percentage OF THE TRADE, plus the protocol's cut.
 */
function splitOfTrade(feeBps, split = OPERATOR_SPLIT) {
  const sum = split.buyCard + split.buyback + split.operator;
  if (sum !== 100) throw new Error(`split must sum to 100, got ${sum}`);
  const feePct = feeBps / 100;
  const protocolPct = feePct * PROTOCOL_FEE_PERCENT / 100;
  const oursPct = feePct - protocolPct;
  return {
    feePct,
    protocolPct,
    oursPct,
    buyCardPct: oursPct * split.buyCard / 100,
    buybackPct: oursPct * split.buyback / 100,
    operatorPct: oursPct * split.operator / 100,
  };
}

const api = { PROTOCOL_FEE_PERCENT, OPERATOR_SPLIT, splitOfTrade };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else if (typeof window !== 'undefined') window.VaultySplit = api;
