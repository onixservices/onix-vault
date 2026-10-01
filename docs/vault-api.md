# The vault API — v1

> How a gacha (ours or anyone's) buys an item out of a vault, and how a holder redeems one.
> Written for Vault #1 (graded cards); the contract is the same for any registered custodian.
> Drafted 30 September 2026. **This is the boundary between the public, read-only side and
> the private, signing side.** Everything below the line "settle" runs in Onix's private
> infrastructure and only ever moves a card *after* a payment or a burn is confirmed on chain.

## Why an API and not a program

A program with escrow is the right destination and it is on the roadmap. It is not a
three-week build that we would trust with other people's money. v1 is an HTTP API whose
every state change is anchored to a public transaction: the payment or the burn is on
chain, the delivery is on chain, and the API is the thing in the middle that checks one
before doing the other. Anyone can audit the pairs.

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

v1 serves **Vault #1** at `cards.onix.finance/api/vault/…` (one vault; the `/v1/vaults/:vault/…`
form is reserved for when a second vault exists). Implemented 1 October 2026 in Onix.Cards'
backend — the gacha's own worker calls these same functions, in-process, with no privileged path.
All responses carry `readAt` (ISO time) and the source of every price.

### `GET /api/vault/items`

Every item in the vault wallet, from the chain, with:

```json
{
  "mint": "…",
  "issuer": "collector-crypt",
  "title": "…", "grade": "PSA 10", "cert": "…", "physicalVault": "PWCC Vault, Tigard OR",
  "custodianValueUsd": 135.00,   // the attribute the custodian wrote; "Insured Value" for cards
  "marketRefUsd": 118.00, "marketRef": { "source": "…", "sample": 12, "ageSec": 340 },
  "exitPriceUsd": 135.00,
  "redeemPriceUsd": 155.25,
  "status": "available" | "reserved" | "leaving",
  "reservedUntil": null
}
```

`status` is the only thing the API adds to what the chain says. A `reserved` card is still
in the wallet and still counts in on-chain backing; the proof page labels it.

### `POST /api/vault/reservations`

```json
{ "mint": "…", "integrator": "<pubkey>", "winner": "<pubkey>" }
```

→ `201 { "reservationId", "mint", "exitPriceUsd", "payTo": "<vault wallet>", "payMint": "<USDC mint>", "memo": "<reservationId>", "expiresAt" }`
(pay to the vault wallet's USDC associated account; the integrator derives it from `payTo` + `payMint`)

- One live reservation per card. A second request for a reserved card is `409`.
- `expiresAt` is **short** (minutes). Reserve only when the player has already paid you.
- An integrator that lets reservations expire repeatedly is refused with `429` and a reason.
- The quoted price is **frozen for the reservation window** and only for it.

### `POST /api/vault/reservations/:id/settle`

```json
{ "paymentSignature": "…" }
```

The API reads the transaction from the chain and checks, in this order:

1. it landed and is finalized;
2. it credits the vault's USDC account with **at least** `exitPriceUsd` (post-balance minus
   pre-balance, read from the transaction itself, never from an indexer);
3. the memo equals the reservation id;
4. the reservation has not expired.

Only then the vault wallet builds the delivery, **simulates it** (the same deliverability
check the gacha has used since August 2026), signs, **persists the signed transaction, then
broadcasts** — so a crash between the two can never deliver twice, and a rebroadcast is the
same signature.

→ `200 { "deliverySignature": "…", "mint", "winner" }` · `402` if the payment does not
cover the price · `410` if the reservation expired (the payment, if any, is refunded by the
operator by hand in v1, and the page says so).

### `POST /api/vault/redemptions` *(v1: recorded, verified by the operator)*

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
