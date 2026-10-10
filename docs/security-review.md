# Security review — Onix.Vault server

**Date:** 4 October 2026 · **Scope:** this repository (`server/`, `src/reader/`, `web/`, `scripts/`), the server it runs on, and Onix.Cards as the first integrator of the vault API · **Suite:** 237 tests, all green (`npm test`)

This is an internal review, written so an external auditor can start from it. Every finding below was read in the code, given a regression test that **fails on the code before the fix and passes after**, then fixed. The fix commit and the test are listed for each finding. Nothing here replaces an external audit; it is what that audit should find already done.

## What the server holds and what it signs

| key | where it lives | what it signs |
|---|---|---|
| `VAULT_MASTER_SEED` (32 bytes) | `.env` on the server (640, root:onixvault), generated there, never printed | every created vault's custody wallet, derived per vault (SLIP-0010, `m/44'/501'/<index>'/0'`); the draw key (`keyring.drawKey`) |
| `VAULT_SECRET_KEY` (Onix operator) | same `.env` | curve configs Onix pays for; the locker and the migration when a vault graduates |

The server signs from five routes (creation steps, play settlement, gacha settlement, admissions, abandon) and three timers (play deliveries, the treasury loop that claims fees and buys items, expired-creation sweep). Each signing path is **build → assert shape → simulate → sign → persist → broadcast**, and the chain is read back before anything is counted.

**Trust boundaries:** the Collector Crypt API (it builds the buy transaction the custody key signs) · the DAS indexer (custody, ownership, insured value) · the vault API as seen by an integrator · the creator between submitting a launch and confirming it · anything a client sends that is stored and shown.

## Findings

Severity is the impact if exploited, before the fix. Every finding is closed except where marked.

| id | finding | sev. | fix | regression test |
|---|---|---|---|---|
| R-02 | **The custody key signed the venue's buy transaction measuring only the USDC debit.** Any extra instruction (an NFT out of custody, an approve, a close, SOL out) would have been signed. Now: only the exact shape measured on two mainnet buys (ComputeBudget · one marketplace `buy` `a9e357ff…` · the co-signer's noop), a priority-fee cap, and in simulation the custody's SOL (fee + one rent) and the item ending owned by custody. | critical | `7943f3a` | `restock.test.js` › *only the measured shape of a buy is ever signed* (6) |
| R-18 | **Overlapping play sweeps delivered two items for one payment.** The 10-second sweep had no re-entry guard and its claim did not check it changed a row; with a slow RPC the second sweep re-drew and delivered again. Now one sweep at a time, and only the sweep whose conditional claim succeeds delivers (also across two processes). Same guard on the treasury's purchase. | high | `232c3de` | `play.test.js` › *one payment, one delivery* (2) · `restock.test.js` › *one purchase at a time* |
| R-01 | **A creator could take the items back after the token was live.** `abandon` accepted a creation whose pool was on chain; the expiry sweep did the same to anyone who closed the browser before confirming; `deposited` after `submit` built a second pool on the same backing; `confirm` ran after `abandon`. Now the launch state is read from the chain (pool account, signature status, blockhash window): while live or in flight the items stay; the sweep registers a live token instead of returning its items. | high | `b916e5e` | `creation.test.js` › *once a launch is submitted, the items stay with the token* (8) |
| R-04 | **The draw's server seed sat in the database before payment.** Whoever read the database (or a backup) could predict a draw and decide whether to pay. Now each seed is `HMAC(drawKey, vault|playId)`, derived when needed; the database holds only the commitment. The public proof is unchanged. | high | `5331a24` | `play.test.js` › *the server seed is derived from a key, never stored* · `keyring.test.js` › *the draw key* |
| R-03 | **The integrator (Onix.Cards) signed the vault's payment transaction with gaps.** An extra Token-program instruction (an `Approve` of the operator's USDC) passed; the destination was checked against the `payTo` of the same response; the spend caps counted the draw price, not the price paid; a delivery counted on the API's signature alone. Now: exactly one `transferChecked` from the operator to the vault the integrator already knows, ≤1 idempotent ATA creation, one memo = reservation id; price ≤ 1.25× the draw (+$1) and inside the caps; delivered only when the chain shows the card with the winner. | high | Onix.Cards (private monorepo) `088c5f3`, deployed 4 Oct | `pullWorkerVault.test.js` (4) |
| R-12 | **Client and metadata strings reached the page as HTML.** A play's payment signature was free text rendered inside links in the public Activity; `esc` did not escape `'`; `verify.html` injected item names. Now the server accepts only addresses, base58 signatures and https images, and the page escapes every chain or client string. The CSP (`script-src 'self'`) already blocked script execution; this closes markup injection. | medium-high | `21d5dfa`, `388618f` | `inputs.test.js` (3) · per-door 400s in `play/vaultService/admissions.test.js` |
| R-19 | **Anyone could post an admission "by the creator" with any value.** `record` took owner, value and signature from the request body and showed them in the public Activity; `verifyPending` admitted on custody alone. Now an admission is admitted only when custody holds the item and the named transfer was signed by the creator; the value shown is the custodian's, read from the item, and only once admitted; anything else is rejected or expires in an hour. | medium | `21d5dfa` | `admissions.test.js` › *what the public Activity shows is read from the chain* (3) |
| R-10 | **Errors carried RPC URLs (with the API key), SQLite text and key fragments.** Node's `JSON.parse` echoes its input, so a malformed `VAULT_SECRET_KEY` could leak into a 500. Now unexpected errors answer a generic 500 with a reference; API keys are scrubbed from any message and log line; the key parser never quotes its input. | medium | `46a7902` | `errors.test.js` (4) |
| R-08 | Two simultaneous `deposited` calls made Onix pay the curve config twice. Now one step at a time per creation. | medium | `b916e5e` | `creation.test.js` › *two deposited calls at once* |
| R-09 | The gas refund in `abandon` was signed without assert or simulation. | medium | `b916e5e` | `creation.test.js` › *abandon returns the gas only after simulating* |
| R-11 | Plays and reservations were reachable through another vault's routes; an `Idempotency-Key` from another integrator returned that integrator's payment transaction. Now scoped to vault and integrator. (Memo-in-inner-instruction and cross-table replay: refuted — the payer must be the player/integrator, the memo is unique per play, `payment_sig` is UNIQUE.) | medium | `d81e8e6` | `vaultService.test.js` › *scope* (2) · `play.test.js` › *scope* |
| R-13 | Several routes that sign, settle or read the chain on demand had no rate fence; `slippageBps` had no ceiling. Now every one is fenced (build or read fence per address); a fresh stats read over the fence is served from cache; slippage 1–500 bps. | medium | `cf9e0e1`, `21d5dfa` | `app.test.js` › *fences reach every route…* · *slippageBps* |
| R-14 | Token metadata built its URLs from the `Host` header. Now from the configured public URL. | low | `cf9e0e1` | `app.test.js` › *uploads…* (Host spoof) |
| R-05 | Custody is decided by the asset's collection. Refuted for Collector Crypt (MPL Core: membership is the collection's own authority; the indexer omits unverified collections). Hardened anyway: a grouping marked `verified:false` never counts. | low | `23bd364` | `backing.test.js` › *unverified collection* |
| R-06 | No emergency stop. Now `data/PAUSE` (all vaults) or `data/PAUSE-<id|wallet>` (one vault): every value-moving route answers 503, the sweeps and the treasury loop skip; `/v1/health` says so; nothing is lost. A file, not a route: nothing to authenticate, nothing to attack. | high (ops) | `16a5617` | `pause.test.js` (5) |
| R-07a | The master seed existed only in the server's `.env`: losing the server would have lost every created vault's custody wallet. The operator made an offline backup on 4 Oct 2026 (outside any chat or repository). | high (ops) | operator action, 4 Oct | — |
| R-07b | Server hardening (`onixvault/scripts/harden-server.sh`, read-only by default, each change behind a flag). Applied 4 Oct: daily consistent DB + uploads backup (SQLite backup API, integrity-checked, 7 days, the seed excluded); the app's systemd unit sandboxed (NoNewPrivileges, PrivateTmp, ProtectSystem=full, RestrictSUIDSGID, UMask 0077 — the kernel shows NoNewPrivs on the running process); fail2ban on sshd. Report clean: only 22/80/443 public, app on loopback as its own user, `.env` 640, code not writable by the app, ssh key-only. | medium (ops) | operator action, 4 Oct | — |
| R-07 | The pre-commit hook (last door before a public repo) did not catch a master seed or 32 bytes of hex. Now it does, and the hook is itself tested against a throwaway repository. | medium | `46a7902` | `precommit.test.js` (3) |
| R-15 | Two operator scripts signed before simulating (relying on the RPC's preflight, which runs after signing); `retry-delivery` acted without `--go`. | low | `afedbfa` | — (scripts) |

## Open, with owner

| id | item | why open | owner |
|---|---|---|---|
| R-16 | A delivery is marked delivered once broadcast (after a successful simulation), not once seen on chain. A broadcast that never lands leaves the record ahead of the chain until the operator retries. Recommendation: `delivering` until the signature is seen, rebroadcast the persisted transaction inside the blockhash window, then `delivery_failed`. | state-machine change on a path in production; scheduled after the video | Onix |
| R-17 | Dependency advisories: all high ones are transitive in the Solana SDKs (`bigint-buffer` via `@solana/spl-token`; `toml` via `@coral-xyz/anchor`, only parsing `Anchor.toml`), no fix without breaking the Meteora SDKs. `@solana/web3.js` is 1.99.0 everywhere (not the compromised 1.95.6/7); the vendored browser bundle is the same version, sha256 `ecfdbe556175b8e7598c7b4189c5abd5b37858671bbb115799fa2b7c0b3715f4`. | accepted, re-checked at each deploy | Onix |
| — | Seed rotation runbook (move every item, SOL and USDC to a new derivation). Rotating the master seed also rotates the draw key: pause, let paid plays finish, then rotate — a play whose commitment no longer matches is never drawn and keeps its payment on record. | not needed before launch | Onix |
| — | Custody by a program with escrow instead of a server key; a multisig for the operator; an external audit. | roadmap | Onix |

## Repository history audit (before opening the repository)

4 October 2026, over **every blob of every one of the 122 commits** (not only the current tree) and every commit message:

- **Authors:** one identity throughout, the project's pseudonymous account.
- **Files:** no `.env`, key, keypair, database or wallet file ever committed. One blob over 500 KB (`web/token/default.png`, 1.4 MB).
- **Content:** no private key (base58 or byte array), no seed, no API key, no PEM, no server address, no local path, no personal data, no third-party names. The only 32-byte hex values are the SLIP-0010 specification's public test vectors, throwaway test seeds, and the vendored bundle's sha256; the only `api-key=` is a fake value in a test.
- **Re-run 10 October 2026** over the commits added since (130 in all), same patterns, same result: clean.
- **Going forward:** the pre-commit hook (tested, R-07) refuses the same patterns. On GitHub, enable secret scanning, push protection and Dependabot alerts, and protect `main`.

## Trust that remains by design

- **The custodian.** Insured value and the item's existence come from the custodian's on-chain metadata (Collector Crypt). A custodian that lies is outside what this server can check.
- **The operator.** Until custody moves to a program, the operator runs the server that holds the seed. Every custody address is public and every movement is on chain within one block.

## How to verify

```bash
npm ci && timeout 280 npm test                       # 237 tests
node scripts/abuse-rehearsal.js --base http://127.0.0.1:3004   # public refusals, against a local server
touch data/PAUSE                                      # every value route answers 503 within 5 s; rm to resume
```

The regression tests are written to fail on the code before each fix: check out the parent of a fix commit and run the test named in the table.
