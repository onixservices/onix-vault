# Business model

> For the "Business Plan" criterion, which the 2026 rules define as *"the team's ability to execute"*.
> Drafted 22 September 2026; rewritten 3 October 2026 after the model moved to creator-owned vaults and
> the first full cycle ran on mainnet. Revenue lines are mechanisms, not forecasts.

> Onix.Vault is a platform for vaults of real-world assets a custodian has already put on chain.
> Vault #1 holds graded cards, so the lines below say "card"; read "item" for any other registered custodian.

## Who makes money, and from what

The design question of 2 October was the creator's: *"if I send $1,000 of cards I want at least $1,000 of
the token — the first risk-taker needs an edge."* The answer is the split below. Every leg is a public
transaction and the split is printed on the vault page.

```
the creator        50% of the supply, locked (released over 6 months from graduation)
                   + 40% of every trade fee, paid by the program (3.2% of volume)
the vault          3.2% of volume while on the curve  + 30% of the USDC raised at graduation
                   + every USDC play  → the treasury buys the next item
Meteora            2% of volume (fixed by the program)
Onix               1.6% of volume on the curve  + the config rent it fronts, back from the same leg
```

Of a 10% trade fee: 2% Meteora · 3.2% creator · 3.2% vault treasury · 1.6% Onix (`src/curve/split.js`).
After graduation the pool charges 1% to its (permanently locked) liquidity, and the vault earns through Play.

Three further lines are **not** operator fees; all of them raise backing per token, which is the asset
everyone above is paid on:

- **Play in USDC.** The band's average × 1.15 goes to the custody wallet; the item leaves, the money stays.
  Gacha is a $284M/month market (Collector Crypt alone buys back 92.9% of what it sells); the vault is a
  supplier with no inventory risk of its own.
- **Play by burning.** The band's average × 1.10 in share of backing, burned: supply shrinks for everyone.
- **The gacha API.** Any gacha buys from any vault at the published price (`docs/vault-api.md`); Onix.Cards'
  gacha is the first integrator, through the same public endpoints.

## Why a creator comes

Compared with the launchpads creators already use (Clanker 40% of fees · Jupiter Studio 50% + anti-sniper ·
Believe 50% · Bags royalties in the config), the creator here gets the same on-chain fee share **plus half
the supply backed by their own items**, an anti-sniper opening (99% → 10% over 60 s), and a treasury that
buys more of what they collect. What they give up: the items go into custody they do not control, and
leave only through Play or the API, at the same price for them and for a stranger. That is the deal that
makes the token worth holding for the people who did not create it.

## What it costs

Almost nothing marginal. One server, one RPC. Onix fronts the curve config (~0.01 SOL per vault) only
after the creator's items are in custody, and the migration (~0.02 SOL) when a vault graduates. The real
cost is the one named on the page: **whoever operates the server holds the seed** every custody wallet
derives from — a single point of failure until the escrow program exists.

## Proof of execution — what already runs

- **Onix.Vault**, mainnet, 2 October 2026: a vault created through the door by a third-party wallet
  (`$OT4`), bought to graduation, migrated to a DAMM v2 pool by our script, a Play paid in USDC and the card
  delivered from custody — the draw recomputed outside the server from the published proof. 149 tests.
- **Onix.Cards**, in production since 3 August 2026: a cross-issuer terminal for tokenized graded cards
  that buys inventory on its own, across venues, under published rules, with deliverability proven by
  simulation before every purchase. Its gacha is the vault's first integrator.
- **Onix.Finance**, in production: an LP inspector that reconstructs PnL from on-chain events for Meteora,
  Orca and Raydium, and opens wide Meteora DLMM positions in one atomic transaction.
- **`solana-lp-utils`**, public, delivered under a Superteam Brazil grant.

Everything but the first predates the hackathon window and is declared as such. Built in the window:
the curve configuration, custody by derivation, the Create door, the trade panel (curve and pool), Play,
the gacha API and its first integrator, the page, the docs.

## What we are not claiming

- **No traction.** The only vaults so far are ours and the one made for the test. Volume is unknown.
- **No revenue forecast.** 1.6% of a volume we cannot predict is not a number we will print.
- **No decentralisation.** Custody is a derived wallet operated by Onix; the page says so.

## Where ONIX fits — and where it does not

Onix has a token (ONIX, minted April 2026, never launched, no pool). It is **not** a vault token and never
will be: a vault token is the quota of *one* vault. ONIX sits one level up (admission to creating vaults,
votes on platform parameters, a treasury policy fed only by Onix's own revenue). Nothing about ONIX is
built in the window; its mint authority is still active and that changes before it is shown to anyone.

## The platform, in one line

Anyone who holds already-tokenized, custodied assets can open a vault, keep half the token and 40% of
every trade, and let the market and the players grow the rest. Every vault is also a prize supplier to
every gacha through the same API. That is the business: not one vault, but the rail every vault runs on.
