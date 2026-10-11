# Threat model

> What can go wrong when a page makes claims about real money and real property, and what stops each
> one. Deliberately blunt: a vault that holds other people's value earns trust by naming its own failure
> modes first.

## What we are protecting

| | what breaks if it fails |
|---|---|
| **the items** | custody is empty and the token is backed by nothing |
| **the numbers** | the items are fine but the page lies about them |
| **the rules** | items and numbers are fine but someone extracts value unfairly |
| **the keys** | the server is made to sign something it should not |

Most attention in crypto goes to the first. The second is the one that actually happens; the third is the
hardest to undo; the fourth is the one we can engineer against today.

---

## 1. Custody — the items

### The master seed is compromised
Every custody wallet derives from one seed. Lose it and every vault can be emptied in one block.

**Today:** the seed is generated on the server, lives in a `.env` readable by one user, is read by one
module (`server/keyring.js`) and is never logged, returned or written anywhere else. The operator keeps an
offline backup (made 4 Oct 2026; `docs/security-review.md`, R-07a). The same seed derives the draw key (R-04). Each custody wallet signs **only** through the doors (Play delivery, gacha settlement,
abandon-before-launch), each one built after a payment or a burn was read from the chain. Addresses are
public: a theft would be visible within one block.
**Roadmap, in order:** a program with escrow that can only release under the published rules; until then,
this is a single point of failure and the page says "custody: derived wallet operated by Onix".
**What we will not do:** call it trustless.

### The custodian fails
Items are tokenized by Collector Crypt and held in OmniVault, PWCC and PSA Vault. If the custodian stops
honouring the token, the NFT is a picture. **Mitigation:** none we control. The custodian and the physical
vault are named on every item, and vault rules name the custodian, so the reader evaluates a risk they can see.

### An item leaves without the page noticing
**Mitigation:** the reader asks the chain what custody holds, every time, filtered by the manifest.
There is no inventory we maintain that can drift from reality.

### A creation is abandoned with the items in custody
Items deposited, launch never signed. **Mitigation:** `abandon` returns every item and the gas to the
creator, signed by the derived key, only to the creator who opened it; expired creations (2 h) are
abandoned by a sweep. Measured on mainnet (a card and the gas returned to the creator).

---

## 2. Honesty — the numbers

### Insured value is treated as a market price
The custodian's `Insured Value` is an index. **Mitigation:** backing is shown after the measured `0.89×`
haircut; both figures are labelled; the multiplier carries its sample and date.

### Liquidity is added to backing
Money that went up the curve becomes migration liquidity; it is not the vault's. **Mitigation:** the two
are never summed anywhere; the strip shows market cap *and* backing *and* the ratio, nothing more.

### "Raised" is confused with market cap
It happened once: the bar showed price × supply as "raised". **Mitigation now:** progress is the
curve's own condition — USDC in the reserve ÷ the threshold in the config, both read from the chain.

### A stale number is shown as fresh
**Mitigation:** every figure carries its age; a value we never had shows an em dash; `$0.00` only when
zero is a measured fact. After a trade the page re-reads the chain until the number moves.

### The page implies a right that is broader than the one granted
"Backed by cards" reads as "I can get a card". The right is narrower: **a draw from a band**, at a
published price, from what is in custody at that moment. **Mitigation:** the machines, their odds and
their prices are on the vault page; a token's share of backing is shown, not promised.

---

## 3. Fairness — the rules

### The creator dumps on the buyers
The creator holds half the supply. **Mitigation:** that half is in `lockedVesting`: nothing before
graduation, then monthly over 6 months, in Jupiter Lock (an escrow anyone can read). Before graduation the
creator owns no tradable token at all. The creator's income is the fee share, paid by the program per trade.

### The creator fills the vault with junk, or pulls the good items
**Mitigations:** deposits pass the vault's **published rules** (custodian, category, minimum value,
minimum grade) on chain, at deposit time; items are counted only while custody holds them; the creator has
**no door of their own** — an item leaves only through Play or the gacha API, at the same price for the
creator and for a stranger.

### Pump-and-play
Pump the token, then buy the cheap item with cheap tokens. **Mitigation:** a token play is priced in
**share of backing** (realisable backing ÷ supply), never at the market price. A pump changes nothing;
only more backing per token makes a play cheaper. Tokens paid are burned, so the next share is larger.

### The draw is rigged, or re-rolled until it suits
**Mitigations:** commit-reveal — sha256 of the server seed published *before* payment; the player's seed
rides in the payment memo; the band's snapshot (mints sorted) is frozen when the play opens; the index
comes only from `HMAC(seed, playId|clientSeed|nonce)`; the seed is derived per play from a server key and never
stored, so the database cannot predict a draw; it is revealed with the result; a redraw
(nonce + 1, at most 5) happens only when the drawn item is no longer free, and every nonce is recorded.
Anyone recomputes the draw with the proof on the page (we did, outside the server, on the first mainnet play).

### Play empties a vault that has not proven anything yet
**Mitigation:** Play opens at graduation. While the curve fills, nothing leaves custody.

### Pay once, play twice · pay from another wallet · pay with the wrong thing
**Mitigations:** `UNIQUE(payment_sig)`; the payment is read from the transaction: payer = player, memo =
`play:<id>`, USDC delta on custody ≥ the frozen price, or `burnChecked` of the vault's mint by the player
with a balance delta ≥ the price; a wrong payment is `payment_rejected` with the reason, never a refund
by the server (there is no refund path by design: the money never reached a server wallet).

### The same item sold twice (Play vs gacha)
**Mitigation:** plays and reservations share one view of what is busy; an item held by a play is not
offered to an integrator and vice versa; the delivery re-checks the chain before signing.

### Spam creations drain Onix's SOL
Each launch costs the partner the config rent. **Mitigations:** the config is created **only after the
creator's items and gas are in custody** (the creator spent first); one creation in flight per wallet;
a global cap per hour; symbols unique and a reserved list (USDC, SOL, VEONIX…); creation and uploads
rate-limited per address.

### A hostile upload
SVG with script, a 50 MB file, a PNG header on a text file. **Mitigations:** type decided by the bytes
(PNG/JPEG/WebP only), 1 MB cap, name = sha256, served with a fixed `Content-Type` and
`X-Content-Type-Options: nosniff`, orphans swept after an hour, uploads rate-limited.

### A gacha reserves items it never pays for
**Mitigations:** reservations expire on a short TTL; an integrator that lets three expire is cut off;
a reserved item still counts in on-chain backing — only the displayed state labels it.

---

## 4. The keys and the wallet

### A wallet is shown a transaction that fails, or one it cannot simulate
Phantom blocks a dApp whose transaction fails simulation or carries a foreign pre-signature ("could be
malicious" / "Solicitud bloqueada" — measured five times across Onix products). **Mitigations:** every
transaction the page hands to a wallet is single-signer = the user, **unsigned**, and **simulated on the
server first** (402 with the two numbers when the wallet lacks funds); the launch's second signer (the
mint) signs *after* the creator, and the server compares what came back **by content**, ignoring the
ComputeBudget and Lighthouse instructions Phantom adds.

### The server is made to deliver without a payment
**Mitigations:** a delivery is built only inside the sweep / `settle`, only after the payment was read
from the chain (finalized); `UNIQUE(payment_sig)`; the server never accepts "I paid" as input.

### A delivery is broadcast twice, or signed when it cannot land
**Mitigations:** build → assert single unsigned signer → **simulate** → sign → **persist** → broadcast.
A rebroadcast is the same signature. A delivery that would fail is never signed; the play becomes
`delivery_failed`, keeps the payment, and only the operator re-runs it, on the server, through the same path.

### The custody pays the wrong address, or pays a sale twice
Every card sold owes the creator 5% and Onix 2%, paid by the custody key in its fee-claim transaction
(`server/commissions.js`, `server/feeclaim.js`). **Mitigations:** the creator's leg can only go to the USDC account
of the creator the vault registered (`vaults.creator` / the registry entry), snapshotted on each sale; rows naming
another wallet hold every payout until the operator reconciles. The transaction is simulated with every account it
may move read back: the treasury, Onix and the creator must each move by exactly the planned amount, the creator's
account must be owned by the creator for the USDC mint, the custody's SOL may fall by the fee and one rent at most
and never under 0.005 SOL; anything else is refused, unsigned. The claim and the sales it pays are persisted in one
write (`owed → paying`) before the broadcast; `paid` when it lands, `owed` again when it fails or never lands. One
claim at a time in the process and across processes (a claim still `sent` holds the next). The restock never spends
what is owed. Sales from before the rule are `pre_rule` and are never paid.

### Onix pays for a config the program will refuse
It happened (SDK said valid; the program said `InvalidTokenSupply`). **Mitigation:** every transaction
Onix pays is simulated against the program before it is sent; the leftover of 0.1% that the program needs
is in the decided config.

### A secret reaches the public repository
**Mitigations, layered:** keys and the seed are generated on the server; the `.gitignore` is an allowlist;
a `pre-commit` hook refuses private keys, keypairs, API keys and `.env` files; GitHub push protection is
a second net. **If it happens anyway: rotate.**

---

## 5. Known and unresolved

- **Custodian concentration.** Every item so far is held by one custodian (Collector Crypt).
- **Single operator of the seed.** Named on the page. A program with escrow is the destination; multisig
  of the operator key is roadmap.
- **A vault with no trading earns no fees, so its treasury never grows.** The most likely way this ends up
  meaning nothing.
- **The treasury buys on one venue.** The restock bot buys on Collector Crypt only, at or below the custodian's index;
  a card it buys is sold to a gacha at the index later. It is automatic and in this repository (`server/restock.js`),
  signed by the custody key, the debit measured before signing — but it is a server-side key spending a vault's money,
  bounded by the vault's rules, one item an hour and $150 a card.
- **Rehearsed attacks** (`scripts/abuse-rehearsal.js`, run against production): 24 of 24 refused on 4 October 2026, after
  the security review. The first run, the day before (21 of 21),
  found a raw error for wallets with no SOL (now a clear 402) and a broken word-boundary in two regexes (fixed).
- **Legal shape.** A token whose treasury buys items and a draw for physical goods touch securities and
  gaming rules in several jurisdictions. Named, not solved; the copy avoids making it worse.
- **The `0.89×` is our own measurement** from our own sales.
- **Third-party demand for the gacha API is unmeasured.** Onix.Cards' gacha is the first integrator.
