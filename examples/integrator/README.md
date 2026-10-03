# Integrating a gacha with Onix.Vault

Three calls. You never assemble a transaction by hand, and the vault never touches your player's money.

1. `GET /v1/vaults/{vault}/items` — what is in the vault, with the published exit price.
2. `POST /v1/vaults/{vault}/reservations` `{ mint, integrator, winner }` — **only after your player paid you.**
   The response carries `paymentTransaction`: a base64, unsigned transaction that pays the frozen price in
   USDC from `integrator` to the vault, with the reservation id as memo. Sign it with `integrator`, send it,
   keep the signature. Use `Idempotency-Key` so a retry cannot reserve twice.
3. `POST /v1/vaults/{vault}/reservations/{id}/settle` `{ paymentSignature }` — the vault reads your payment
   from the chain (finalized, amount, memo) and delivers the item to `winner`. `409` means "not finalized yet,
   retry"; `402` means the payment does not cover the price; `410` means your reservation expired.

`vaultClient.js` is the whole client. It is the one Onix.Cards' gacha runs in production.

**Every vault, no address to configure:** `listVaults({ baseUrl })` returns each vault with `graduated` — only graduated
vaults sell (before that the reservation is a 409). Read each one's items, mark each item with its vault, and reserve and
settle on the vault that holds the item. That is how Onix.Cards runs its Vaults category.

Reservations are short (minutes). Let three expire without settling and the vault stops taking yours.
The exit price is `max(custodian value, market reference)` and is the same for everyone.
