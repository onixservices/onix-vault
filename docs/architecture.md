# Architecture

> How Onix.Vault is put together, and where the lines are drawn. First written 21 September 2026,
> before the code; rewritten 3 October 2026 after the model changed (creator-owned vaults, custody
> per vault, Play) and the whole cycle ran on mainnet; updated 5 October after the security review
> (`docs/security-review.md`).

## The rules everything else follows

1. **The code is public; the keys are not.** Everything that makes a vault work is in this repository,
   including the server that delivers items and therefore signs. The secrets stay on the machine
   that runs it: the operator key (Onix, the curve's partner) and **one master seed** from which every
   vault's custody wallet is derived (`server/keyring.js`, SLIP-0010, `m/44'/501'/<index>'/0'`).
   No key is ever on disk; a backup of the seed is a backup of every custody wallet.
2. **The chain is the truth.** What a vault holds is read from its custody wallet every time, filtered
   by the manifest the creator declared. Nothing is believed because an event said so; payments are
   read from the transaction itself before anything leaves custody.
3. **The server never signs a user's transaction and never pre-signs anything a wallet will see.**
   Deposits, launches, trades and plays are built unsigned, with the user as the only signer, and
   simulated before the wallet sees them. A second signer (the mint at launch) signs *after* the user.
4. **Market cap and backing are two numbers.** They are never added. The ratio is the only place they meet.

```
┌─ PUBLIC · this repository ─────────────────────────────┐   ┌─ PRIVATE · the server's .env ──────┐
│  src/reader   what a custody wallet holds, per token    │   │  VAULT_MASTER_SEED  → server/keyring│
│  src/curve    the DBC configuration (DECIDED) + split   │   │  VAULT_SECRET_KEY   → server/signer │
│  server/      API · creation · custody · trade · play   │   │                      (Onix = partner)│
│               · delivery · uploads · rate limits        │   │  RPC url (paid, with DAS)           │
│  web/         the page (board · vault mini-site · create)│   └─────────────────────────────────────┘
│  scripts/     create-vault · graduate · return-* · claim│   ┌─ PRIVATE · Onix monorepo ──────────┐
│  examples/    the integrator client Onix.Cards runs     │   │  deployment · vhost · the gacha    │
│  reads: RPC + DAS · writes: deliveries · holds: NO key  │   │  that integrates over HTTP         │
└─────────────────────────────────────────────────────────┘   └─────────────────────────────────────┘
```

## A vault, as data

| | |
|---|---|
| **custody wallet** | derived for this vault; holds the items; `feeClaimer` and `leftoverReceiver` of its curve; the treasury (USDC from migration fee and Play) |
| **creator** | the wallet that opened it: pool creator, 50% of the supply in Jupiter Lock (from graduation, over 6 months), 40% of the trading fee on the curve, paid by the program. Only the creator adds items |
| **rules** | lists, not text (`server/rules.js`): category, minimum value, minimum grade, creator fee share (20–50%), graduation multiple (2 / 2.5 / 3). Enforced on every deposit |
| **manifest** | the mints the creator declared (`vault_items`); the reader counts only those, and only while the chain shows them in custody. A stray transfer into custody does not count |
| **token** | one SPL mint per vault, created by the curve. `GET /token/{mint}.json` + the coin image and banner the creator uploaded |
| **state** | *maturing* (the curve is filling) → *live* (graduated: DAMM v2 pool; Play open) · or *closed* (items returned; the pool stays on chain) |

## The lifecycle, and which module does what

```
 Create (server/creation.js)          Trade (server/curve.js · server/damm.js)        Play (server/play.js · draw.js)
 ─────────────────────────────        ──────────────────────────────────────────      ────────────────────────────────
 quote    what the wallet holds       curve   DBC quote/swap, PartialFill on buys     bands   by custodian value
 open     custody derived · deposit   pool    DAMM v2 quote/swap after migration      start   commit published, payment
          txs built (unsigned)        routed  by the migration flag in stats                  tx built (USDC → custody,
 deposited chain shows items+gas →                                                            or burnChecked by the player)
          Onix pays the config        Graduation (scripts/graduate.js)                 submit  signature recorded (UNIQUE)
          (simulated first) → launch  ──────────────────────────────                   sweep   finalized → payment read
          tx built (unsigned)         locker → migrateToDammV2 →                               from the tx → draw (HMAC)
 submit   creator signed → mint       partnerWithdrawMigrationFee →                            → item held → delivered
          completes → broadcast       withdrawLeftover                                         from custody
 confirm  pool on chain → served      (the keeper does not migrate configs like ours)
```

- **`server/index.js`** is the only place the pieces meet: one *bundle* per vault (signer = derived
  custody · items reader with the manifest · stats · admissions · a routed trader · play · delivery).
  Delivery = build → assert single unsigned signer → **simulate** → sign → **persist** → broadcast.
- **`server/stats.js`** reads the curve account with the open-source decoder (`src/reader/pool.js`),
  the config once (threshold, locked vesting, migration fee option) and, after migration, the DAMM v2
  pool through `@meteora-ag/cp-amm-sdk` for the live price.
- **`server/uploads.js`** types images by their bytes (PNG/JPEG/WebP, never SVG), caps them at 1 MB,
  names them by hash and serves them with a fixed type and `nosniff`.
- **`server/ratelimit.js`** is a token bucket per key, no dependency: a first fence on the routes
  that cost something (uploads, creation, plays, builds). The real limits live in the services.

## The curve configuration (decided 2 October 2026 · `src/curve/params.js`)

| | | why |
|---|---|---|
| supply | 10,000,000 | one token = one ten-millionth of the custody wallet |
| creator | 50% in `lockedVesting` (cliff at migration, 6 monthly periods) | the first risk-taker holds the first half, released only once the market exists |
| curve | 50% − 0.1% leftover | the program refuses a supply with no slack when a migration fee is set (measured) |
| opens at | 2× realisable backing | the creator's half is worth the items on day one |
| graduates at | 2 / 2.5 / 3 × the opening (creator's choice) | plausible, never a condition |
| trade fee | 10% · creator 40% of it on chain · scheduler 99%→10% over the first 60 s | the creator is paid by the program; bots cannot front-run the opening |
| migration fee | 30% of the USDC raised → the custody wallet | the treasury that buys the next item |
| graduated pool | DAMM v2, 100% of the LP permanently locked, 1% fee | nobody can pull the liquidity |

Of a trade's 10%: 2% Meteora · 3.2% creator · 3.2% vault treasury · 1.6% Onix (`src/curve/split.js`).

## Play — the exit door

One item from a band (by custodian value) is drawn and sent from custody. **USDC** = the band's average
× 1.15, paid to the custody wallet: the item leaves, the money stays and buys the next one. **Token** =
the band's average × 1.10 ÷ (realisable backing ÷ supply), **in share of backing, never at the market
price**: a pump buys nothing cheaper; the tokens are burned by the player, so supply falls. The draw is
commit-reveal (`server/draw.js`, ported from Onix.Cards): each play's server seed is derived from a server key
(`HMAC(drawKey, vault|playId)`, the key itself derived from the master seed) and never stored, so neither the database
nor a backup predicts a draw; sha256 of that seed is published before payment, the player's seed rides in the memo, `HMAC(seed, playId|clientSeed|nonce)` picks the index in the
band's snapshot sorted by mint, and the seed is revealed with the result. **Play opens at graduation**:
while the curve is filling, nothing leaves custody.

The gacha API (`reservations` → payment → `settle`) is the same door for integrators: Onix.Cards' gacha is
the first one, through the public client in `examples/`. Its **Onix.Vault** machine sells the cards of every graduated
vault at the house's price and band odds; each card drawn is reserved, paid and settled with the vault that holds it.

## The treasury loop — automatic (3 October 2026)

Every 15 minutes, for every vault, the server runs one round (`ONIX_VAULT_RESTOCK=1`):

1. **Fees → treasury** (`server/feeclaim.js`). One transaction signed by the custody claims the curve's partner fee —
   2/3 stays in the treasury, 1/3 is transferred to Onix's revenue account **in the same transaction** — and, once the
   vault graduated, the 1% fee of the DAMM v2 pool accrued on the custody's locked LP position (the custody is the
   position's owner: the migration gives the partner's locked LP to the config's fee claimer). Both balances are measured
   in the simulation before signing; anything that moves them differently is refused. Minimum $1 per round.
2. **Treasury → next item** (`server/restock.js`), graduated vaults only. The cheapest graded card relative to its
   custodian index on Collector Crypt that passes **this vault's rules** (the entry rule, or the creator's own restock
   rule), at or below the index, under $150, one purchase an hour. The custody key signs **only the exact shape of a
   Collector Crypt buy** (measured on two mainnet purchases: ComputeBudget, one marketplace `buy`, the co-signer's noop),
   with a priority-fee cap; the simulation measures the custody's USDC, its SOL and that the item ends in custody; then it
   is signed, persisted, sent, and confirmed against the chain before the item joins the manifest.
3. A round that does nothing says why in the log, once per change of reason.

The first automatic purchase: a Weedle PSA 9 for $15 (index $18), 3 Oct 2026 — and the Magnemite the treasury bought
an hour earlier was won in Onix.Cards' vault machine minutes later, paid to the vault through the public API.

## Inside the server — layers and patterns

- **Pure core, no I/O.** `src/reader` (custody and pool decoding), `src/curve` (the configuration and the fee split),
  `server/draw.js` (the draw), `server/rules.js` (a vault's rules), the payment readers in `server/payment.js` and the
  transaction checks in `server/txAssertions.js`. The same `src/reader` runs on the server, in the CLI and in the
  browser (`web/verify.html`).
- **Services as factories with their dependencies injected** (`createVaultCreator`, `createPlay`, `createRestock`,
  `createFeeClaim`, `createVaultService`, `createAdmissions`, the curve and pool traders). Each receives the chain, the
  indexer, the signer, the clock and the database; tests pass fakes for those and keep the business logic real
  (ports and adapters).
- **Adapters at the edges:** `server/chain.js` (RPC), `src/reader/das.js` (the indexer), the venue API in the restock's
  production dependencies, `server/transfer.js` (one transfer builder per token standard: MPL Core, pNFT, SPL).
- **Routes are thin** (`server/app.js`): validate, call one service, answer. `server/index.js` is the only place the
  pieces meet — one bundle per vault.
- **State machines** for every flow that crosses the chain. Reservations, plays, purchases and admissions move only with
  `UPDATE … WHERE status = <expected>`, and only the caller whose update changed the row continues — one payment, one
  delivery, even with two workers. Creations take a per-creation lock and read the launch state from the chain before
  every step.
- **One signing discipline everywhere the server signs** (deliveries, the treasury's purchase and fee claim, the curve
  config, returns before launch): build → assert the exact shape → simulate and measure what moves → sign → persist →
  broadcast → read the chain back before counting.
- **Operational safety as code:** the emergency pause (`server/pause.js`), per-address rate fences
  (`server/ratelimit.js`), inputs checked at the door (`server/inputs.js`), generic 500s with a reference, and the
  public contract held to the routes by a test (`server/openapi.test.js`).
- **Tests:** `node:test`, 227 of them, mocks only at the transport; every security finding has a regression test that
  fails on the code before its fix (`docs/security-review.md`).

## `web/` — the page

The board shows the vaults in two shelves, *Live* and *Maturing*. **Each vault is its own mini-site**:
banner, coin, description, a strip of numbers for its state, and tabs Trade · Play · Items · Activity ·
Proof. The page reads only `/v1` on the same origin; the browser never holds an RPC key. Every figure
carries where it came from and how old it is; a value we never had shows an em dash.

## What is deliberately not here

- **A program with escrow** enforcing custody release. v1 is an API whose every step is anchored to a
  public transaction and a derived key that signs only through the doors; the program is the destination.
- **Jupiter as a dependency.** A pool a few dollars deep is not routed there; the vault's own pool always is.
- **The seed or any key.** Run the server with your own and it is your platform.
