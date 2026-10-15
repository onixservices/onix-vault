# The vault API — v1

> How a vault is created, traded and played, and how a gacha (ours or anyone's) buys an item out of it.
> Written for vaults of graded cards; the contract is the same for any registered custodian. The server only ever
> moves an item *after* a payment or a burn is confirmed on chain, and every delivery is a
> public transaction paired with the one that caused it.

## Why an API and not a program

A program with escrow is the right destination and it is on the roadmap. It is not a
three-week build that we would trust with other people's money. v1 is an HTTP API whose
every state change is anchored to a public transaction: the payment or the burn is on
chain, the delivery is on chain, and the API is the thing in the middle that checks one
before doing the other. Anyone can audit the pairs.

**The contract is `server/openapi.json`; this page explains it.** The shape follows the
one Collector Crypt's Gacha API uses with its integrators (Jupiter, Solflare): the vault
**builds the payment transaction**, the integrator only signs and sends it, and the item is
delivered after the payment is confirmed on chain. A complete client is in
`examples/integrator/` — the same one Onix.Cards' gacha runs.

## The rule the exit doors share

```
exit price of an item (gacha API) = max(custodian value, live market reference)
Play, USDC                        = the band's average custodian value × 1.15
Play, token                       = the band's average × 1.10 ÷ (realisable backing ÷ supply)   — share of backing
```

- `custodian value` — the custodian's own on-chain attribute (`Insured Value` for graded cards).
- `live market reference` — the same reference the backing page publishes, with its sample and age; if
  it cannot be read the gacha price is **unavailable**, never the index alone.

| door | pays | who signs what |
|---|---|---|
| **gacha** | `exit price` in USDC, to the custody wallet | the integrator pays; the custody key delivers to the winner |
| **Play · USDC** | the band price, to the custody wallet | the player pays; the custody key delivers to the player |
| **Play · token** | the band price in the vault's token, **burned** by the player | the player burns; the custody key delivers |

The buyer pays the full price to custody. Of it, 93% stays in the vault, 5% goes to the creator and 2% to Onix, paid by
the custody every 15 minutes with the fee claim (contract 1.6.0 — nothing changes in what an integrator signs or how a
payment is verified); a burn shrinks the supply. The vault never picks which item leaves: the gacha picks by paying for a
specific item, Play draws by commit-reveal.

## Status codes an integrator handles (contract 1.6.1)

| code | meaning | what to do |
|---|---|---|
| `400` | malformed input: an address that is not a base58 public key, a signature that is not base58 text, `slippageBps` outside 1–500 | fix the request |
| `402` | the wallet cannot pay: a play or a trade it cannot fund, or a creator's wallet without the SOL a launch needs (about 0.12) — the message carries the numbers | fund the wallet, then retry |
| `404` | unknown vault, or a reservation / play that belongs to another vault | use the vault the object was created on |
| `409` | the state does not allow it yet (payment not finalized, item reserved, launch in flight) — or an `Idempotency-Key` already used by another integrator or vault | **retry later**, or choose another key |
| `429` | rate limit for this address on this kind of request | **retry later** |
| `503` | the operator paused the server or this vault (`GET /v1/health` → `paused`); nothing is lost, payments already made are processed when it lifts | **retry later** — never treat it as a failure |
| `500` | unexpected; the body carries a `ref` the operator finds in the log, never the error text | retry; report the `ref` if it persists |

The machine-readable contract is [`server/openapi.json`](../server/openapi.json); a test holds it to the routes the
server actually serves.

## Endpoints

Served at `vault.onix.finance`. `{vault}` is the vault wallet; `GET /v1/vaults` lists every vault, and any other wallet
answers 404. There is no API key: an integrator names itself in `integrator` on a reservation, and limits are per address. `POST` honours
`Idempotency-Key` (per vault and integrator). All responses carry `readAt` and the basis of every price.

### What the page reads

The vault page at `vault.onix.finance` is a static file served by the same server and it reads
**only these endpoints** — the browser never holds an RPC key, and nothing on the page is a
number the API did not serve with its source and age.

| endpoint | what |
|---|---|
| `GET /v1/vaults` | every vault served, with name, creator, rules, token and `stats` |
| `GET /v1/vaults/{vault}/stats` | backing (`indexUsd`, `realisableUsd`, `multiplier`) and, only when a pool exists, `pool` = price · supply · market cap · `ratio` (market cap ÷ realisable) · graduation progress · fees; until then `pool: null` and `poolStatus` says why. The two numbers are never summed. |
| `GET /v1/vaults/{vault}/activity` | the doors that fired, newest first — graduation, plays, gacha sales (each USDC sale with its split and payout), the treasury's fee claims and purchases, the creator's additions, each with its signatures |
| `GET /v1/wallets/{wallet}/eligible-items` | "Create a vault", step 1: what in a wallet comes from a registered custodian with a value on chain; the rest listed with the reason |

Anyone who prefers their own RPC can run the CLI reader (`npm run backing -- <custody wallet>`) against
their own endpoint: same decoder, same numbers.

### The Admit door — the creator adds an item

A vault is a **rule**, not a wallet that accepts anything (`server/rules.js`): registered custodian(s), a
category, a minimum value, a minimum grade. **Only the creator adds items**, and nobody is
paid tokens for it: the supply is the curve's, and an added item raises backing per token for every holder.

| endpoint | what |
|---|---|
| `GET /v1/vaults/{vault}/eligible-items?wallet=` | what in a wallet passes **this vault's** rules; the rest with the reason |
| `POST /v1/vaults/{vault}/admissions/build` `{ owner, mint }` | 403 unless `owner` is the creator. The transfer owner → custody, **unsigned, single signer = owner**, plus the base58 message; 404 if the owner does not hold it, 422 if it fails the rules |
| `POST /v1/vaults/{vault}/admissions` `{ mint, owner, signature, valueUsd }` | records it (`pending`); a sweep reads the chain and marks it `admitted` — and adds it to the manifest — when custody owns the item. `GET …/admissions` lists every one |

Anything sent to a custody wallet outside this flow is **not in the manifest and does not count**.

### The Create door

Anyone with eligible items opens a vault on them. The items go into a **custody wallet derived for
the vault** (`server/keyring.js`: SLIP-0010 from one master seed, `m/44'/501'/<index>'/0'`, no key on
disk), so every door works for every vault. The creator's own wallet is the pool's creator: it receives
the 50% allocation (vesting from graduation) and the on-chain creator fee. Only the creator adds items
later. Nothing is ever pre-signed by the server.

| step | call | what happens |
|---|---|---|
| 0 | `GET /v1/vaults/create/quote?wallet=&rules=` | what the wallet holds that THESE rules take; the curve it implies (opens at 2× realisable; graduates at `gradMult` × that; 50% creator) |
| — | `POST /v1/vaults/create/upload` (raw image bytes) | the coin image or the banner: PNG, JPEG or WebP **decided by the bytes** (never SVG), ≤ 1 MB, stored under its sha256, previewed at `GET /v1/vaults/create/uploads/{id}`; orphans are swept after an hour; rate-limited per address |
| 1 | `POST /v1/vaults/create/open` `{ owner, name, symbol, mints, rules, description, links, imageId, bannerId }` | validates (lists only; symbol unique and not reserved; 1 creation in flight per wallet; global cap/hour), allocates the custody index, returns `custodyWallet` and **`depositTransactions[]`** — items → custody (+0.08 SOL gas in the first), each single-signer = creator, unsigned, simulated. **Nothing of Onix is spent here.** |
| 2 | `POST /v1/vaults/create/deposited` `{ creationId }` | 409 until the chain shows every item in custody (+ the gas). Then Onix creates the curve **config** (pays its rent, once; `feeClaimer` = the custody wallet) and returns the **launch transaction** (`createPool`, creator = payer), unsigned, simulated |
| 3 | `POST /v1/vaults/create/submit` `{ creationId, signedTransaction }` | the creator signed it (`signTransaction`): same content as built (ComputeBudget/Lighthouse the wallet adds are ignored) → the throwaway mint key completes it → broadcast |
| 4 | `POST /v1/vaults/create/confirm` `{ creationId, signature }` | the pool exists on chain → the vault is registered (custody wallet, creator, rules, manifest, image, banner) and served at once. `GET /token/{mint}.json` (what wallets and Meteora read) points at `/token/{mint}.png` and `/token/{mint}-banner.png`, served with a fixed type and `nosniff` |
| — | `POST /v1/vaults/create/abandon` `{ creationId, owner }` | before launch: custody returns every item to the creator (signed by the derived key). Expired creations (2 h) are abandoned by a sweep |
| — | `GET /v1/vaults/create/{creationId}` | where it stands; while open, what custody still lacks and fresh deposit transactions for exactly that |

### The Play door

Pay, draw one item from a band, get it delivered from custody. The draw is commit-reveal (`server/draw.js`,
ported from Onix.Cards): the hash is published before payment, the player's seed rides in the payment memo,
the seed is revealed with the result; anyone recomputes `HMAC(seed, playId|clientSeed|nonce)` → index in the
band's snapshot sorted by mint.

| | |
|---|---|
| `GET /v1/vaults/{vault}/play` | `open` (**Play opens at graduation** — while the curve fills, nothing leaves custody; `lockedReason` says so) and the bands (by custodian value): items, odds (1/n), `priceUsdc` = average × 1.15, `priceTokens` = average × 1.10 ÷ (realisable backing ÷ supply) — **share of backing, never the market price**; `kind` = draw (3+ items) / pick / empty |
| `POST /v1/vaults/{vault}/plays` `{ band, player, currency: usdc|token, clientSeed }` | 409 until the vault graduated. 201: `playId`, `serverSeedHash`, price, and the **payment transaction** for the player to sign — USDC: transfer to custody + memo `play:<id>`; token: `burnChecked` of the player's own tokens + memo. Single unsigned signer = player; simulated first (402 when the wallet lacks funds). 1 unpaid play per wallet; 6 plays an hour |
| `POST /v1/vaults/{vault}/plays/{id}/submit` `{ signature }` | 202: recorded (UNIQUE). A sweep (10 s) waits for finality, reads the payment from the transaction itself (payer, amount, memo; for a burn: the instruction, the mint, the authority, the balance delta), draws, holds the item, delivers from custody (build → assert → simulate → sign → persist → broadcast) |
| `GET /v1/vaults/{vault}/plays/{id}` · `GET …/plays` | the proof: commit, seed (once done), client seed, digest, index, nonce, snapshot, signatures |

A USDC play pays custody: 93% stays and buys the next item; 5% and 2% leave in the custody's next fee claim. A token play burns supply. An item
drawn by a play is never sold to an integrator underneath it, and vice versa.

### The treasury, in public

| | |
|---|---|
| `GET /v1/vaults/{vault}/fee-claims` | every trading-fee claim into the treasury: curve partner fee, pool LP fee, Onix's third — and, in the same transaction, the sales paid out (5% creator, 2% Onix) — the signature |
| `GET /v1/vaults/{vault}/purchases` | every item the treasury bought: name, price, index, status (`sent` · `landed` · `failed`), the signature |

Both also appear on `/activity`. `stats.treasury.usdc` is the USDC in custody right now (never part of backing);
`stats.treasury.owedUsd` is the part of it the cards sold owe the creator and Onix until the next claim pays it, and
`availableUsd` what the treasury may spend.

### The Buy door

`POST /v1/vaults/{vault}/trades/quote` and `…/trades/build` — a quote and the swap for the **user's** wallet to
sign (unsigned, single signer, simulated first — 402 with the two numbers when the wallet lacks funds). The
server never signs a trade. 409 until the pool exists. **One door for the token's whole life:** while the curve
is live the quote is Meteora DBC's (buys fill up to the graduation threshold and return the rest); once it
migrated the same routes trade on the graduated **DAMM v2 pool** through `@meteora-ag/cp-amm-sdk`
(`quote.venue` = `curve` | `pool`; `priceImpactPct` on the pool). Jupiter is not a dependency: a pool a few
dollars deep is not routed there, the vault's own pool always is.

### `GET /v1/vaults/{vault}/items`

Every item in the vault wallet, from the chain, with:

```json
{
  "mint": "…",
  "custodian": "collector-crypt",
  "name": "…", "category": "Pokemon", "imageUrl": "…",
  "custodianValueUsd": 135.00,   // the attribute the custodian wrote; "Insured Value" for cards
  "custodianValueBasis": "insured",
  "marketRefUsd": null,          // v1 ships without a market reference; when one exists it is named
  "exitPriceUsd": 135.00, "exitPriceBasis": "custodian",
  "status": "available" | "reserved",
  "reservedUntil": null
}
```

`status` is the only thing the API adds to what the chain says. A `reserved` card is still
in the wallet and still counts in on-chain backing; the proof page labels it. The response
also carries `readAt` and `itemsAgeMs` — the chain read is cached for seconds, and the age is
printed rather than hidden.

### `POST /v1/vaults/{vault}/reservations`

```json
{ "mint": "…", "integrator": "<pubkey>", "winner": "<pubkey>" }
```

→ `201 { "reservationId", "mint", "exitPriceUsd", "payTo", "payMint", "memo": "<reservationId>", "expiresAt", "paymentTransaction": "<base64>" }`

**`paymentTransaction` is built by the vault**: ATA of the vault (idempotent), `transferChecked`
of the exact frozen price in USDC from `integrator`, memo = reservation id. Unsigned, single
signer = `integrator`. Sign it, send it, keep the signature. You never assemble accounts or a
memo by hand — the mismatch class of bugs does not exist.

- One live reservation per item. A second request for a reserved item is `409`.
- `Idempotency-Key`: the same key returns the same reservation (and the same transaction).
- `expiresAt` is **short** (minutes). Reserve only when the player has already paid you.
- An integrator that lets reservations expire repeatedly is refused with `429` and a reason.
- The quoted price is **frozen for the reservation window** and only for it.

### `POST /v1/vaults/{vault}/reservations/{id}/settle`

```json
{ "paymentSignature": "…" }
```

The API reads the transaction from the chain and checks, in this order:

1. it landed and is finalized;
2. it credits the vault's USDC account with **at least** `exitPriceUsd` (post-balance minus
   pre-balance, read from the transaction itself, never from an indexer);
3. the memo equals the reservation id;
4. the reservation has not expired.

Only then the vault wallet builds the delivery, asserts it has a single unsigned signer,
**simulates it** (the same deliverability check the gacha has used since August 2026 — a
delivery that would fail on chain is never signed), signs, **persists the signed transaction,
then broadcasts** — so a crash between the two can never deliver twice, and a rebroadcast is
the same signature.

→ `200` the reservation, now `"status": "settled"` with `paymentSignature` and
`deliverySignature` · `402` if the payment does not cover the price · `409` if the payment is
not on chain or not finalized yet (retry) · `410` if the reservation expired (the payment, if
any, is refunded by the operator by hand in v1, and the page says so) · `503` if the payment
is good but the delivery failed: the reservation is `delivery_failed`, keeps the payment, and
the operator re-runs the delivery by hand (`scripts/retry-delivery.js`, same path); poll
`GET …/reservations/{id}` for the `deliverySignature`.

## What v1 does not do, on purpose

- It does not hold anyone's money beyond the two shares of a sale, paid out in the custody's next fee claim. Payment goes
  to the vault wallet; a burn is a burn.
- It does not run a draw, price a pack or know who the players are. That is the integrator's
  business and the integrator's regulator.
- It does not let an integrator choose an exit price. The rule is the same for Onix's own
  gacha and for a stranger, and it is printed.
- It does not enforce custody release by program. Every rule is published and every delivery is a
  public transaction signed by a derived key whose every signature is public (the doors, the fee claim and payout, the
  treasury's purchases); a holder still trusts
  the operator not to misuse the seed. Named in the threat model; the program is the destination.

## First integrator

Onix.Cards' gacha is an integrator of **every** vault, by the same endpoints a third party would use: it discovers
them with `listVaults()` (no address configured), keeps the graduated ones, reads each vault's items, and when a player
wins one it reserves, pays and settles **on the vault that holds it**. Vault machines live in their own **Vaults**
category there — prizes from a vault are not traded in for Onix credit — and use the standard rarity bands, weighted
by what the vault holds. First pull, 3 Oct 2026: the Magnemite the treasury had bought an hour earlier; payment
`5Pxj47…` (operator → custody, memo = reservation), delivery `4Y9SNe…` (custody → player). That is not a claim of
demand; it is the proof that the path works before anyone else is asked to rely on it.
