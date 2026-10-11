# Impact and market

> For the "Impact / TAM" criterion. **Every number below was measured or taken from a named
> source; none is a projection.** Where we have no number, it says so.

## What changes for a collector

**Your collection. A business in minutes.** A collector with graded cards today sells them one at a time, on someone
else's marketplace, and waits for each buyer. With a vault the same collection becomes a token people trade, a gacha
people play, a supplier to every gacha on chain, and an income line for the collector, all from one launch. The impact
is on the supply side of a market that already has the demand: card gacha alone moves hundreds of millions a month.

## The precondition, and the first asset class that meets it

Onix.Vault works on any real-world asset that meets three conditions: possession is provable
on chain, **the custodian writes identity and value into the token**, and the custodian offers
a way to redeem the physical item. Liquid RWAs (tokenized stocks) do not need this — they
redeem at NAV by design; this is for the illiquid kind.

Graded trading cards are the first class that meets all three today: grade, grading company,
certificate number, insured value and the physical vault's street address are attributes of
the token itself, for two custodians (Collector Crypt, Phygitals). That is why the first vaults hold
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

**What this says:** there is a large, liquid, on-chain market for the *cards*, and most of it is gacha. What does
not exist is a way to put a collection on chain as **one token whose backing anyone can count**, that pays the person
who brought the items, and whose items flow into the gachas that already move that volume.

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

## Who this is for

- **The creator** — a collector with graded cards a custodian already tokenized. They open a vault on them, keep half the
  token (released over 6 months from graduation) and 40% of the trading fee on the curve. Compared with the launchpads
  creators already use (Clanker 40% of fees, Jupiter Studio 50% + anti-sniper, Believe 50%), the difference is that their
  half is backed by their own items from day one.
- **The holder** — exposure to a collection whose backing is counted from a wallet, which grows with every trade fee
  and every USDC play, and which can be spent on a draw for an item at its share of backing.
- **The player and the gacha** — every graduated vault is a machine. On the vault page (Play), and on Onix.Cards, where
  the first vault machine went live on 3 Oct 2026 and paid the vault through the public API on its first pull.

**What we do not claim:** that any of these groups is queuing up. The vaults so far are ours and the ones made to test
the doors. Demand is what the submission window measures.

## Why the timing

Meteora published **StockLaunch on 15 September 2026** — bonding curves whose fees
accumulate in a vault of the reference asset — and named "a new asset class beyond
memecoins" as the goal of its track.

And Meteora already tried this exact asset class itself. **`$SV151` (Dynamic Assets, Meteora
+ Sunrise, June 2026)**: a $160k presale to buy sealed Pokémon packs, trading fees that buy
more packs, a page with reserve NAV and mNAV, 10% of supply for people who deposit packs —
and **no redemption**. Read on 30 September 2026: reserve **$288.8k** (up from $160k — the
fee engine works), market cap ~$277k, **mNAV 0.95×**, and 0.80× at its low. The market
discounts backing it cannot reach, even while that backing grows.

That is the precedent and the gap in one object: the mechanism is proven, the exit is
missing. Onix.Vault adds the exit — **Play**, a provably fair draw for an item paid in USDC (93% of which stays in the vault, 5% to the creator, 2% to Onix)
or in the token at its share of backing (burned), and a **gacha API** any machine can buy through — on backing a
third-party custodian already put on chain, counted from the custody wallet rather than from the team's reporting.
And it pays the person who brought the items, which SV151 never did.

## Where it goes if it works

The first vaults are the seed, not the product. The mechanism does not care what the asset is; it
cares that **custody is provable on chain**. Where a credible custodian tokenizes a real
thing, a vault works the next day. That is the market: not cards, but **every custodian's
inventory**, one vault at a time.

## What we still do not know

- whether vaults opened by strangers find buyers — the whole question of a launchpad
- the realisable multiplier per category (Pokémon measured 0.88×; One Piece ≈1.01× on a small sample)
- whether gacha players prefer a vault's machine to a curated one (the first vault machine on Onix.Cards paused itself
  on margin after one pull: four $24 cards cannot fund a $25 pull — the restock bot buying below the index is what
  reopens it)
- anything about demand. We have a working loop on mainnet and a measurement plan, not a number.
