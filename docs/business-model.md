# Business model

> For the "Business Plan" criterion, which the 2026 rules define as *"the team's ability to execute"*.

## Your collection. A business in minutes.

Anyone who holds real graded cards on chain can open a vault and launch. In three steps (pick the cards, give the
vault a name, a coin image, a banner and its rules, sign in the wallet) the creator gets:

| | what the creator gets |
|---|---|
| **A token** | live on a Meteora bonding curve, traded by anyone; half the supply is the creator's (Jupiter Lock, released over 6 months from graduation) |
| **Income** | 40% of the trading fee on the curve (3.2% of every trade), accrued by the program to the creator, plus 5% of every card sold |
| **A gacha** | at graduation the items become a provably fair machine on the vault's own page |
| **A shop everywhere** | every vault sells items to any gacha through the public API; Onix.Cards runs a Vaults category with one machine per vault |
| **A treasury that restocks** | every 15 minutes the vault claims its fees and buys the next card that follows the creator's rules |
| **Nothing to run** | no code, no servers; the custodian keeps the physical items |

A buyer who is not a collector backs one: the token is a share of a real collection, it sells in seconds instead of
card by card, every door adds items behind it, and it can be burned to play for a real card.

## Who makes money, and from what

Every leg is a public transaction and the split is printed on the vault page.

```
the creator        50% of the supply, locked (released over 6 months from graduation)
                   + 40% of the 8% the curve keeps after Meteora, accrued by the program (3.2% of volume)
                   + 5% of every card the vault sells (Play in USDC, or a gacha through the API)
the vault          3.2% of volume while on the curve  + 30% of the USDC raised at graduation
                   + the pool's 1% fee after graduation  + 93% of every card sold  → the treasury buys the next item
Meteora            2% of volume on the curve (fixed by the program)
Onix               1.6% of volume on the curve  + 2% of every card sold  + Meteora's referral share on every swap the page builds
```

Of a 10% curve fee: 2% Meteora · 3.2% creator · 3.2% vault treasury · 1.6% Onix (`src/curve/split.js`). Claimed
automatically every 15 minutes, Onix's third in the same transaction as the vault's two (`server/feeclaim.js`). The
referral is the host share of Meteora's own fee; the trader pays nothing extra. After graduation the pool's 1% fee
accrues on the vault's permanently locked LP position and goes 100% to the treasury.

Of every card sold: 5% creator · 2% Onix · 93% treasury (`server/commissions.js`). The buyer — a player, or a gacha
through the API — pays the full price to custody; the two shares leave in the custody's next fee claim, every 15 minutes,
in the same transaction, so a payout is one public signature. Never at the sale. Sales made before 11 Oct 2026 owe
nothing.

Three more doors raise backing per token, the asset everyone above is paid on:

- **Play in USDC.** The band's average × 1.15 goes to custody; the item leaves, 93% stays and buys the next (5% to the
  creator, 2% to Onix, with the fee claim).
  On-chain card gacha moves $324.6M a month (June 2026); the vault is a supplier with no inventory risk of its own.
- **Play by burning.** The band's average × 1.10 in share of backing, burned: the supply shrinks for every holder.
- **The gacha API.** Any gacha buys from any vault at the published price (`docs/vault-api.md`); Onix.Cards is the
  first integrator, through the same public endpoints.

## Why a creator picks this over a launchpad

Launchpads pay creators a fee share (Clanker 40% · Jupiter Studio 50% with anti-sniper · Believe 50% · Bags royalties).
Onix.Vault pays the same on-chain fee share **plus half the supply backed by the creator's own items**, an anti-sniper
opening (99% → 10% over 60 s) that pays the creator in that first minute, a gacha and a shop on other sites from day one,
and a treasury that keeps buying what the creator collects. The items leave custody only through Play or the API, at the
same price for everyone, which is what makes the token worth holding for the people who back the vault.

## What it costs

Almost nothing marginal: one server, one RPC. Onix fronts the curve config (0.006 SOL per vault, measured) only after the
creator's items are in custody, and the migration (~0.02 SOL) when a vault graduates. Custody wallets derive from one
seed held on the server; the escrow program on the roadmap replaces it.

## Proof of execution — what already runs

- **Onix.Vault**, mainnet, October 2026: two vaults live, both created through the page by a wallet that is not the
  operator's. `$OCC` (3 October): graduated, traded on its pool from the page, its treasury **bought cards by itself**, one
  of them won on Onix.Cards' vault machine and paid to the vault through the public API, the fees claimed into the treasury
  automatically. `$VOLT` (9 October): the curve filled and **the server graduated it by itself**, a Play paid in USDC and
  delivered from custody, and the treasury bought three cards overnight with nobody clicking. On 11 October the sale
  commission shipped and paid its first creator the same day (`5QAsuzSWb7u9…`: $1.035 to the creator, $0.414 to Onix,
  93% kept; the treasury bought the next card in the following round); fifteen cards bought by the two treasuries by then. An internal security review with every finding fixed and
  regression-tested (`docs/security-review.md`); the suite is green with `npm test`.
- **Onix.Cards**, in production since 3 August 2026: a cross-issuer terminal for tokenized graded cards that buys
  inventory on its own, across venues, under published rules. Its gacha is the vault's first integrator.
- **Onix.Finance**, in production: an LP inspector that reconstructs PnL from on-chain events for Meteora, Orca and
  Raydium, and opens wide Meteora DLMM positions in one atomic transaction.
- **`solana-lp-utils`**, public, delivered under a Superteam Brazil grant.

Everything but the first predates the Crypto World's Fair window (14 September 2026). Built in the window: the curve
configuration, custody by derivation, the Create door, the trade panel (curve and pool), Play, the gacha API and its
first integrator, the treasury loop, the page, the docs.

## Where we are and what comes next

- **Now:** the full loop runs on mainnet on two vaults made to test it (`$OCC`, `$VOLT`); the first public vault, the
  founder's own Pokémon collection, opens next through the same page anyone uses.
- **Next:** collectors who already hold tokenized slabs on Collector Crypt and Phygitals open their own vaults; every
  graduated vault's cards are sold by Onix.Cards' Onix.Vault machine and by any gacha that integrates the API.
- **Then:** an escrow program for custody, and new asset classes as soon as their custodians publish identity, value and
  redemption in the token (wine, watches and comics are already tokenized on Solana).

## The platform, in one line

**Your collection. A business in minutes.** Every vault pays its creator, sells to every gacha through the same API and
restocks itself. That is the business: not one vault, but the rail every collection runs on.
