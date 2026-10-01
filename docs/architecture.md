# Architecture

> How Onix.Vault is put together, and — more importantly — **where the line is drawn**.
> Written 21 September 2026, before the code, so the boundary is a design decision
> rather than something that happened.

## The one rule everything else follows

> **The code is public; the key is not.**

Everything that makes a vault work is in this repository, including the server that
delivers items and therefore signs. What is not here, and never will be, is the vault
wallet's secret key: it is generated on the machine that runs the server, lives in that
machine's `.env`, and is read by exactly one module (`server/signer.js`) behind an
interface (`publicKey()`, `signTransaction()`) so that the key can move to a KMS or a
multisig by configuration, without touching the rest. That is the production pattern
Solana's own docs describe, and it is the product claim: **anyone can verify any vault
without asking us for anything — and anyone can run one.**

Why the earlier rule ("what signs is not public") changed, on 1 October 2026: the vault
API had been built inside Onix's private monorepo because it could reuse the gacha's
signer and delivery code. That would have meant the judged work was not in the judged
repository. The API, the delivery and the fee pipeline moved here; the private monorepo
keeps only what is private — deployment, the vhost, the `.env`.

```
┌─ PUBLIC · this repository ──────────────────────┐   ┌─ PRIVATE · one machine's .env ─────┐
│  src/reader   what is in a vault, per token      │   │  VAULT_SECRET_KEY  read only by     │
│  src/curve    the DBC configuration              │   │                    server/signer.js │
│  web/         the proof page                     │   │  RPC url           (paid endpoint)  │
│  server/      the vault API · delivery (signs    │   └─────────────────────────────────────┘
│               with the vault wallet) · redemptions│
│  examples/    a complete integrator client       │   ┌─ PRIVATE · Onix monorepo ──────────┐
│  reads: Solana RPC + DAS · writes: deliveries    │   │  deployment · vhost · fee → card   │
│  holds: NO key                                   │   │  pipeline operations · the gacha   │
└──────────────────────────────────────────────────┘   │  that integrates over HTTP         │
                                                       └─────────────────────────────────────┘
```

### `server/` — the vault API and the delivery

`server/vaultService.js` holds the rules; `server/app.js` the routes (`/v1/vaults/{vault}/…`);
`server/payment.js` builds the payment transaction the integrator signs, and reads a landed
payment back from the transaction itself; `server/transfer.js` builds the delivery by token
standard (pNFT, classic, Core); `server/index.js` is the only place they meet: build →
assert single unsigned signer → sign → **persist the signed transaction** → broadcast.
`server/items.js` lists the vault from the chain through the same reader the page uses.
The contract is `server/openapi.json`; `docs/vault-api.md` follows it.

## Components

### `src/reader/` — what a vault holds

Takes a vault wallet address and returns its contents and what they are worth. It asks
Solana's DAS API for the assets owned by that wallet and keeps only those from a
**registered custodian**: a collection address, the attribute that carries the custodian's
value, and the custodian's redemption path. For Vault #1 the registry has two entries
(Collector Crypt, Phygitals) and the value attribute is `Insured Value`; grade, grading
company, certificate and the physical vault's address come along for display. A new asset
class is a new registry entry, not a new reader.

It is deliberately dumb: no database, no cache that can go stale silently, no list of
items we maintain. **If an item is not on chain, from a registered custodian, it does not
count.** Everything else in the wallet is listed with the reason it was not counted.

Backing is reported twice, and the two are never conflated:

| | |
|---|---|
| **index** | the sum of `Insured Value` as the custodian wrote it |
| **realisable** | index × `0.89` — the measured median of what the market actually pays |

The `0.89` is a measurement, not an opinion, and it carries its sample and its date.

### `src/curve/` — the bonding curve

The Meteora DBC configuration, with the reasoning for every parameter recorded next to
it. Fees are collected in the quote token so that what arrives is already the currency
cards are bought in.

Of every trade, a published share is split three ways:

```
10% fee ─┬─ 50% buys another graded card into the vault   → backing per token rises
         ├─ 30% buys the token back on the market          → value returns to holders
         └─ 20% operator
```

Fees are one of **four doors**. The other three are rules, not code paths in this
repository, and they all move backing per token the same way — up:

| door | rule | who signs |
|---|---|---|
| admission | card in → tokens for 80% of realisable value, vested | the depositor |
| redemption | burn tokens worth `max(insured, market) × 1.15` → that card out | the redeemer burns; the vault wallet delivers |
| gacha | a gacha buys a card at `max(insured, market)` through the vault API | the gacha pays; the vault wallet delivers |

The vault **never chooses** what leaves: a card leaves because someone burned for it or a
gacha paid for it, at the published price. Delivery reuses the prize-delivery path Onix.Cards
has run in production since August 2026 (sign → persist → broadcast; deliverability proved by
simulation before anything moves). The API contract is in `docs/vault-api.md`.

### `web/` — the proof page

Two numbers side by side — **market cap** (price × supply) and **backing** (what the
vault holds) — and the ratio between them. They are never added together: one is what
the market is paying, the other is what is in the box.

Every figure on the page carries where it came from and how old it is. A stale number is
shown with its age, never silently refreshed and never hidden.

## How a fee becomes an item

The interesting part is that **step 3 is not new code**. Onix already runs an agent that
buys graded cards on its own, across several venues, under published rules. Onix.Vault does
not reimplement it.

```
1.  someone trades on the curve                        │ Meteora DBC
2.  fee accrues to the fee claimer, in quote token     │ Meteora DBC
3.  the existing buying agent buys a card at the rule  │ private · signs
4.  the card lands in the vault wallet                 │ Solana
5.  the reader sees one more card                      │ this repo · reads only
```

Step 5 needs no notification from step 4. The reader does not trust a message that a
purchase happened — it looks at the wallet. **Nothing in this system asks you to believe
an event fired.**

## Admission

An item enters a vault and its owner receives tokens for a published fraction of what
that item is **realisably** worth, vesting over time (a time lock, never the DBC's
migration-anchored vesting — see `curve-config.md`).

```
insured value  →  × 0.89 realisable  →  × 0.80 admission  →  tokens, vesting
                                        the 20% stays in the vault
```

The discount is not a fee we collect. It stays inside the vault, where it covers what the
vault loses when that card is eventually sold, and it makes the vault a bad place to dump
your worst shelf. Its useful side effect: **every admission raises backing per token for
everyone already holding**.

The rule is the same for the operator's own cards and for a stranger's. Vault #1 was
seeded through the same path a third party would use — which is what makes this a
platform with one vault rather than our vault with a page on it.

## Deployment

The proof page is static and reads the chain from the browser. It is served as its own
vhost alongside the existing Onix apps; nothing in the current production path changes.

## What is deliberately not here

- **A vault that runs its own draw.** The vault *sells* to gachas through the API (in the
  window, with Onix's gacha as the first integrator); it never operates one. The version
  where the vault is the house is roadmap and a legal question before it is a build.
- **A program with escrow enforcing redemption and settlement.** v1 is an API whose every
  step is anchored to a public transaction; the program is the destination.
- **Third parties creating their own vaults.** Roadmap. Vault #1 is the seed of that, not
  the alternative to it — and it was created through the same path a third party will use.
- **Anything that signs.** By design, permanently.
