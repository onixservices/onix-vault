# The vault API — v1

> How a gacha (ours or anyone's) buys an item out of a vault, and how a holder redeems one.
> Written for Vault #1 (graded cards); the contract is the same for any registered custodian.
> Drafted 30 September 2026; served by `server/` since 1 October. The server only ever
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

## The rule that both doors share

```
exit price of an item = max(custodian value, live market reference)
```

- `custodian value` — the custodian's own on-chain attribute, as the backing page reads it (`Insured Value` for graded cards).
- `live market reference` — the same reference the backing page publishes, with its sample
  size and its age. If it cannot be read, the price is **unavailable**, never the index alone.

| door | pays | who signs what |
|---|---|---|
| **gacha** | `exit price` in USDC, to the vault wallet | the integrator pays; the vault wallet delivers to the winner |
| **redemption** | `exit price × 1.15` worth of `$VEONIX`, **burned** | the holder burns; the vault wallet delivers to the holder |

The premium on redemption stays in the vault. The vault never picks which card leaves.

## Endpoints

Served at `vault.onix.finance`. `{vault}` is the vault wallet; v1 serves one vault and answers
404 for any other, so the paths will not change when the second vault exists. `x-api-key` is
optional: it identifies an integrator for limits and never unlocks anything. `POST` honours
`Idempotency-Key`. All responses carry `readAt` and the basis of every price.

### What the page reads

The vault page at `vault.onix.finance` is a static file served by the same server and it reads
**only these endpoints** — the browser never holds an RPC key, and nothing on the page is a
number the API did not serve with its source and age.

| endpoint | what |
|---|---|
| `GET /v1/vaults` | the vaults (one today) with name, operator, custodians and `stats` |
| `GET /v1/vaults/{vault}/stats` | backing (`indexUsd`, `realisableUsd`, `multiplier`) and, only when a pool exists, `pool` = price · supply · market cap · `ratio` (market cap ÷ realisable) · graduation progress · fees; until then `pool: null` and `poolStatus` says why. The two numbers are never summed. |
| `GET /v1/vaults/{vault}/activity` | the doors that fired, newest first — gacha sales and redemptions, each with its signatures |
| `GET /v1/wallets/{wallet}/eligible-items` | "Create a vault", step 1: what in a wallet comes from a registered custodian with a value on chain; the rest listed with the reason |

Anyone who prefers their own RPC can run `web/verify.html` with their own endpoint, or the CLI
reader (`npm run backing`): same decoder, same numbers.

### The Admit door — "Send a card"

A vault is a **rule**, not a wallet that accepts anything (`server/admissions.js`, `VAULT_RULES`):
registered custodian(s), a category, a minimum value. Vault #1: Collector Crypt · graded cards · no
minimum. Three calls, the same shape as the gacha door:

| endpoint | what |
|---|---|
| `GET /v1/vaults/{vault}/eligible-items?wallet=` | what in a wallet passes **this vault's** rules; the rest with the reason |
| `POST /v1/vaults/{vault}/admissions/build` `{ owner, mint }` | the transfer owner → vault, **unsigned, single signer = owner**, plus the base58 message for `signAndSendTransaction`; 404 if the owner does not hold it, 422 if it fails the rules; returns `owedUsd` and `lockMonths` |
| `POST /v1/vaults/{vault}/admissions` `{ mint, owner, signature, valueUsd }` | records it (`pending`); a sweep reads the chain and marks it `admitted` when the vault owns the item. `GET …/admissions` lists every one, with both signatures once the tokens are bought |

**What the sender is owed:** tokens worth `custodian value × 0.89 × 0.80`, **bought on the curve by the
vault as soon as it has the USDC** (fees, gacha sales), locked for the vault's lock period (12 months).
Nobody mints tokens — the supply is the curve's. The same 45 s sweep that verifies the item does the buy:
build on the curve as the vault (pre-flight and simulation included) → sign → persist the signature →
broadcast; the row then carries `tokensSignature`, `tokensAmount` and `unlockAt`. If the vault has less
USDC than owed, the row waits as `tokens: waiting` with the two numbers in `tokensNote`
("needs $17.09 USDC and has $0.00"); nothing is signed. Release after `unlockAt` is the vault's duty
(operator step today; the sweep will do it). Anything sent to the vault wallet outside this flow does not count and
is returned by the operator. Enforcement by an on-chain program (the transfer fails if the rule fails)
is the roadmap; until then the UI cannot build what the rule refuses, and the count ignores it.

### The Create door

Anyone with eligible items in a wallet opens a vault **on that wallet**: the items never move, the
creator's wallet is the vault, and the server holds no key for it (deliveries are therefore not
automatic for such a vault — it lists, trades and admits; the operator's vaults deliver).

| | |
|---|---|
| `GET /v1/vaults/create/quote?wallet=` | what the wallet holds that counts (registered custodian + value), backing, and the curve it implies: opens at **2× realisable**, graduates at **2.5× the opening cap**; supply **50% creator · 10% admission reserve · 40% curve** (the 60% sits in the DBC's `lockedVesting`, released to the creator at graduation) |
| `POST /v1/vaults/create/build` `{ owner, name, symbol }` | Onix (the partner) creates and pays for the curve **config** and is its fee claimer; then returns the **one** transaction the creator signs — `createPool`, creator = payer, pre-signed by the throwaway mint key, simulated before it leaves (409 with the log if it would fail). Symbol: 2–10 `A–Z0–9`, unique. |
| `POST /v1/vaults/create/confirm` `{ creationId, signature }` | the pool account exists on chain → the vault is registered (DB) and served immediately under `/v1/vaults/{creatorWallet}/…`; 409 while the pool is not visible yet |
| `GET /token/{mint}.json` | token metadata for created vaults (name, symbol, default image) |

### The Buy door

`POST /v1/vaults/{vault}/trades/quote` and `…/trades/build` — a Meteora DBC quote on the live pool and
the swap for the **user's** wallet to sign (unsigned, single signer, the base58 message for Phantom).
The server never signs a trade. 409 until the pool exists.

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
  "redeemPriceUsd": 155.25,
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

### `POST /v1/vaults/{vault}/redemptions` *(v1: recorded, verified by the operator)*

```json
{ "mint": "…", "burnSignature": "…", "recipient": "<pubkey>" }
```

v1 is **semi-manual**: the holder burns `$VEONIX` themselves (any wallet can), submits the
signature, and the operator verifies the burn amount against `redeemPriceUsd` at the burn's
block time before delivering from the vault wallet. Every redemption is listed publicly with
both signatures. There is no reservation step: a burn is the commitment.

→ `202 { "redemptionId", "status": "verifying" }` then, on the public list,
`{ "burnSignature", "deliverySignature", "mint", "tokensBurned", "priceUsdAtBurn" }`.

## What v1 does not do, on purpose

- It does not hold anyone's money. Payment goes to the vault wallet; a burn is a burn.
- It does not run a draw, price a pack or know who the players are. That is the integrator's
  business and the integrator's regulator.
- It does not let an integrator choose an exit price. The rule is the same for Onix's own
  gacha and for a stranger, and it is printed.
- It does not enforce redemption by program. The rule is published and every delivery is a
  public transaction; a holder still trusts the operator to honour it. Named in the threat
  model.

## First integrator

Onix.Cards' gacha buys from Vault #1 through this API, by the same endpoints a third party
would use. That is not a claim of demand; it is the proof that the path works before anyone
else is asked to rely on it.
