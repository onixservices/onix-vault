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
no other role, and signs nothing except deliveries through the two exit doors — each one
built only after a payment or a burn was read from the chain. Its address is published, so
a theft would be visible to anyone within one block.
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

### Anyone can create a vault and the board becomes a dump
The Robinhood Chain launchpad Noxa launched 60,000 tokens in two weeks with no gate, took $12M in
fees and disappeared (July 2026). A vault platform with no gate would be the same, with real items.

**Mitigations (the gate is above, not below):** a vault can only be created over a **custodian we
registered** (we verified identity + value on chain, physical redemption, the collections) — nobody
adds a custodian; a vault is **one custodian + one category**, chosen from the registry, never free
text; only items that pass the vault's rules can be built by the UI, strays never count; creation,
when it opens: an opening lot of the creator's own items (≥ 5 or ≥ $500 realisable), a non-token
creation fee, one vault per wallet per custodian, and **no creator powers** — admission tokens come
from the curve, exits go through the program, the creator earns the operator's leg of the fee and
nothing else; the board ranks by backing and activity, with a minimum to appear. Until the program
exists, creation is operator-run (request access).

### Where admission tokens come from
The curve mints the whole supply into the pool; nobody can mint more. So the sender of an item is
owed tokens that the **vault buys on the curve** with its own USDC (fees, gacha sales) — worth 80% of
realisable, locked 12 months. **Mitigation for the gap:** when the vault has no USDC the admission is
listed publicly as `tokens pending` and is paid in order as USDC arrives; the operator cannot jump the
queue. The operator seeded Vault #1 as a donation and **holds no tokens** — there is no allocation to
dump.

### The vault becomes the house
If the vault itself ran the draw, token holders would be exposed to gambling regulation on
top of everything else.

**Mitigation:** the vault only **sells** at a published price. Whoever runs a draw runs it
under their own rules and their own regulator. This is a design boundary, not a
configuration.

---

## 4. The boundary itself

### A secret reaches the public repository
**Mitigations, layered:** the vault key is generated on the server and read by one module
behind an interface; the `.gitignore` is an allowlist (`server/**/*.js`, never `.env`, never
`*keypair*.json`); a `pre-commit` hook refuses private keys, Solana keypairs, API keys and
`.env` files; GitHub's push protection is a second, independent net.
**If it happens anyway:** the key is compromised the moment it lands. Deleting the commit is
not a remedy — **rotate**.

### The server is made to deliver without a payment
**Mitigations:** a delivery is built only inside `settle`, only after the payment transaction
was read from the chain (finalized, credits the vault's USDC account with ≥ the frozen price,
memo = reservation id); the `settling` state is the reentrancy lock; `UNIQUE(payment_sig)` is
the last one — a payment settles one reservation, ever. The server never accepts "I paid" as
input; it accepts a signature and reads the chain.

### A delivery is broadcast twice
**Mitigation:** sign → **persist the signed transaction** → broadcast. A rebroadcast is the
same signature; a crash between persist and broadcast delivers once or not at all, never twice.

### A delivery is signed that cannot land
**Mitigation:** the delivery is **simulated before it is signed**; a transaction that would
fail on chain (frozen token, wrong account set, missing rent) is never signed and never
broadcast. The reservation becomes `delivery_failed`, keeps the payment, and only the operator
can re-run it — by hand, on the server, through the same path. There is no route for it.

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
