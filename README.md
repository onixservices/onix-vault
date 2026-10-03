# Onix.Vault

**Auditable vaults for real-world assets on Solana.** Built by [Onix](https://onix.finance). Live at
[vault.onix.finance](https://vault.onix.finance).

An Onix.Vault vault holds real things that a named custodian has already put on chain — tokenized, with
their identity and value written into the token by the custodian, and with a way to get the physical item
back. A creator puts items into a wallet derived for that vault and gets a token on a [Meteora](https://meteora.ag)
Dynamic Bonding Curve. From there:

| | what happens | backing per token |
|---|---|---|
| **Create** | the creator's items go into custody; a token launches; the creator keeps **50%** (locked, released over 6 months from graduation) and earns **40% of every trade fee** on chain | set |
| **Trade** | 10% fee on the curve: 2% Meteora · 3.2% creator · 3.2% the vault's treasury · 1.6% Onix; the first 60 s charge 99%→10% so bots cannot front-run. At graduation the token moves to a DAMM v2 pool (liquidity locked for good) and **30% of the USDC raised goes to the vault** | rises |
| **Play** | opens at graduation. One item from a band is drawn — provably — and sent from custody. Pay **USDC** (the band's average × 1.15; the money stays in the vault and buys the next item) or **burn the token** (average × 1.10 in *share of backing*, never at the market price) | rises |
| **Integrate** | any gacha buys an item at the published price through the API; Onix.Cards' gacha is the first | rises |

Nothing leaves custody except through Play or the API, at the same price for the creator and for a
stranger. Anyone can verify what is inside a vault without asking us for anything. That is the point.

The mechanism does not care what the asset is. It cares about three things: possession is provable on
chain, the custodian publishes identity and value in the token, and the custodian offers a way to redeem
the physical item. **Vault #1 holds graded trading cards** because that is where custody is most mature
today (Collector Crypt writes insured value, grader, certificate and the vault's street address into every
token). Wine, watches or comics enter the day their custodian meets the same three conditions. Liquid RWAs
(tokenized stocks) do not need this: they redeem at NAV by design. This is for the illiquid kind.

> **Proven on mainnet, 2 October 2026.** A vault created through the door by a third-party wallet (`$OT4`),
> bought to graduation, migrated by our script, a Play paid in USDC and the card delivered from custody —
> the draw recomputed outside the server from the published proof.

---

## Two numbers, never added

A vault page shows **market cap** (price × supply — what the market says) and **backing** (the items in
custody — what we can prove) side by side. They are different things. The interesting figure is the ratio.

Item values come from the custodian's own on-chain `Insured Value` attribute. That is an index, not a sale
price: the measured median the market actually pays is **0.89×** of it. Both numbers are shown, always
labelled, always with their age.

Anyone who prefers their own RPC can run `web/verify.html` with their own endpoint, or the CLI reader
(`npm run backing`): same decoder, same numbers.

---

## What is in this repository

| | |
|---|---|
| `src/reader/` | reads a custody wallet straight from Solana and computes backing per token |
| `src/curve/` | the bonding-curve configuration (`DECIDED`), the fee split, and the reasoning behind each parameter |
| `server/` | the vault server: the API (`/v1/vaults/{vault}/…`), creation with custody by derivation, the trade door (curve, then pool), Play, the delivery that signs with the custody key, uploads, rate limits. `server/openapi.json` is the contract |
| `web/` | the app: the board, each vault's mini-site (Trade · Play · Items · Activity · Proof), create a vault, integrate. Static; reads only `/v1` |
| `scripts/` | `create-vault.js` (the four steps with a server-side creator), `graduate.js` (locker → migrate → fee → leftover), `return-item.js` / `return-usdc.js` / `return-sol.js`, `claim-fees.js` |
| `examples/integrator/` | a complete client of the API — the one Onix.Cards' gacha runs |
| `docs/` | architecture, threat model, the curve spec, the API, the runbook, the business model |

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
deleting the commit is not enough. The threat model is in `docs/threat-model.md`.

## License

MIT — see [LICENSE](LICENSE).
