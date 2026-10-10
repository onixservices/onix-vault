# The bonding curve configuration

> Every parameter of an Onix.Vault Meteora DBC config, and **why that value and not another**. A DBC config is
> effectively irreversible once a pool is open (changing it means launching a different token), so every line here is
> a decision, not a default. The code is `src/curve/params.js` (`DECIDED`, `paramsFor`); the fee arithmetic is
> `src/curve/split.js`; `node src/curve/dry-run.js <backingUsd> [gradMult] [creatorFeePct]` prints the implied prices,
> the USDC needed to graduate and the supply split for any backing.

## The shape every vault gets

| parameter | value | why |
|---|---|---|
| `totalTokenSupply` | 10,000,000 (6 dp) | a figure a person reads off the page; same decimals as USDC |
| **creator allocation** (`lockedVesting`) | **50% of supply**, cliff at migration, then **linear over 6 months** | the creator put the items in; the DBC releases its vesting only at migration, so this is the one place the creator's share can live. Six months of vesting after that is what buyers look for (Jupiter Studio vests creator allocations; a one-shot release reads as a rug) |
| `initialMarketCap` | **2 × realisable backing** | so the creator's 50% is worth the items on day one ("you put $100 of cards in, you hold $100 of the token"); buyers see the 2.0× ratio on the page, with the backing beside it |
| `migrationMarketCap` | **gradMult × opening cap**, gradMult ∈ {2, 2.5, 3} chosen by the creator (default 2.5) | plausible to reach; the page shows "USDC raised ÷ threshold", the curve's own condition |
| `creatorTradingFeePercentage` | **40** (creator's choice 20–50) | the creator is paid **on chain, from the first trade**: 3.2% of volume at 40. Clanker pays 40%, Jupiter Studio 50%, Believe 50%; a launchpad that pays its creators nothing has no creators |
| base fee | **10%** flat (`FeeSchedulerLinear`, ending = base) | the fee IS the product: it funds the vault's next items. A fee that decayed would mean the vault grows fastest when nobody is trading |
| **anti-sniper** (`feeSchedulerParam`) | **99% → 10% over the first 60 s, 6 steps** | measured on our first mainnet pool: a bot bought 5 s after creation and sold 90 s later. At a flat 10% it lost $1.13; with this schedule it would have paid ~$5.80, to the creator. Jupiter Studio does the same |
| `migrationFee.feePercentage` | **30**, `creatorFeePercentage` 0 | 30% of the USDC raised goes to the fee claimer, **the vault's custody wallet**, at graduation, to buy items; the other 70% is permanently locked liquidity. SV151 raised $160k to buy packs by presale; we do it at graduation, by config |
| `collectFeeMode` | QuoteToken | fees arrive in USDC, the currency items are bought in. Collecting in the vault's own token would mean selling it to buy items: a worse look and a worse mechanism |
| `dynamicFeeEnabled` | false | the page says "10% of every trade"; a dynamic fee makes that sentence untrue on a volatile day |
| `tokenType` / decimals | SPL, 6 / 6 | Token-2022 with transfer hooks needs Meteora's admin-granted TokenBadge; SPL is permissionless. Six decimals keep backing per token readable by eye |
| `tokenAuthorityOption` | Immutable | mint authority revoked: the supply is fixed, scanners see it, and a whole class of "what could the team do to this" questions disappears |
| `migrationOption` | DAMM v2, `migratedPoolFeeBps` 100 | pools born from a DBC curve are 14.5% of DAMM v2 pools but 76% of its fees (our own census): it is where the trading lands. 1% on the graduated pool keeps feeding the treasury; `partnerPermanentLockedLiquidityPercentage` 100: nothing walks out |
| leftover | 0.1% of supply → custody | the program refuses a supply with no slack when a migration fee is set (`InvalidTokenSupply`, measured by simulation on mainnet) |
| `feeClaimer` / `leftoverReceiver` | the vault's **custody wallet** (one per vault) | the vault's treasury is its own wallet on chain; Onix's share is taken when fees are claimed (published split: treasury 2/3 · Onix 1/3 of the partner side) |
| `poolCreator` / `payer` of `createPool` | the **creator's** wallet | the creator receives the vesting and the on-chain creator fee; nobody else can |
| `payer` of `createConfig` | Onix | rent for the config; paid only after the creator has deposited items (see `server/creation.js`) |

## Where a dollar of a trade goes

The program takes **20% of every trading fee for the protocol** before anything reaches the partner or the creator
(`state/config.rs::get_fee_on_amount`, `PROTOCOL_FEE_PERCENT = 20`; the SDK exports the same constant and a test asserts
they agree). A referral, if any, is paid out of the protocol's share, not ours. So at the 10% base fee and the 40%
creator share:

```
trade ─ 10% fee ─┬─ 2.0%  Meteora (protocol take, fixed by the program)
                 └─ 8.0% ─┬─ 3.2%  creator, paid on chain by the program (40% of the 8%)
                          └─ 4.8%  partner = the vault's custody wallet ─┬─ 3.2%  vault treasury (buys the next item)
                                                                         └─ 1.6%  Onix
```

The page prints this split, protocol cut included. "10% of every trade buys items" would be a lie by omission; "3.2% of
every trade buys items" is the true sentence.

## How the curve is expressed

The SDK offers several builders. We use **`buildCurveWithMarketCap`**, which takes an `initialMarketCap` and a
`migrationMarketCap` and derives `sqrtStartPrice` and the `curve` array. This matters beyond convenience: every number in
this document is one a human can argue about. Nobody has to audit our square-root arithmetic to check our reasoning; they
check two market caps and a supply. The curve stays far under the program's 16-point maximum.

## Why the creator's share sits in `lockedVesting`

The DBC's vesting is anchored to **migration** (`cliffDurationFromMigrationTime`): if the pool never graduates, nothing
vests. That is the right tool for exactly one allocation, the one whose meaning *is* graduation. The creator's half of
the supply becomes worth the market's price only when the market exists; if the curve never fills, the items stay in
custody behind the doors and the vesting never starts. Using the same field for anything that should unlock regardless
of graduation would be the wrong tool, and anyone who wrote the program would see it.

## What is deliberately not in the config

- **No admission reserve.** Nobody but the creator adds items, and nobody is paid tokens for adding one: the supply is
  the curve's, and an added item raises backing per token for every holder.
- **No token outside the pool before migration.** There is nothing to time-lock outside the DBC; the creator's share is
  the vesting above.
- **No flat fee from second zero.** The scheduler exists because of the measured sniper.
- **No dynamic fee, no first-swap discount.** Nothing the page cannot print in one sentence.
