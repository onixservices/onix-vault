# Architecture

> How Onix.Vault is put together, and — more importantly — **where the line is drawn**.
> Written 21 September 2026, before the code, so the boundary is a design decision
> rather than something that happened.

## The one rule everything else follows

> **What only reads the chain is public. What signs a transaction is not.**

This repository is the public half. It holds no keys, reads no secrets, and needs no
account with us. That is not only a security posture — it is the product claim:
**anyone can verify any vault without asking us for anything.**

If a file here needs a secret to work, it is on the wrong side of the line. That is a
design error, and it is visible immediately.

```
┌─ PUBLIC · this repository ────────────┐   ┌─ PRIVATE · Onix infrastructure ──────┐
│                                       │   │                                      │
│  reader/     what is in a vault       │   │  fee claim      signs with the       │
│              backing per token        │   │                 pool authority       │
│  curve/      the DBC configuration    │   │                                      │
│  web/        the proof page           │   │  card purchase  the existing agent,  │
│                                       │   │                 signs with operator  │
│  reads: Solana RPC + DAS              │   │                                      │
│  writes: nothing                      │   │  holds: every key                    │
└───────────────────────────────────────┘   └──────────────────────────────────────┘
```

## Components

### `src/reader/` — what a vault holds

Takes a vault wallet address and returns its contents and what they are worth. It asks
Solana's DAS API for the assets owned by that wallet, reads each card's own on-chain
attributes — `Insured Value`, grading company, grade, certificate number, physical vault
— and computes backing.

It is deliberately dumb: no database, no cache that can go stale silently, no list of
cards we maintain. **If a card is not on chain, it does not count.**

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

## How a fee becomes a card

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

A card enters a vault and its owner receives tokens for a published fraction of what
that card is **realisably** worth, vesting over time.

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

- **The gacha running on top of a vault.** Roadmap. It is the second engine — it earns
  from players rather than traders — but it is not built in the hackathon window.
- **Third parties creating their own vaults.** Roadmap. Vault #1 is the seed of that, not
  the alternative to it.
- **Anything that signs.** By design, permanently.
