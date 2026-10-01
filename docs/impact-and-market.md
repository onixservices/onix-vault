# Impact and market — DRAFT

> For the "Impact / TAM" criterion. **Every number below was measured or taken from a named
> source; none is a projection.** Where we have no number, it says so. Drafted 22 September
> 2026; to be tightened before submission.

## The precondition, and the first asset class that meets it

Onix.Vault works on any real-world asset that meets three conditions: possession is provable
on chain, **the custodian writes identity and value into the token**, and the custodian offers
a way to redeem the physical item. Liquid RWAs (tokenized stocks) do not need this — they
redeem at NAV by design; this is for the illiquid kind.

Graded trading cards are the first class that meets all three today: grade, grading company,
certificate number, insured value and the physical vault's street address are attributes of
the token itself, for two custodians (Collector Crypt, Phygitals). That is why Vault #1 holds
cards. Wine and spirits (BAXUS, dVIN), watches (Watch.fun) and fossils (JurassicFi) are
tokenized on Solana today; **whether their custodians publish value and redemption in the
token is not yet measured** — one probe per custodian, and that number is not in this memo.

| measured | value | source |
|---|---|---|
| on-chain card gacha volume, one month | **$324.6M** (Jun 2026; CC ≈ 64%) | industry reporting, Jun 2026 |
| Courtyard (tokenized collectibles) | ~**$200M** run-rate; $30M Series A | public filings, Jul 2025 |
| Beezie | **$142M ARR**; on Solana since May 2026 | public, Jul 2026 |
| Collector Crypt marketplace | ~$77.8M / 30 days (Aug 2026) | industry reporting |
| `$CARDS` (Collector Crypt token) | $157M cap · $8.3M daily volume | DexScreener, 20 Sep 2026 |

**What this says:** there is a large, liquid, on-chain market for the *cards*. What does not
exist is a way to hold **exposure to a basket of them** with backing anyone can verify —
without picking cards, without custody, without trusting a spreadsheet.

## The launch rail is real and where the fees are

Onix.Vault's token launches on Meteora's Dynamic Bonding Curve, then graduates to DAMM v2.

| measured on chain / DefiLlama | value |
|---|---|
| DBC pools created | **1.67M** |
| DBC fees, cumulative | **$96.1M**; ≈ $1M / month |
| DAMM v2 pools born from a DBC curve | 14.5% of pools, **76% of DAMM v2 fees** |
| Meteora TVL | $307M |

**What this says:** the rail is not a sandbox, and the place a curve graduates to is where
the trading actually lands.

## Who this is for — honestly

- **The buyer of exposure.** Someone who believes in graded cards as a category and wants
  a position whose backing they can count, rather than a card they must store, insure and
  eventually sell at 0.89× of index.
- **The holder of an idle card.** Someone with a slab nobody is bidding on, who would take a
  liquid position for it under a published rule.

**What we do not claim:** that either group is queuing up. Vault #1 launches with the
operator's own inventory and no waiting list. Demand is the thing this launch measures.

## Why the timing

Meteora published **StockLaunch on 15 September 2026** — bonding curves whose fees
accumulate in a vault of the reference asset — and named "a new asset class beyond
memecoins" as the goal of its track. Three of the four declared entries in that track chose
tokenized stocks.

And Meteora already tried this exact asset class itself. **`$SV151` (Dynamic Assets, Meteora
+ Sunrise, June 2026)**: a $160k presale to buy sealed Pokémon packs, trading fees that buy
more packs, a page with reserve NAV and mNAV, 10% of supply for people who deposit packs —
and **no redemption**. Read on 30 September 2026: reserve **$288.8k** (up from $160k — the
fee engine works), market cap ~$277k, **mNAV 0.95×**, and 0.80× at its low. The market
discounts backing it cannot reach, even while that backing grows.

That is the precedent and the gap in one object: the mechanism is proven, the exit is
missing. Onix.Vault adds the exit — redemption with a published rule, and a gacha door — on
backing a third-party custodian already put on chain, where the reserve's contents are
verifiable from the wallet rather than from the team's reporting.

## Where it goes if it works

Vault #1 is the seed, not the product. The mechanism does not care what the asset is; it
cares that **custody is provable on chain**. Where a credible custodian tokenizes a real
thing, a vault works the next day. That is the market: not cards, but **every custodian's
inventory**, one vault at a time.

## What we still do not know

- whether a **second** vault, seeded by a stranger, finds buyers — the token-per-person
  model was rejected precisely on this question
- the realisable multiplier per category (Pokémon measured 0.88×; One Piece ≈1.01× on a
  small sample)
- anything about demand. We have a mechanism and a measurement plan, not a number.
