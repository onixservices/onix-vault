# Onix.Vault

**Auditable vaults for real-world assets on Solana.** Built by [Onix](https://onix.finance).

An Onix.Vault vault holds real things that a named custodian has already put on chain —
tokenized, with their identity and value written into the token by the custodian, and with a
way to get the physical item back. Its token launches on a [Meteora](https://meteora.ag)
Dynamic Bonding Curve. The vault has **four doors**, each with a published rule:

| door | what happens | backing per token |
|---|---|---|
| **Admission** | an item goes in → tokens for **80%** of its realisable value, vested | rises |
| **Redemption** | burn tokens worth `max(custodian value, market) × 1.15` → that item is yours; the 15% stays in the vault | rises |
| **Gacha** | any gacha buys an item from the vault at `max(custodian value, market)` — above what the market pays | rises |
| **Fees** | 10% of every curve trade: 50% buys another item · 30% buys the token back · 20% operator | rises |

The vault never runs a draw and never picks what leaves. Anyone can verify what is inside
a vault without asking us for anything. That is the point.

The mechanism does not care what the asset is. It cares about three things: possession is
provable on chain, the custodian publishes identity and value in the token, and the custodian
offers a way to redeem the physical item. **Vault #1 holds graded trading cards** because
that is where custody is most mature today (Collector Crypt writes insured value, grader,
certificate and the vault's street address into every token). Wine, watches or fossils enter
the day their custodian meets the same three conditions. Liquid RWAs (tokenized stocks) do not
need this: they redeem at NAV by design. This is for the illiquid kind.

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
> works — and, with no redemption, trades at 0.80–0.95× of its reserve. Onix.Vault is the
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
