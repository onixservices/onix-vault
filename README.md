# Vaulty

**Auditable, card-backed vaults on Solana.** Built by [Onix](https://onix.finance).

A Vaulty vault holds real graded trading cards that are already tokenized and held by a
named custodian. Its token launches on a [Meteora](https://meteora.ag) Dynamic Bonding
Curve, and a published share of every trade buys **more cards** into the vault.

Anyone can verify what is inside a vault without asking us for anything. That is the point.

```
curve trade → 10% fee → 50% buys a card · 30% buys back the token · 20% operator
```

---

## Vault #1

The first vault is seeded with Onix's own inventory of graded Pokémon and One Piece
cards, held in OmniVault, PWCC and PSA Vault. **Vault #1 is operated by Onix.**

> **The cards are in this wallet. They give no redemption right.
> What they do is come back as buybacks.**

There is no redemption. Value returns to holders through buybacks, and backing per token
grows as fees buy more cards.

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
| `docs/` | architecture, the curve spec, and the honesty notes for every number |

**Everything here only reads the chain.** Nothing in this repository signs a transaction
or needs a secret, so you can run it against any vault without trusting us.

Signing — claiming fees, buying cards — lives in Onix's private infrastructure.

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
