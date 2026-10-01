# Business model — DRAFT

> For the "Business Plan" criterion, which the 2026 rules define as *"the team's ability to
> execute"*. Drafted 22 September 2026. Revenue lines are mechanisms, not forecasts.

> Onix.Vault is a platform for vaults of real-world assets a custodian has already put on
> chain. Vault #1 holds graded cards, so the lines below say "card"; read "item" for any other
> registered custodian.

## How Onix.Vault makes money

One published number: **1.6% of every trade** on the curve is the operator's.

That is what is left after the protocol's cut (Meteora keeps 20% of every fee, fixed by the
program) and after the vault's own share:

```
10% fee ─┬─ 2%   Meteora
         ├─ 4%   buys a card into the vault      → backing grows for every holder
         ├─ 2.4% buys the token back              → value returns to holders
         └─ 1.6% operator                         → revenue
```

Every leg is a public transaction. The split is printed on the vault page, not in a Discord.

Three further lines exist and are **not** in the number above. None of them is an
operator fee; all of them raise backing per token, which is the asset the operator is
paid on:

- **Admission.** A card enters a vault at 80% of its realisable value. The 20% stays in
  the vault.
- **Redemption.** A holder burns tokens worth `max(insured, market) × 1.15` for a specific
  card. The 15% premium stays in the vault. This is the door Meteora + Sunrise's `$SV151`
  (Jun 2026) does not have — and it trades at 0.80–0.95× of its reserve.
- **Gacha.** Any gacha buys a card from the vault at `max(insured, market)` through the
  vault API (`docs/vault-api.md`) — above the 0.89× the market pays on a listing. Onix's
  own gacha is the first integrator, by the same public endpoints.
- **After graduation.** The DAMM v2 pool the token migrates to charges its own fee, and the
  curve's migrated liquidity is permanently locked. That pool keeps feeding the vault after
  the curve is gone.

## What it costs

Almost nothing marginal. The reader is static and reads the chain from the browser. Fee
claims and card purchases are scheduled jobs against infrastructure Onix already runs. The
real cost is the one every vault carries: **whoever operates it holds the keys**, and that
is named on the page rather than abstracted away.

## Proof of execution — what already runs

The criterion asks whether the team can execute. The honest answer is what is already in
production, verifiable on chain:

- **Onix.Cards**, in production since 3 August 2026: a cross-issuer terminal for tokenized
  graded cards. It buys inventory **on its own**, across several venues, under published
  rules, with deliverability proven by simulation before every purchase. The Onix.Vault fee →
  card pipeline **is that agent**, not a rewrite of it.
- **Onix.Finance**, in production: an LP position inspector that reconstructs PnL from
  on-chain events for Meteora, Orca and Raydium — and, since 20 September, opens and closes
  wide Meteora DLMM positions in **one atomic transaction**, live on mainnet with real money.
- **`solana-lp-utils`**, public, delivered under a Superteam Brazil grant.

Everything above predates the hackathon window and is declared as such. What is built in
the window is the curve, the vault wallet, the reader, the proof page, the redemption rule
and its v1, and the vault API with the gacha as its first integrator.

## What we are not claiming

- **No traction is claimed for Onix.Vault.** It launches with the operator's own inventory.
- **No revenue forecast.** 1.6% of a volume we cannot predict is not a number we will print.
- **No decentralisation claim for Vault #1.** It is operated by Onix, with one signature,
  and the page says so. Multisig and a program-held vault are on the roadmap, in that order.

## Where ONIX fits — and where it does not

Onix already has a token (ONIX, minted April 2026, never launched, no pool). It is **not** the
vault token and never will be. A vault token is the quota of *one* vault: it is burned to
redeem that vault's items and diluted when items are admitted. ONIX is meant to be worth
something across *every* vault, so it has to sit one level up:

| role | what it does | status |
|---|---|---|
| **Admission ticket** | paying an admission in ONIX improves the admission rate (e.g. 85% instead of 80% of realisable value) in any vault | roadmap — rule text only in the window |
| **Vote** | the parameters of each vault (redemption premium, buy rule) are set by ONIX holders | roadmap |
| **Treasury policy** | the operator's own revenue (the 1.6% above, and nothing taken from holders) may seed and feed an ONIX/USDC pool. That is *our* money being used for *our* token, declared as such — never a leg of the trade fee | roadmap; after mint authority is revoked |

Two things are prerequisites and are said plainly: ONIX's mint authority is still active and
its supply sits in one wallet; both change before ONIX is shown to anyone. Nothing about ONIX
is built in the hackathon window, and the Vault #1 token (`$VEONIX`) is minted by the curve
with an immutable authority precisely so that it carries none of this history.

## The platform, in one line

Vault #1 is the seed. **Anyone who holds already-tokenized, custodied assets can run a
vault under the same rule the operator was admitted under** — and the operator earns on
every vault the same way it earns on its own. Every vault is also a prize supplier to every
gacha through the same API. That is the business: not one vault, but the rail every vault
runs on, with four doors that all pay the vault.

## The operator holds no tokens (1 October 2026)

Vault #1 was seeded with Onix's own cards **as a donation**: the operator received no tokens for
them, there is no allocation and no vesting, and the DBC's `lockedVesting` is zero. Onix earns the
operator's leg of the fee (20% of the 10%) and nothing else. Third parties who send a card are owed
tokens that the vault **buys on the curve** with its USDC (80% of realisable, locked 12 months) —
the curve is the only source of tokens, for everyone. This is the simplest honest answer to "who is
dumping on me": nobody holds a bag.
