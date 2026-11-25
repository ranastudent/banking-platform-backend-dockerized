# Deposit Funds Backend Implementation

## Implemented core
- Dedicated `DepositRequest` lifecycle and provider payment records.
- Fee quote and configurable minimum, maximum, daily and monthly limits.
- Account ownership/status/currency/decimal precision validation.
- Idempotent request endpoints.
- Pending external deposits do not credit customer balance.
- Provider webhook HMAC verification against raw request bytes.
- Provider event deduplication; failed webhook events can be retried.
- Atomic deposit settlement, customer balance update, customer ledger entry and transaction legs.
- Double-entry journal with treasury settlement asset, customer deposit liability, deposit fee income, and demo funding counterpart.
- Provider settlement records, reconciliation records and worker reconciliation sweep.
- Admin deposit search/detail/reconcile/reversal endpoints.
- Demo funding is separate and disabled by default; it is forbidden in production.
- Legacy direct-credit endpoint is disabled in production and requires explicit demo enablement outside test mode.

## API (mounted under `/api/v1`)
- `GET /deposits/methods`
- `GET /deposits/limits`
- `POST /deposits/quote`
- `POST /deposits` (requires `Idempotency-Key`)
- `POST /deposits/demo` (requires `Idempotency-Key`; non-production and explicit enablement only)
- `GET /deposits`
- `GET /deposits/:depositId`
- `POST /deposits/:depositId/cancel`
- `POST /deposits/webhooks/:provider` (provider signature, no customer JWT)
- `GET /admin/deposits`
- `GET /admin/deposits/:depositId`
- `POST /admin/deposits/:depositId/reconcile`
- `POST /admin/deposits/:depositId/reverse`

## Environment
External and demo funding are fail-closed by default:
```
DEPOSIT_EXTERNAL_ENABLED=false
DEPOSIT_DEMO_ENABLED=false
DEPOSIT_MIN_AMOUNT=1
DEPOSIT_MAX_AMOUNT=100000
DEPOSIT_DAILY_LIMIT=200000
DEPOSIT_MONTHLY_LIMIT=1000000
DEPOSIT_FEE_RATE_BPS=0
DEPOSIT_FIXED_FEE=0
DEPOSIT_LIMIT_TIMEZONE=Asia/Dhaka
DEMO_FUNDING_MAX_AMOUNT=10000
```
Provider webhook secrets are injected as secrets, for example:
`DEPOSIT_PROVIDER_BKASH_WEBHOOK_SECRET`.
Never commit real credentials. Daily and monthly limit boundaries use `DEPOSIT_LIMIT_TIMEZONE` (default `Asia/Dhaka`).

## Database migration
Migration:
`prisma/migrations/20261125110000_deposit_funds_core/migration.sql`

After extracting updated Prisma files, run:
```
npx prisma validate
npx prisma generate
npx prisma migrate deploy
```

## Provider integration limitation / go-live gate
The provider registry and generic HMAC helper are implemented, but no provider-specific merchant adapter has been registered. Each adapter must implement `createPayment` (idempotent on the merchant reference), `verifyPayment` (server-to-server provider API verification), `lookupPaymentByMerchantReference` (recovery after an uncertain initiation), and its exact `parseAndVerifyWebhook` signature/canonicalization. bKash, Nagad, Rocket, Wise, PayPal and Payoneer each have their own API, credential, signature, redirect and settlement requirements. Do not enable `DEPOSIT_EXTERNAL_ENABLED` until the contracted provider's current sandbox/API documentation, merchant credentials, callback requirements, and compliance approval are available and its adapter + sandbox tests are completed. Each adapter's `parseAndVerifyWebhook` maps its signed callback into normalized `eventId`, `eventType`, `providerPaymentId`, and `merchantReference` (DepositRequest UUID). `verifyPayment` must query the provider server-to-server and return authoritative payment status, amount, currency, and merchant reference. Never trust client redirects or callback payload alone.

## Accounting behavior
External verified deposit:
- Debit `SETTLEMENT_ASSET` by gross amount.
- Credit `CUSTOMER_DEPOSIT_LIABILITY` by net amount.
- Credit `DEPOSIT_FEE_INCOME` by fee, when fee > 0.

Demo funding:
- Debit `DEMO_FUNDING_EXPENSE` (synthetic counter-account).
- Credit `CUSTOMER_DEPOSIT_LIABILITY`.
Demo funding is synthetic and does not represent cash or real treasury reserves.

Reversal:
- Debits customer deposit liability and credits settlement asset (or demo counterpart for demo funding).
- Reversal is blocked if available customer balance is insufficient.
- The current admin reversal is an internal ledger reversal, not a provider-side refund/chargeback. A provider refund API and refund settlement workflow must be added before representing it as money returned to the external wallet.

## Important deployment note
The migration was authored to match the updated schema, but must be validated and applied against the project's actual test database before production. The files were statically reviewed in this working environment; provider-specific external payment flows and live sandbox settlement have not been executed.
