# Launch runbook

> Step by step, with the **point of no return marked**. Steps that **sign** run on the private side. This document holds
> no keys and no addresses that are not already public.

## 0. Before anyone touches a wallet

1. `npm test` green; `node scripts/abuse-rehearsal.js --base <server>` against the target server: every attack refused
   (24 of 24, nothing signed).
2. `node src/curve/dry-run.js <backingUsd> [gradMult] [creatorFeePct]`, read out loud: opening cap, graduation cap,
   **USDC needed to graduate**. It is how much real buying has to happen.
3. The server's `.env` holds `VAULT_MASTER_SEED` (generated there, never printed, backed up offline) and
   `VAULT_SECRET_KEY`, the operator key that pays configs and migrations, with ≥ 0.05 SOL. `GET /v1/health` says
   `keyring: true`.
4. The creator's wallet holds the items, **≥ 0.12 SOL** (0.08 goes to custody as gas for deliveries, fee claims and the
   treasury's purchases; the rest pays the deposits and the launch) and nothing it would mind showing.
5. `ONIX_VAULT_GRADUATE=1` so a full curve graduates by itself; `ONIX_VAULT_RESTOCK=1` if the treasury should buy;
   `ONIX_VAULT_SALE_COMMISSION=1` if the custody should pay the creator's 5% and Onix's 2% of every sale. Either of the
   last two runs the 15-minute round (fee claim, payout, restock); the ledger of sales is kept regardless.
6. For a vault machine on Onix.Cards: the machine's price must leave ≥ 8% over the vault's average exit price, or the
   machine pauses itself.

## 1. Rehearsal, off mainnet

Same code, same `params.js`, a throwaway quote mint. The goal is not to test the SDK; it is to find the step where *we*
fumble.

```
npm run rehearse:devnet      # scripts/rehearse-devnet.js: config → pool → buy → sell → claim the partner fee
npm run rehearse:vault       # scripts/rehearse-vault-devnet.js: the vault API in-process, a test NFT, the integrator client
```

What to read back from the first: the config account exists; `createPool` created the base mint (it is a signer: the
curve mints the token, it does not accept an existing one); one buy and one sell; `claimPartnerTradingFee` lands the
partner fee in the quote token at the fee claimer; `state.getPool` reads price, reserves and fees accrued; **our decoder
(`src/reader/pool.js`) matches the SDK's price at every read**. From the second: items → reserve (`paymentTransaction`
unsigned, single signer = integrator) → pay → settle → the test NFT delivered to the winner; an expired reservation
refused. **Verify on the raw transactions, not on the app:** payment signers, memo, the vault's quote balance; delivery
signers and the NFT's owner before and after.

Known surprises, so they do not cost an hour again:

- the public devnet faucet is often dry; Helius devnet airdrops;
- `createPool` lives on `client.creator`, not `client.pool`; `state.getPool` returns `{ poolState }` and `swapQuote` wants
  that wrapper; the quote's fields are `outputAmount`, `tradingFee`, `protocolFee`;
- a Token Metadata NFT **without a Master Edition** is `FungibleAsset` to DAS and the delivery refuses it by design
  (real cards always carry a master edition);
- a paid reservation whose delivery failed is `delivery_failed` with the state kept; `node scripts/retry-delivery.js`
  lists them and `… <id>` re-runs the delivery through the same path.

Write down every command that was actually run, in order. That list replaces §2 if it differs.

## 2. Mainnet: the Create door (any vault, including ours)

Every vault, Onix's included, is created through the same door the page uses. The script `scripts/create-vault.js`
runs the four steps with a server-side key as the creator; the page runs them with a wallet. Both end in the same
registry row.

```
node scripts/create-vault.js --name "My Cards" --symbol MYC --mints <m1,m2,…> [--grad 2.5] [--fee 40]   # dry run: prints the curve
node scripts/create-vault.js … --go                                                                   # does it
```

1. **quote**: what the creator wallet holds that the rules take; the curve it implies (opens at 2× realisable, graduates at
   the multiple). The USDC-to-graduate number is printed here. Say it out loud.
2. **open**: the custody wallet is derived (next free index) and the deposit transactions are built: items + 0.08 SOL gas →
   custody, one wallet prompt per transaction. Nothing of Onix is spent.
3. **deposited**: only when the chain shows every item and the gas in custody does Onix create the config (**simulated
   first**; `feeClaimer` = `leftoverReceiver` = custody), read it back until the RPC has it, and build the launch
   (`createPool`, unsigned).
4. **submit / confirm**: the creator signs; the throwaway mint key completes the transaction; the pool on chain registers
   the vault (custody, creator, rules, manifest, image) and it is served at once.

Reversible until step 4: `abandon` returns items and gas to the creator. **Creating the pool is the point of no
return**: the config is fixed, the mint exists, the first outside buy can happen at any moment.

## 2b. Graduation: the server does it; the script is the manual way

The Meteora keeper does **not** migrate configs like ours. With `ONIX_VAULT_GRADUATE=1` the server reads every live curve
once a minute (`server/graduation.js`) and, when the USDC in the reserve reaches the config's threshold, runs the four
steps below, each one simulated before it is signed, once per vault (`vault_graduations`, shown on the vault's Activity
tab as `Graduated`). A run that fails keeps the step and the reason, is retried after 10 minutes up to five times, then
waits for you. There is no public trigger: only a full curve starts it. By hand, when `stats.pool.graduationProgress`
reaches 1:

```
node scripts/graduate.js --vault <id>          # dry run: reads the pool and the config, prints the plan
node scripts/graduate.js --vault <id> --go     # four transactions, paid by the operator key (~0.02 SOL)
```

1. `createLocker`: the creator's 50% goes into Jupiter Lock (the escrow is derivable from the pool)
2. `migrateToDammV2`: the USDC and the curve's tokens become a DAMM v2 pool, LP permanently locked
3. `partnerWithdrawMigrationFee`: 30% of the USDC raised lands in the custody wallet (the treasury)
4. `withdrawLeftover`: the 0.1% leftover lands in custody

Out of order, 2 and 4 fail with `NotPermitToDoThisAction`. After this the page shows *Live*: the price comes from the
DAMM pool, Trade routes to the pool, Play opens.

## 2c. Fire every door once, declared as ours

Create · buy on the curve (PartialFill at the end) · graduate · buy on the pool · Play in USDC · Play by burning · the
gacha buys through the API. Every one is a public transaction, each labelled "operator" on the page when the operator
is the one acting.

## 3. After launch: the loop

- the creator's 40% of the curve fee is claimed by the creator (`claimCreatorTradingFee`; lock.jup.ag for the vested half)
- **automatic, every 15 min (`ONIX_VAULT_RESTOCK=1` or `ONIX_VAULT_SALE_COMMISSION=1`):** the partner's curve fee and the
  pool's LP fee are claimed into custody (Onix's third transferred in the same tx) and the sales owed are paid in that
  transaction (5% creator, 2% Onix), then the treasury buys the next item that passes the vault's rules. By hand, the same
  code: `node scripts/payout.js --vault <id> [--go [--pay] | --confirm | --ledger]` and `node scripts/restock.js --vault <id> [--go | --confirm]`. Custody needs ≥ 0.05 SOL in the
  buyer's wallet (creation sends 0.08); below that Collector Crypt hands a sponsored transaction the treasury refuses
- abuse rehearsal before any release: `node scripts/abuse-rehearsal.js --base <url>` (24 refusals through the public routes, nothing signed)
- the page reads custody and the pool every load; there is no cache to go stale silently
- **items leave custody through Play or the gacha API**, at the published price; the only other way out is the operator's
  `scripts/return-item.js`, signed by the same key and public like everything else.

## 4. If something goes wrong

| symptom | what it means | do |
|---|---|---|
| config created, `state` read does not match `params.js` | wrong parameters | **do not create the pool.** Create a new config. The old one is inert. |
| pool created, first buy fails in Phantom with a red warning | the warning **only reproduces in production** (learned three times) | do not touch the config; investigate the transaction shape, not the parameters |
| a secret reached the public repo | compromised the moment it landed | **rotate the key.** Deleting the commit is not a remedy. |
| anything looks wrong with money or items | unknown | **pause first:** `touch data/PAUSE` (one vault: `PAUSE-<id>`). Value routes answer 503 within 5 s, sweeps and the treasury loop stop, nothing is lost. Diagnose, then `rm` the file. |
| the server is lost | custody wallets derive from the master seed | restore the seed from the operator's offline backup and the database from the daily backup |
| the fee claim arrives at the wrong wallet | `fee_claimer` was set wrong | it cannot be changed. This is why §0 asks twice. |

## 5. The rehearsal is not optional

Every irreversible step in §2 was rehearsed in §1 with the same code. If a step in §2 is being done for the first time
on mainnet, the runbook has been skipped, and that is the moment to stop.
