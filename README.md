# Vaulty

**Auditable, card-backed vaults on Solana.** Built by [Onix](https://onix.finance).

A Vaulty vault holds real graded trading cards that are already tokenized and held by a
named custodian. Its token launches on a [Meteora](https://meteora.ag) Dynamic Bonding
Curve. The vault has **four doors**, each with a published rule:

| door | what happens | backing per token |
|---|---|---|
| **Admission** | a card goes in → tokens for **80%** of its realisable value, vested | rises |
| **Redemption** | burn tokens worth `max(insured, market) × 1.15` → that card is yours; the 15% stays in the vault | rises |
| **Gacha** | any gacha buys a card from the vault at `max(insured, market)` — above what the market pays | rises |
| **Fees** | 10% of every curve trade: 50% buys a card · 30% buys the token back · 20% operator | rises |

The vault never runs a draw and never picks what leaves. Anyone can verify what is inside
a vault without asking us for anything. That is the point.

---

## Vault #1

The first vault is seeded with Onix's own inventory of graded Pokémon and One Piece
cards, held in OmniVault, PWCC and PSA Vault. **Vault #1 is operated by Onix.**

> **The cards are in this wallet. Burn `$VEONIX` and any of them is yours, at the
> published price. Any gacha can buy them at the same price. Every trade on the curve
> buys more.**

Redemption pays a **premium** (1.15×) and admission pays a **discount** (0.80×). Between
~0.87× and 1.25× of backing the price floats freely; below the floor, buying tokens and
redeeming is profitable; above the ceiling, depositing a card and selling tokens is. Each
redemption leaves 15% behind for the holders who stay.

> **Precedent.** Meteora + Sunrise's `$SV151` (Jun 2026) proved that fees-buy-backing
> works — and, with no redemption, trades at 0.80–0.95× of its reserve. Vaulty is the
> next step: backing a third party already put on chain, a redemption rule, and an exit
> for gachas. See `docs/business-model.md`.

---

## Two numbers, never added

A vault page shows **market cap** (price × supply — what the market says) and **backing**
(the cards in the wallet — what we can prove) side by side. They are different things.
The interesting figure is the ratio between them.

Card values come from the custodian's own on-chain `Insured Value` attribute. That is an
index, not a sale price: the measured median the market actually pays is **0.89×** of it.
Both numbers are shown, always labelled, always with their age.

---

## What is in this repository

| | |
|---|---|
| `src/reader/` | reads a vault's contents straight from Solana and computes backing per token |
| `src/curve/` | the bonding-curve configuration and the reasoning behind each parameter |
| `web/` | the proof page — market cap vs backing, and every card with its certificate |
| `docs/` | architecture, the curve spec, the vault API, and the honesty notes for every number |

**Everything here only reads the chain.** Nothing in this repository signs a transaction
or needs a secret, so you can run it against any vault without trusting us.

Signing — claiming fees, buying cards, delivering a redeemed or purchased card — lives
in Onix's private infrastructure. The vault API (`docs/vault-api.md`) is the boundary
between the two.

## Running it

```bash
npm install
cp config.example.json config.json   # put your own RPC endpoint in it
npm run backing -- <VAULT_WALLET>
```

## Security

This repository is public and is expected to contain **no secrets at all**. A blocking
`pre-commit` hook refuses anything that looks like a private key, an API key or a `.env`
file. Install it once with `bash setup.sh`.

If you believe a secret reached this repository, treat it as compromised and rotate it —
deleting the commit is not enough.

## License

MIT — see [LICENSE](LICENSE).
