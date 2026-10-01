# The bonding curve configuration

> Every parameter of Vault #1's Meteora DBC config, and **why that value and not another**.
> Written 21 September 2026, before the config exists, because **a DBC config is effectively
> irreversible once a pool is open** — changing it means launching a different token.
>
> Grounded in the `@meteora-ag/dynamic-bonding-curve-sdk` parameter reference. Values marked
> **TO VERIFY** have not yet been confirmed against the program on mainnet and **must not be
> treated as settled**.

## How the curve is expressed

The SDK offers several builders. We use **`buildCurveWithMarketCap`**, which takes an
`initialMarketCap` and a `migrationMarketCap` and derives `sqrtStartPrice` and the `curve`
array for us.

This matters beyond convenience: it means **every number in this document is one a human can
argue about**. Nobody has to audit our square-root arithmetic to check our reasoning — they
check two market caps and a supply.

---

## Decided

### Token

| parameter | value | why |
|---|---|---|
| `tokenType` | `0` — SPL | No extensions needed. Token-2022 with transfer hooks would require Meteora's TokenBadge, which is admin-granted. SPL is permissionless. |
| `tokenBaseDecimal` | `6` | Matches USDC. Backing per token is a number a person reads off the page; 9 decimals adds noise to a figure meant to be compared by eye. |
| `tokenQuoteDecimal` | `6` | USDC. |
| `tokenAuthorityOption` | **Immutable** | We never need to rewrite the token's metadata, and an immutable token removes an entire class of "what could the team do to this" questions. The cost of keeping the authority is higher than any use we have for it. |

### Fees

| parameter | value | why |
|---|---|---|
| `collectFeeMode` | `0` — **QuoteToken** | **The load-bearing choice.** Fees arrive in USDC, the currency cards are bought in. Collecting in the output token would mean holding our own token and selling it to buy cards — a worse look and a worse mechanism. |
| `baseFeeParams` | flat **1000 bps (10%)** — fee scheduler with `startingFeeBps = endingFeeBps = 1000` | The fee *is* the product. It is what fills the vault. A scheduler that decays would mean the vault grows fastest when nobody is trading and slowest when they are. ✅ **Verified in the program source** (`constants.rs`): `MIN_FEE_BPS = 25`, `MAX_FEE_BPS = 9900`. 10% is well inside. ⚠️ **`RateLimiter` mode is deprecated** in the program (`DeprecatedBaseFeeMode`) — use the scheduler. |
| `dynamicFeeEnabled` | `false` | We publish "10% of every trade". A dynamic fee makes that sentence untrue on a volatile day. A predictable number we can print beats a marginally better one we would have to qualify. |
| `enableFirstSwapWithMinFee` | `false` | No reason to give the first buyer a discount the page does not explain. |
| `creatorTradingFeePercentage` | **TO DECIDE** | We are both the partner (config creator) and the token creator, so this splits our own fee between two wallets we control. Set deliberately rather than by default, and record which wallet is which. |

### 🔴 The protocol's cut — verified in the program, and it changes what the page says

`state/config.rs::get_fee_on_amount`: **`protocol_fee = trading_fee × 20%`**, taken *before*
anything reaches the partner or creator (`PROTOCOL_FEE_PERCENT = 20`). A referral, if any,
is paid out of the protocol's share, not ours.

So with a 10% trade fee: **2% of every trade goes to Meteora, 8% reaches us**, and the
published 50 / 30 / 20 split applies to that 8%:

```
trade ─ 10% fee ─┬─ 2%  Meteora (protocol take, fixed by the program)
                 └─ 8%  ─┬─ 4.0%  buys a card
                         ├─ 2.4%  buys back the token
                         └─ 1.6%  operator
```

The page must show the protocol's cut. "10% of every trade buys cards" would be a lie by
omission; "4% of every trade buys cards" is the true sentence.

### Migration

| parameter | value | why |
|---|---|---|
| `migrationOption` | `1` — **DAMM V2** | Our own census of the chain: pools that came from a DBC curve are **14.5% of DAMM v2 pools but 76% of its fees**. It is where the trading actually lands, and its API already exposes TVL, volume and permanent-lock, which the proof page can read. |
| `migrationFee.feePercentage` | **TO DECIDE** — ✅ verified max `99` (`MAX_MIGRATION_FEE_PERCENTAGE`) | Taken out of the migrating liquidity. Every point here is a point less depth in the graduated pool. |
| `migratedPoolFee.poolFeeBps` | **TO DECIDE** — ✅ verified range `10–1000` bps (0.1%–10%) | The fee the *graduated* pool charges. It keeps feeding the vault after migration, so it should not be an afterthought. |

---

## Needs a number, and the trade-off is real

### `initialMarketCap`

The vault opens with **all 37 cards** Onix holds — roughly **$1,600 of insured value, ≈$1,420
realisable** (decided 30 September 2026). Nothing stays outside: the gacha buys from the vault
at the published price, so it no longer needs a stock of its own.

Setting the initial market cap **near that number** starts the ratio at about **1.0×**, and
the page's opening sentence becomes true and simple: *this token is worth about what is in the
box, and the box only grows.*

- **Much lower** and the token launches visibly below its own backing, which invites a question
  we would rather answer with a mechanism than a paragraph.
- **Much higher** and early buyers pay a premium for a promise rather than for cards.

**Proposal: ≈ $900–1,000.** It is the only value that makes the ratio mean what we say it means.

### `migrationMarketCap`

The graduation threshold, and a genuine tension:

| lower (e.g. $5–10k) | higher (e.g. $30k+) |
|---|---|
| graduation is plausible inside the hackathon window | graduation means real trading happened |
| gives judges a visible milestone and a DAMM v2 pool to inspect | thin graduation looks like theatre |
| **unlocks vesting** — see the finding below | may never happen, and then nothing unlocks |

For reference, **Meteora's own StockLaunch graduates at $750** equivalent, so a low threshold
is not unusual in this ecosystem.

### `totalTokenSupply`, `percentageSupplyOnMigration`, `leftover`

Follow from the two market caps above and from how much of the supply the seed admission takes.
**Derive, do not guess** — and re-check that the seed allocation is not an implausible share of
the float once the numbers are chosen.

---

## 🔴 Finding that changes the admission design

`lockedVesting` has a field named **`cliffDurationFromMigrationTime`**, and the whole vesting
schedule is anchored to **migration**, not to launch.

**Consequence:** if the pool never graduates, the DBC's own vesting never starts. A seed
allocation "with vesting" through this parameter is only vested *after* graduation — before
that it is governed by whatever else holds it.

This matters because vesting is not decoration here: it is what stops whoever seeded the vault
from selling into the people who bought after them, and it is a thing judges and buyers look
for specifically.

**Options, none of them decided:**

1. **Set `migrationMarketCap` low enough that graduation is realistic**, so the DBC vesting
   actually engages.
2. **Hold the seed allocation somewhere that does not depend on migration**, and say exactly
   where and under what terms.
3. **Do not take a seed allocation at the launch at all** — admit the operator's cards after the
   curve is running, at the same published rule as anyone else.

Option 3 is the cleanest story and the weakest one for the operator's economics.

### ✅ Decided 30 September 2026 — each lock where it belongs

- **Admission tokens** (what the operator — or anyone — receives for a card that goes into
  the vault) are **never** held by the DBC's `lockedVesting`. Their meaning does not depend on
  graduation, so they must not depend on it either. They go into a **time-based lock**
  (Jupiter Lock, 12 months proposed), unlocking on a date whether or not the pool migrates.
  If the pool never graduates, the operator still holds its tokens, the cards stay in the vault,
  and the redemption door is open to it on the same terms as anyone.
- **`lockedVesting` is used for the allocation whose meaning *is* graduation**: the operator's
  post-migration share (creator liquidity / leftover). If the pool graduates, it vests over time;
  if it does not, it does not exist. That is what the field is for.
- **`migrationMarketCap` is set for plausibility, not as a condition** (see above): around
  3–4× the opening backing, so the market cap ÷ backing ratio stays legible during the curve
  (at $10k it would read ~10× on a ~$1k vault).

Using the DBC's vesting for admission would have been the wrong tool for the job, and anyone
who wrote the program would see it. Depth of integration is each feature in the place it was
designed for, not every field filled in.

---

## Before anything is created on mainnet

- [x] ~~confirm the program's maximum base fee~~ — `25..9900` bps, verified in `constants.rs`
- [ ] **lock/vesting durations are capped at 2 years** (`MAX_LOCK_DURATION_IN_SECONDS`) — keep the vesting schedule inside that
- [ ] the curve has at most **16 points** (`MAX_CURVE_POINT`) — `buildCurveWithMarketCap` stays well under
- [ ] confirm `migrationQuoteThreshold` units and how it relates to `migrationMarketCap`
- [ ] run `buildCurveWithMarketCap` with the chosen numbers and **read back the derived
      `sqrtStartPrice` and `curve` array**, then sanity-check the implied price at both ends
- [ ] rehearse the full creation off mainnet, and write the runbook from the rehearsal rather
      than from this document
- [ ] confirm which wallet is partner and which is creator, and that the **fee claimer is the
      wallet we intend** — the fee is the entire mechanism, and it goes wherever this points
