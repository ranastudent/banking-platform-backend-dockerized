# Free virtual payment simulator update

## Development mode (default in the provided environment example)
- `PAYMENT_PROVIDER_MODE=mock`
- `PAYMENT_SIMULATOR_ENABLED=true`
- `DEPOSIT_EXTERNAL_ENABLED=true`
- `NODE_ENV` must not be `production`

All four providers (BKASH, NAGAD, ROCKET, WISE) register synthetic mock adapters. Creating a deposit creates a virtual pending payment; it does not contact any provider and does not move money.

### Simulate incoming wallet -> platform deposit
1. Create deposit with existing `POST /api/v1/deposits` for a provider and account.
2. Complete it with:
   `POST /api/v1/deposits/simulator/:provider/:depositId/complete`
   JSON: `{ "outcome": "success" }` (also supports `failed` or `cancelled`).
3. The successful simulation settles through the same verified-deposit ledger path. Repeat calls are idempotent and do not credit twice.

### Simulate platform -> provider wallet payout
Use:
`POST /api/v1/deposits/simulator/payout/:accountId`
Headers: authenticated bearer token and `Idempotency-Key`.
JSON example:
`{ "provider": "BKASH", "recipientWallet": "TEST-BKASH-USER-001", "amount": "100", "currency": "BDT" }`

This calls the existing account withdrawal debit/ledger flow and records synthetic payout metadata. Only TEST-prefixed recipient identifiers are accepted. It does not credit a real wallet.

## Important limitations
- This is a local development simulator, not a bKash/Nagad/Rocket/Wise sandbox or production integration.
- It cannot simulate actual mobile wallet balances, external settlement, bank network, real fees, or real provider callbacks.
- bKash Checkout/Tokenized Checkout, Nagad, Rocket and Wise live/sandbox adapters must be separately enabled and tested using the official provider contract and credentials.
- `PAYMENT_PROVIDER_MODE=mock` must never be used in production. The code rejects simulator endpoints in production.
- Do not use real recipient phone/account numbers in simulator requests.
- Build, Prisma validation, migration, and automated test suite were not run in this environment; run locally before relying on the patch.
