# Launch runbook

> Step by step, with the **point of no return marked**. Written 22 September 2026 from the
> SDK's real client surface (`DynamicBondingCurveClient` → `partner` / `pool` / `state`),
> not from memory. Rehearse it once off mainnet; then rewrite any step that surprised you.
>
> Steps that **sign** run on the private side. This document holds no keys and no addresses
> that are not already public.

## 0. Before anyone touches a wallet

- [ ] `npm test` green; `node scripts/abuse-rehearsal.js` against the target server: every attack refused.
- [ ] `node src/curve/dry-run.js <backingUsd> [gradMult] [creatorFeePct]` read out loud: opening cap, graduation cap,
      **USDC needed to graduate**. It is how much real buying has to happen.
- [ ] The server's `.env` holds `VAULT_MASTER_SEED` (generated there by `onixvault/scripts/server-setup.sh`, never
      printed, backed up offline) and the operator key that pays configs and migrations, with ≥ 0.05 SOL.
- [ ] `GET /v1/health` says `keyring: true`.
- [ ] The creator's wallet holds the items, ≥ 0.06 SOL (0.05 goes to custody as gas; the rest pays the deposits and
      the launch) and nothing it would mind showing.
- [ ] `ONIX_VAULT_RESTOCK=1` if the treasury loop should run (fee claim + restock, every 15 min).
- [ ] For a vault machine on Onix.Cards: `GACHA_VAULT_MACHINE_VAULT=<custody>`, `_NAME`, `_PRICE_USD` in the Cards
      `.env`; the price must leave ≥ 8% over the vault's average exit price or the machine pauses itself.

## 1. Rehearsal (off mainnet)

> ✅ **Run on devnet, 1 October 2026** with `npm run rehearse:devnet` (`scripts/rehearse-devnet.js`;
> ephemeral signer, throwaway `tUSDC` quote mint, same `params.js` as the launch).
> config `6FjCPjTYDCdyXnHKbA3XracUdVVXTeeRkLadhdMCCjdq` · base mint
> `6BivYrBcqssdyJqghAUQprr1fUvAyRShvP2zt8UNDsPF` · pool `D8rnDYCQJgjJNfaxrR7mUsffE9wXNcVyVr9eatDWLf38`.
> Read back: start $0.000025 · graduation $0.00035 · 738.14 quote to graduate. Buy 25 → fee 2.0
> partner + 0.5 protocol (the 20% cut, confirmed on chain). Sell 25% of the tokens → partner fee
> 2.4776. `claimPartnerTradingFee` → **+2.477629 at the fee claimer**, pool's partner fee back to 0.
> **Our decoder (`src/reader/pool.js`) matched the SDK's price at all four reads.**
> Surprises worth a line: the public devnet faucet was dry (Helius devnet RPC airdropped 1 SOL);
> `createPool` lives on `client.creator`, not `client.pool`; `state.getPool` returns
> `{ poolState }` and `swapQuote` wants that wrapper; the quote's fields are `outputAmount`,
> `tradingFee`, `protocolFee`. Still to rehearse: test items + reader, redemption burn, vault API.

> ✅ **Vault API run on devnet, 1 October 2026** with `npm run rehearse:vault` (`scripts/rehearse-vault-devnet.js`;
> `server/index.js` → `createServer` in-process — the production code — with a throwaway vault
> wallet and a fixture items reader naming a test NFT minted into that wallet; the integrator is
> the devnet wallet above, paying in `tUSDC`, through `examples/integrator/vaultClient.js`).
> Items → reserve (`paymentTransaction` 608 b64 chars, single unsigned signer = integrator) →
> paid `4AfMWaQn…` → settle → delivered `5WP7yqqM…`. **Verified on the raw transactions, not on
> the app:** payment signers `[integrator]`, memo = reservation id, vault's tUSDC +20; delivery
> signers `[vault]`, test NFT vault 1→0, winner 0→1.
> Surprises worth a line: a Token Metadata NFT **without a Master Edition** is `FungibleAsset` to
> DAS and the delivery refuses it by design (first run: paid, `delivery_failed`, 503 — the state
> was kept, nothing lost; real cards always carry a master edition, which also needs a freeze
> authority on the mint). That run also showed the port had dropped the **simulate-before-sign**
> check the gacha relies on; it is back (`server/index.js`), the rehearsal passed again with it
> (`4bSu3vB4…` → `5QQqjAK3…`), and the operator's path for a `delivery_failed` reservation exists:
> `node scripts/retry-delivery.js` lists them, `… <id>` re-runs the delivery through the same
> path (rehearsed on the stuck one: refused again, honestly, reason and time updated).
> Still to rehearse: the items reader on a real vault wallet, the redemption burn.

Same code, same params, a throwaway quote mint. The goal is not to test the SDK — it is to
find the step where *we* fumble.

- [ ] `client.partner.createConfig(...)` → a config account exists
- [ ] `client.pool.createPool(...)` → a pool exists; **`baseMint` is created by this call**
      (it is a signer: the curve mints the token, it does not accept an existing one)
- [ ] one buy, one sell, and `client.partner.claimPartnerTradingFee(...)` → fees arrive in the
      quote token at `fee_claimer`
- [ ] `client.state` reads the pool back: price, reserves, fees accrued
- [ ] **test items**: a throwaway collection minted with the same attributes a custodian writes
      (value, grade, certificate), registered in the reader as a *test custodian*, in a
      throwaway vault wallet
- [ ] the **reader** (`npm run backing -- <VAULT_WALLET> --mint <BASE_MINT>`) shows per-token
      figures against the rehearsal mint and the test items
- [ ] **redemption**: burn rehearsal tokens worth `price × 1.15`, submit the signature, the
      vault wallet delivers the test item; both signatures listed
- [ ] **vault API**: `GET /items` → `POST /reservations` → pay the rehearsal quote → `settle`
      → the test item is delivered to the winner wallet; an expired reservation is refused
- [ ] write down every command that was actually run, in order. That list replaces §2 below
      if it differs.

> ✅ **LAUNCHED 1 October 2026, 05:23 UTC** (`scripts/launch-mainnet.js --go`, run on the server by the
> vault wallet). Opening lot: 10 cards (index $173 · realisable $153.97). Config `HGQcs4rggC3TMD2Qg1wJ4GbFe5N9oxRrjW4UeV1knZbv`
> (tx `jUEDRkb9…`) · pool **`7nkXnMdJbG4kxXAPc9HGnn5VBn2b1hcWkzxEMSKGptec`** (tx `3YFxCXtz…`) · mint
> **`4WHGpxzPw9o9m3hWhxYhWB4nJDeSfWb17xPwdXuDB2Vp`** (`Veonix` · `$VEONIX`, metadata
> `https://vault.onix.finance/token/veonix.json`). Read back: quote = USDC, fee claimer = vault wallet,
> start price $0.000015397, supply 10,000,000, graduation $3,500 (≈ $607 USDC to graduate), fee 10% flat,
> not migrated. The vault's SOL (0.12) was lent by the Cards operator wallet (`fundVaultSol.js`).
> What the first run taught: the Cards reconcile in production was not passing `VAULT_WALLET`
> (the canary was marked `gone` — fixed and tested before the lot moved); the cheapest card in the
> inventory had no insured value and would not have counted — the lot was picked from the eligible 37.

## 2. Mainnet — the Create door (any vault, including ours)

Since 2 October every vault, Onix's included, is created through the same door the page uses. The
script `scripts/create-vault.js` runs the four steps with a server-side key as the creator; the page
runs them with a wallet. Both end in the same registry row.

```
node scripts/create-vault.js --name "Vault #1" --symbol XYZ --mints <m1,m2,…> [--grad 2.5] [--fee 40]        # dry run: prints the curve
node scripts/create-vault.js … --go                                                                       # does it
```

1. **quote** — what the creator wallet holds that the rules take; the curve it implies (opens at 2×
   realisable, graduates at the multiple). The USDC-to-graduate number is printed here. Say it out loud.
2. **open** — the custody wallet is derived (next free index) and the deposit transactions are built:
   items + 0.05 SOL gas → custody (deliveries, fee claims and the treasury's purchases; Collector Crypt wants ≥ ~0.05 SOL in a
   buyer's wallet), one wallet prompt per transaction. Nothing of Onix is spent.
3. **deposited** — only when the chain shows every item and the gas in custody does Onix create the
   config (**simulated first**; `feeClaimer` = `leftoverReceiver` = custody), read it back until the RPC
   has it, and build the launch (`createPool`, unsigned).
4. **submit / confirm** — the creator signs; the throwaway mint key completes the transaction; the pool
   on chain registers the vault (custody, creator, rules, manifest, image) and it is served at once.

Reversible until step 4: `abandon` returns items and gas to the creator. **Creating the pool is the point
of no return**: the config is fixed, the mint exists, the first outside buy can happen at any moment.

## 2b. Graduation — done by us, in this order

The Meteora keeper does **not** migrate configs like ours (measured 2 October: five minutes, nothing).
When `stats.pool.graduationProgress` reaches 1:

```
node scripts/graduate.js --vault <id>          # dry run: reads the pool and the config, prints the plan
node scripts/graduate.js --vault <id> --go     # four transactions, paid by the operator key (~0.02 SOL)
```

1. `createLocker` — the creator's 50% goes into Jupiter Lock (the escrow is derivable from the pool)
2. `migrateToDammV2` — the USDC and the curve's tokens become a DAMM v2 pool, LP permanently locked
3. `partnerWithdrawMigrationFee` — 30% of the USDC raised lands in the custody wallet (the treasury)
4. `withdrawLeftover` — the 0.1% leftover lands in custody

Out of order, 2 and 4 fail with `NotPermitToDoThisAction`. After this the page shows *Live*: the price
comes from the DAMM pool, Trade routes to the pool, Play opens.

## 2c. Fire every door once, declared as ours

Create · buy on the curve (PartialFill at the end) · graduate · buy on the pool · Play in USDC · Play by
burning · the gacha buys through the API. Every one is a public transaction, each labelled "operator"
on the page. The first full cycle ran on 2 October 2026 with `$OT4` (pool `FY2JcK…`, DAMM `7bAwnt…`,
play `52202e96`, delivery `5Tjw3g…`).

## 3. After launch — the loop

- the creator's 40% of the curve fee is claimed by the creator (`claimCreatorTradingFee`, lock.jup.ag for the vested half)
- **automatic, every 15 min (`ONIX_VAULT_RESTOCK=1`):** the partner's curve fee and the pool's LP fee are claimed into
  custody (Onix's third transferred in the same tx), then the treasury buys the next item that passes the vault's rules.
  By hand, the same code: `node scripts/restock.js --vault <id> [--go | --confirm]`. Custody needs ≥ 0.05 SOL (creation
  sends it) — below that Collector Crypt hands a sponsored transaction the treasury refuses
- abuse rehearsal before any release: `node scripts/abuse-rehearsal.js` (21 attacks through the public routes, nothing signed)
- the page reads custody and the pool every load; there is no cache to go stale silently
- **items leave custody only through Play or the gacha API**, at the published price. There is no third way out.

## 4. If something goes wrong

| symptom | what it means | do |
|---|---|---|
| config created, `state` read does not match `params.js` | wrong parameters | **do not create the pool.** Create a new config. The old one is inert. |
| pool created, first buy fails in Phantom with a red warning | the warning **only reproduces in production** (learned three times) | do not touch the config; investigate the transaction shape, not the parameters |
| a secret reached the public repo | compromised the moment it landed | **rotate the key.** Deleting the commit is not a remedy. |
| anything looks wrong with money or items | unknown | **pause first:** `touch /opt/onixvault/data/PAUSE` (one vault: `PAUSE-<id>`). Value routes answer 503 within 5 s, sweeps and the treasury loop stop, nothing is lost. Diagnose, then `rm` the file. |
| the server is lost | custody wallets derive from the master seed | restore the seed from the operator's offline backup and the DB from `/var/backups/onixvault` |
| the fee claim arrives at the wrong wallet | `fee_claimer` was set wrong | it cannot be changed. This is why §0 asks twice. |

## 5. The rehearsal is not optional

Every irreversible step in §2 was rehearsed in §1 with the same code. If a step in §2 is
being done for the first time on mainnet, the runbook has been skipped, and that is the
moment to stop.
