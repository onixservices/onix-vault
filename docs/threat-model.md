# Threat model

> What can go wrong when a page makes claims about real money and real property, and what
> stops each one. Written before the build, 21 September 2026.
>
> This document is deliberately blunt. A vault that holds other people's value earns trust
> by naming its own failure modes first.

## What we are actually protecting

Three different things, with three different failure modes:

| | what breaks if it fails |
|---|---|
| **the cards** | the vault is empty and the token is backed by nothing |
| **the numbers** | the cards are fine but the page lies about them |
| **the rules** | the cards and numbers are fine but someone extracts value unfairly |

Most attention in crypto goes to the first. **The second is the one that actually happens**,
and the third is the one that is hardest to undo.

---

## 1. Custody — the cards

### The vault wallet is compromised
Every card leaves in one transaction and the backing is gone.

**Today:** the vault is a wallet operated by Onix, and we say so on the page. That is the
honest description of a single point of failure, not a mitigation.
**Mitigations in place:** the vault wallet is separate from every operational wallet, holds
no other role, and signs nothing except admissions. Its address is published, so the theft
would be visible to anyone within one block.
**Roadmap, in order:** multisig, then a program that can only release under published rules.
**What we will not do:** describe the current setup as trustless. It isn't.

### The custodian fails
The cards are tokenized by Collector Crypt and physically held in OmniVault, PWCC and PSA
Vault. If the custodian stops honouring the token, the NFT is a picture.

**Mitigation:** none that we control, and pretending otherwise would be the dishonest move.
What we do instead is **name the custodian and the physical vault on every card**, so the
reader is evaluating a risk they can see rather than one they cannot.

### A card leaves without the page noticing
**Mitigation:** the reader never trusts an event. It asks the chain what the wallet holds,
every time. There is no cached inventory that can drift from reality.

---

## 2. Honesty — the numbers

This is the section that matters most, because these failures are quiet.

### Insured value is treated as a market price
The custodian's `Insured Value` is an index they assign. It is **not** what a card sells for.
Publishing backing at index inflates it by roughly 12%.

**Mitigation:** backing is always shown after the measured `0.89×` haircut, and both figures
are labelled. The multiplier carries its sample size and date, and is re-measured rather
than inherited.

### Liquidity is added to backing
Money that went up the curve sits in the pool and becomes migration liquidity. It is not the
vault's and cannot buy a card.

**Mitigation:** the two are never summed anywhere in the codebase or the page. Adding them
is a bug with a test, not a judgement call.

### A stale number is shown as fresh
**Mitigation:** every figure carries its age. A value we cannot refresh is shown with how old
it is; a value we never had shows an em dash. **`$0.00` is only ever printed when zero is a
measured fact.**

### The page implies a right that is broader than the one granted
"Backed by cards" reads as "I can get a card". The right actually granted is narrower: a
**specific** card, for a **specific** number of tokens, at a **published** price with a
premium.

**Mitigation:** the rule and the price per card are on the vault page, not in a FAQ, and the
price is computed live from the same sources the backing uses. A card that is reserved by a
gacha or mid-redemption leaves the displayed backing with a label, so the page never counts a
card that is about to leave.

---

## 3. Fairness — the rules

### Adverse selection on admission
If cards were admitted at full value, the rational move is to deposit your worst card and
keep your best.

**Mitigation:** admission pays a published fraction of **realisable** value, not index. The
gap stays in the vault. Dumping a bad card is a bad trade by construction.

### The operator competes with its own vault
The operator runs a gacha that sells cards to players, and operates the vault that sells cards
to gachas. That is a real conflict.

**Mitigation:** the operator holds **no card inventory outside the vault** — all 37 cards it
owned were admitted (30 September 2026). Its gacha buys from the vault through the same public
API and at the same published price as any other gacha, and every such purchase is a public
transaction. Declared is inventory; hidden is a conflict.

### The seeder exits through later buyers
Whoever seeds a vault holds the largest position and could sell into the people who bought
after them.

**Mitigation:** admission tokens vest. This protects buyers, and it is the reason the rule
applies to the operator first.

### Which cards stay out of the vault
Keeping the best cards and depositing the worst is cherry-picking from the inside.

**Mitigation:** none stay out. Every card the operator owned is in the vault, and the page
lists them all. There is nothing to pick from.

### Cherry-picking on the way OUT (redemption and gacha)
Whoever can pick a card will pick the one whose insured value lags the market.

**Mitigations:** the exit price is `max(insured, live market reference)`, never the index
alone; redemption adds a **15% premium** that stays in the vault, so every exit raises
backing per token for those who remain. The market reference is the one the backing page
already publishes, with its sample and its age.

### Floor and ceiling collapse into one
If redemption and admission were both at backing value the token would be pinned to NAV:
no speculation, no volume, no fees — the mechanism that funds the vault would starve.

**Mitigation:** the two doors have different prices on purpose. Redemption at 1.15× puts the
arbitrage floor near 0.87× of backing; admission at 0.80× puts the ceiling at 1.25×. The
band between them is where trading lives.

### A gacha reserves cards it never pays for
The reservation step of the vault API could be used to lock the whole vault for free.

**Mitigations:** reservations expire on a short TTL; an integrator that repeatedly reserves
without settling is cut off; a reserved card is still in the wallet and still counts in the
on-chain backing — only the *displayed* backing labels it.

### The vault becomes the house
If the vault itself ran the draw, token holders would be exposed to gambling regulation on
top of everything else.

**Mitigation:** the vault only **sells** at a published price. Whoever runs a draw runs it
under their own rules and their own regulator. This is a design boundary, not a
configuration.

---

## 4. The boundary itself

### A secret reaches the public repository
**Mitigations, layered:** the architecture means nothing here needs a secret; the
`.gitignore` is an allowlist; a `pre-commit` hook refuses private keys, Solana keypairs, API
keys and `.env` files; GitHub's push protection is a second, independent net.
**If it happens anyway:** the key is compromised the moment it lands. Deleting the commit is
not a remedy — **rotate**.

### The signing side is reached through the public side
**Mitigation:** there is no path. This repository writes nothing and holds no credential.
The private side never accepts instructions from it.

---

## 5. Things we know are unresolved

Listed because a threat model that ends in "all clear" is not a threat model.

- **Custodian concentration.** Vault #1's backing is 37 cards, **all held by one custodian**
  (Collector Crypt). If that custodian fails, pauses redemptions or delists the collection, the
  backing is neither sellable nor redeemable, whatever the chain says. The platform spreads
  this across custodians and asset classes over time; Vault #1 does not, and the page names
  the custodian next to every item so nobody mistakes "on chain" for "custodian-proof".

- **Single-signature custody of vault #1.** Named on the page. Multisig is roadmap, not done.
- **A vault with no trading earns no fees, so backing never grows.** Not a security failure,
  but it is the most likely way this ends up meaning nothing.
- **Legal shape.** A token whose treasury is managed by an operator and which returns value to
  holders resembles a security in several jurisdictions. A redemption right for a physical
  good arguably moves it towards a warehouse receipt; we are not lawyers, and this is named,
  not solved. The copy avoids language that makes it worse.
- **Redemption v1 is semi-manual.** The burn is verified on chain by us and the vault wallet
  delivers; there is no program enforcing it yet. The rule is published and every delivery is
  a public transaction, but a holder still trusts the operator to honour it. A program with
  escrow is the destination.
- **Third-party demand for the vault API is unmeasured.** Onix's own gacha is the first
  integrator, and it says so. Nobody else has asked yet.
- **The `0.89×` is our own measurement** from our own sales. It is the best number we have and
  it is not an independent one.
