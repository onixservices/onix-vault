# Onix.Vault

**Your collection. A business in minutes.**

Auditable vaults for real-world assets on Solana. Built by [Onix](https://onix.finance). Live at
[vault.onix.finance](https://vault.onix.finance).

Anyone who holds real graded cards on chain can launch a vault in three steps and get, in minutes: a token on a Meteora
bonding curve (half of it theirs), 40% of the curve's trading fee paid by the program, a provably fair gacha, a shop on
every gacha site through the public API (Onix.Cards first), and a treasury that restocks itself. Buyers back the
collections they believe in: a share of real items that sells in seconds and grows with every door.

An Onix.Vault vault holds real things that a named custodian has already put on chain — tokenized, with
their identity and value written into the token by the custodian, and with a way to get the physical item
back. A creator puts items into a wallet derived for that vault and gets a token on a [Meteora](https://meteora.ag)
Dynamic Bonding Curve. From there:

| | what happens | backing per token |
|---|---|---|
| **Create** | the creator's items go into custody; a token launches; the creator keeps **50%** (locked, released over 6 months from graduation) and earns **40% of the trading fee on the curve**, paid by the program | set |
| **Trade** | 10% fee on the curve: 2% Meteora · 3.2% creator · 3.2% the vault's treasury · 1.6% Onix; the first 60 s charge 99%→10% so bots cannot front-run. At graduation the token moves to a DAMM v2 pool (liquidity locked for good) and **30% of the USDC raised goes to the vault** | rises |
| **Play** | opens at graduation. One item from a band is drawn — provably — and sent from custody. Pay **USDC** (the band's average × 1.15; the money stays in the vault and buys the next item) or **burn the token** (average × 1.10 in *share of backing*, never at the market price) | rises |
| **Integrate** | any gacha buys an item at the published price through the API; Onix.Cards' **Onix.Vault** machine sells the cards of every graduated vault, paying each vault for its own card | rises |

Nothing leaves custody except through Play or the API, at the same price for the creator and for a
stranger. Anyone can verify what is inside a vault without asking us for anything. That is the point.

**The treasury runs itself.** Every 15 minutes the server claims the trading fees into custody (the curve's partner fee
— Onix's third split off in the same transaction — and the graduated pool's LP fee), then buys the next graded card that
passes the vault's rules, at or below the custodian's index (`server/feeclaim.js`, `server/restock.js`). A curve that
fills graduates by itself within a minute: the server opens the creator's lock, migrates the pool to DAMM v2 and moves
30% of the raise into custody (`server/graduation.js`). Every claim, purchase and graduation is a public transaction on
the vault's Activity tab.

The mechanism does not care what the asset is. It cares about three things: possession is provable on
chain, the custodian publishes identity and value in the token, and the custodian offers a way to redeem
the physical item. **The first vaults hold graded trading cards** because that is where custody is most mature
today (Collector Crypt writes insured value, grader, certificate and the vault's street address into every
token). Wine, watches or comics enter the day their custodian meets the same three conditions. Liquid RWAs
(tokenized stocks) do not need this: they redeem at NAV by design. This is for the illiquid kind.

> **Proven on mainnet, October 2026.** Two vaults are live at [vault.onix.finance](https://vault.onix.finance), both created
> through the page by a wallet that is not the operator's. **`$OCC`** (3 October; custody `FJY9e8KkXtTATEdivpnJwpm8tavYCYpvta1hZb7JfFMX`,
> mint `2PQ4T4cqh4aWHpAQN7wDRpVbYA8yGvxYypF5v3aDPQ5N`, DAMM v2 pool `BffuP3jwtXstCEjB3UwVjD2R21LVBYFc1MSbFpLbJXKT`): graduated, traded on
> its pool from the page, its treasury **bought a card by itself** ($13 for a $16 index), that card was won on Onix.Cards'
> vault machine and paid to the vault through the public API, and the fees were claimed into the treasury automatically.
> **`$VOLT`** (9 October; custody `4uC7H5NPKicQiAi5rcn6g4Bzb1VVLVnF6uttfWd1jp9T`, mint `CtTzeJ6jR8Qtd71rDmhbK5x6m5Jv876NybeM6U3rixnP`,
> DAMM v2 pool `LFVoEkghV8tYKaGJx97WPri5anMLU4t4kGSPRC8zMvM`): the curve filled and **the server graduated it by itself** within a
> minute, a Play was paid in USDC and the card delivered from custody, a pull on Onix.Cards' vault machine paid `$OCC`
> $38 through the API (and that vault bought its next card fourteen minutes later), and overnight the `$VOLT` treasury
> bought three more cards on its own, one an hour, each at or under its index. Every step is on each vault's Activity
> tab, with its signature.

---

## Two numbers, never added

A vault page shows **market cap** (price × supply — what the market says) and **backing** (the items in
custody — what we can prove) side by side. They are different things. The interesting figure is the ratio.

Item values come from the custodian's own on-chain `Insured Value` attribute. That is an index, not a sale
price: the measured median the market actually pays is **0.89×** of it. Both numbers are shown, always
labelled, always with their age.

Anyone who prefers their own RPC can run the CLI reader (`npm run backing -- <custody wallet>`) against their own
endpoint: same decoder, same numbers.

---

## What is in this repository

| | |
|---|---|
| `src/reader/` | reads a custody wallet straight from Solana and computes backing per token |
| `src/curve/` | the bonding-curve configuration, the fee split, and the reasoning behind each parameter |
| `server/` | the vault server: the API (`/v1/vaults/{vault}/…`), creation with custody by derivation, the trade door (curve, then pool), Play, the delivery that signs with the custody key, uploads, rate limits. `server/openapi.json` is the contract |
| `web/` | the app: the board, each vault's mini-site (Trade · Play · Items · Activity · Proof), create a vault, integrate. Static; reads only `/v1` |
| `scripts/` | `create-vault.js` (the four steps with a server-side creator), `graduate.js` (locker → migrate → fee → leftover), `restock.js` (the treasury loop by hand), `abuse-rehearsal.js` (24 refusals through the public routes, run against production), `return-item.js` / `return-usdc.js` / `return-sol.js` |
| `examples/integrator/` | a complete client of the API — the one Onix.Cards' gacha runs |
| `docs/` | architecture, **security review**, threat model, the curve spec, the API, the runbook, the business model |

**The code is public; the keys are not.** The master seed every custody wallet derives from and the
operator key exist only in the server's `.env`, generated there, never committed (allowlist `.gitignore`,
a pre-commit hook that refuses keys, GitHub push protection). Run the server with your own and it is
your platform.

## Running it

```bash
npm install
npm test                               # node:test
npm run backing -- <CUSTODY_WALLET>    # the reader, from the command line
npm run server                         # the API + the page on :3004 (see server/env.example)
```

## Security

This repository is public and is expected to contain **no secrets at all**. A blocking `pre-commit` hook
refuses anything that looks like a private key, an API key or a `.env` file. Install it once with
`bash setup.sh`. If you believe a secret reached this repository, treat it as compromised and rotate it —
deleting the commit is not enough. The threat model is in `docs/threat-model.md`; the security review — every finding with its
fix commit and a regression test that fails on the code before it — is in `docs/security-review.md`. The operator can stop
every route that moves value with a file (`data/PAUSE`, or `data/PAUSE-<vault>`); nothing is lost while paused.

## License

MIT — see [LICENSE](LICENSE).
