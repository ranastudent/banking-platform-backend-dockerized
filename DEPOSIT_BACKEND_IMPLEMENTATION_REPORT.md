# Deposit Funds Backend Implementation Report

## Files updated
- `src/` — new Deposit Funds backend module, routes, controllers, services, provider adapter contract, reconciliation worker, tests, and environment examples.
- `prisma/schema.prisma` — DepositRequest, provider payment/webhook/settlement/reconciliation models, general ledger and journal models, relations and enums.
- `prisma/migrations/20261125110000_deposit_funds_core/migration.sql` — SQL migration for the new schema.

## Main backend work implemented
- Deposit eligibility, currency/account/user status validation, amount precision, minimum/maximum and per-currency daily/monthly limits.
- Fee quote with currency decimal-place rounding.
- Idempotent external deposit creation and quote/history/detail/cancel APIs.
- External payment request lifecycle; pending requests do not credit customer balance.
- Provider adapter registry with payment initiation, server-to-server payment verification, signed webhook normalization and merchant-reference recovery contract.
- Safe processing for uncertain provider initiation outcomes; no automatic retry that could create duplicate provider charges.
- Atomic verified settlement, customer balance update, customer ledger entry, transaction legs, outbox notification and audit.
- Double-entry deposit journal (settlement asset/customer liability/fee income).
- Demo Funding separated from external deposits, synthetic accounting, feature flag, limits, and production prohibition.
- Settlement records, reconciliation records, scheduled expiration/recovery/reconciliation sweep.
- Admin deposit search/detail/reconciliation/reversal endpoints.
- Legacy direct-credit account deposit route blocked in production and gated to demo mode outside tests.
- Unit/API tests added for lifecycle, fees, webhook HMAC helper, methods/limits, quote ownership, and no-credit when provider adapter is unavailable.

## Important limitations / not yet production-complete
1. **No provider-specific bKash, Nagad, Rocket, Wise, PayPal or Payoneer merchant adapter is registered.** Their APIs and signature formats differ. The adapter contract is ready, but a provider must be selected and its current merchant API docs, sandbox credentials, webhook requirements and commercial/compliance arrangement supplied before real provider payments can be enabled.
2. External deposit feature flag defaults to `false`; demo funding also defaults to `false`.
3. Provider sandbox end-to-end tests have not been executed.
4. Prisma migration has not been applied to the user's database.
5. Full TypeScript typecheck, Prisma validate/generate, and integration test suite could not be run here because dependencies were not installed and npm installation timed out. TypeScript syntax transpilation completed with no syntax errors; this is not equivalent to a full typecheck.
6. Admin reversal is an internal ledger reversal, not a provider-side refund/chargeback API.

## Apply locally
From backend project root, preserve a backup, then replace the `src/` and `prisma/` folders with the corresponding folders from the supplied archives.

Then run:
```bash
npx prisma validate
npx prisma generate
npx prisma migrate deploy
npx vitest run src/tests/deposits
```

After validation, run the existing targeted deposit/transaction tests, then the full suite.

## Environment variables
See `src/.env.example` and `src/DEPOSIT-FUNDS-BACKEND.md`. Keep:
```env
DEPOSIT_EXTERNAL_ENABLED=false
DEPOSIT_DEMO_ENABLED=false
DEPOSIT_LIMIT_TIMEZONE=Asia/Dhaka
```
until a provider adapter is implemented and sandbox-tested.


## Card and mobile payment update (2026-11-26)
- Added Stripe Checkout adapter for card payments and `STRIPE` enum migration.
- Visa/Mastercard credit/debit are supported as Stripe card types; Stripe/card issuer detects the network and card type.
- Added Stripe test/live environment variables and setup instructions in `CARD_AND_MOBILE_PAYMENT_SETUP.md`.
- Added Stripe mock provider to simulator and updated method endpoint metadata.
- Existing bKash sandbox adapter remains; Nagad/Rocket remain simulator-only until official provider sandbox contract and merchant credentials are configured.
- Backend-only source was supplied; no React/Next.js frontend source was present to update the payment UI.
