# Launch runbook — Vaulty #1

> Step by step, with the **point of no return marked**. Written 22 September 2026 from the
> SDK's real client surface (`DynamicBondingCurveClient` → `partner` / `pool` / `state`),
> not from memory. Rehearse it once off mainnet; then rewrite any step that surprised you.
>
> Steps that **sign** run on the private side. This document holds no keys and no addresses
> that are not already public.

## 0. Before anyone touches a wallet

- [ ] Every `PENDING` in `src/curve/params.js` has been replaced by a decision, and
      `npm run curve:dry-run` prints **no** "PENDING placeholder" lines.
- [ ] The dry run says `program validation OK`.
- [ ] Read back and sanity-check: start price, price at graduation, **USDC needed to
      graduate**. Say the last number out loud. It is how much real buying has to happen.
- [ ] `docs/curve-config.md` matches `params.js` exactly (a reviewer diffed them).
- [ ] The **vault wallet** exists, is empty of everything except its purpose, and its address
      is written down where the page will read it.
- [ ] Decided which wallet is **`fee_claimer`** (receives the trading fees — the whole
      mechanism), which is **`leftover_receiver`** (only matters if `leftover > 0`; ours is 0,
      but the program rejects a zero key), and which is **`payer`**.
- [ ] The stock split is done by the rule: **what the machines' targets need stays in the
      gacha; the rest is admitted.** Nobody picked by hand. The list is saved.

## 1. Rehearsal (off mainnet)

Same code, same params, a throwaway quote mint. The goal is not to test the SDK — it is to
find the step where *we* fumble.

- [ ] `client.partner.createConfig(...)` → a config account exists
- [ ] `client.pool.createPool(...)` → a pool exists; **`baseMint` is created by this call**
      (it is a signer: the curve mints the token, it does not accept an existing one)
- [ ] one buy, one sell, and `client.partner.claimPartnerTradingFee(...)` → fees arrive in the
      quote token at `fee_claimer`
- [ ] `client.state` reads the pool back: price, reserves, fees accrued
- [ ] the **reader** (`npm run backing -- <VAULT_WALLET> --mint <BASE_MINT>`) shows per-token
      figures against the rehearsal mint
- [ ] write down every command that was actually run, in order. That list replaces §2 below
      if it differs.

## 2. Mainnet — in this order

Reversible until the line. Irreversible after it.

### Still reversible

1. **Create the config.** `partner.createConfig` with the built parameters,
   `quote_mint = USDC`, `fee_claimer` = the decided wallet. A config with no pool can be
   ignored forever; creating it commits nothing.
2. **Read the config back** (`state`) and diff it against `params.js`. Every field.
3. **Admit the cards into the vault wallet.** Transfers we control, to a wallet we control.
   Reversible while nobody else holds anything.
4. **Run the reader against the real vault wallet.** The number it prints is the number the
   page will show on day one. If it is not the number you expected, stop here.

### ━━━━━━━━━━━━━━━━━━ POINT OF NO RETURN ━━━━━━━━━━━━━━━━━━

> **Creating the pool mints the token and opens the curve to the public.** From this instant,
> the config (fee, quote, curve, migration) is fixed, the mint exists, and the first outside
> buy can happen at any moment. Everything above can be undone. Nothing below can.
>
> Before crossing: re-read §0. Then say the USDC-to-graduate number out loud once more.

5. **Create the pool.** `pool.createPool` (or `createPoolWithFirstBuy` if we make the first
   buy ourselves — **if we do, it is declared on the page as ours**, never presented as
   demand). The transaction that does this is the one recorded for the video.
6. **Publish the addresses**: config, pool, base mint, vault wallet, fee claimer. On the page
   and in the README. The reader is now pointed at the real mint (`--mint`).
7. **Claim the first fee** as soon as there is one, and **buy the first card with it** through
   the existing agent. Record that transaction. It is the proof the whole submission rests on.

## 3. After launch — the loop

- fees are claimed on a schedule and split **50 / 30 / 20 of what reaches us** (after the
  protocol's 20% — see `src/curve/split.js`); each leg's transactions are public
- the page reads the vault and the pool every load; there is no cache to go stale silently
- **nothing leaves the vault wallet.** Ever. Its only outgoing path, if one is ever built, is
  a card sold to fund a buyback, and that is announced before it happens

## 4. If something goes wrong

| symptom | what it means | do |
|---|---|---|
| config created, `state` read does not match `params.js` | wrong parameters | **do not create the pool.** Create a new config. The old one is inert. |
| pool created, first buy fails in Phantom with a red warning | the warning **only reproduces in production** (learned three times) | do not touch the config; investigate the transaction shape, not the parameters |
| a secret reached the public repo | compromised the moment it landed | **rotate the key.** Deleting the commit is not a remedy. |
| the fee claim arrives at the wrong wallet | `fee_claimer` was set wrong | it cannot be changed. This is why §0 asks twice. |

## 5. The rehearsal is not optional

Every irreversible step in §2 was rehearsed in §1 with the same code. If a step in §2 is
being done for the first time on mainnet, the runbook has been skipped, and that is the
moment to stop.
